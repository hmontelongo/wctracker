import { existsSync, readFileSync } from 'node:fs';
import { CdpConnection, sleep } from './cdp.mjs';
import { writeJson } from './files.mjs';
import {
  persistCycleToSqlite,
  readPreviousStateFromSqlite,
  stateFromCycle,
} from './sqlite-store.mjs';
import {
  DEFAULT_SHOP_URL,
  buildDiscoveredTarget,
  loungeUrl as buildLoungeUrl,
  matchCodeFromText,
  normalizeAvailability,
  normalizeSpace,
  parseJsonMaybe,
  sha256,
} from './fifa.mjs';
import { buildBrowserUrl, redactZenRowsUrl } from './zenrows.mjs';

export const DEFAULT_STATE_PATH = 'artifacts/fifa-ticket-state.json';
export const DEFAULT_LATEST_CYCLE_PATH = 'artifacts/fifa-cycle-latest.json';

export function configFromEnv(apiKey, overrides = {}) {
  const shopUrl = overrides.shopUrl || process.env.FIFA_SHOP_URL || DEFAULT_SHOP_URL;
  const visitorCountry = overrides.visitorCountry || process.env.FIFA_VISITOR_COUNTRY || 'Mexico';
  const intervalMs = Number(overrides.intervalMs || process.env.FIFA_POLL_INTERVAL_MS || 60000);
  const maxTicks = Number(overrides.maxTicks ?? process.env.FIFA_TICKER_MAX_TICKS ?? 0);
  const matchConcurrency = Math.max(1, Number(overrides.matchConcurrency || process.env.FIFA_MATCH_CONCURRENCY || 3));
  const discoveryAttempts = Math.max(1, Number(overrides.discoveryAttempts || process.env.FIFA_DISCOVERY_ATTEMPTS || 3));
  const fastPollEnabled = String(overrides.fastPollEnabled ?? process.env.FIFA_FAST_POLL_ENABLED ?? '1') !== '0';
  const fullDiscoveryEvery = Math.max(0, Number(overrides.fullDiscoveryEvery ?? process.env.FIFA_FULL_DISCOVERY_EVERY ?? 10));
  const fastFetchConcurrency = Math.max(1, Number(overrides.fastFetchConcurrency || process.env.FIFA_FAST_FETCH_CONCURRENCY || matchConcurrency));
  const alertRetentionMs = Math.max(0, Number(overrides.alertRetentionMs ?? process.env.FIFA_ALERT_RETENTION_MS ?? 10 * 60 * 1000));
  const matchJobAttempts = Math.max(1, Number(overrides.matchJobAttempts ?? process.env.FIFA_MATCH_JOB_ATTEMPTS ?? 2));
  const statePath = overrides.statePath || process.env.FIFA_STATE_PATH || DEFAULT_STATE_PATH;
  const latestCyclePath = overrides.latestCyclePath || process.env.FIFA_LATEST_CYCLE_PATH || DEFAULT_LATEST_CYCLE_PATH;
  const browserUrl = buildBrowserUrl(apiKey, {
    proxy_region: overrides.proxyRegion || process.env.ZENROWS_BROWSER_PROXY_REGION,
    proxy_country: overrides.proxyCountry || process.env.ZENROWS_BROWSER_PROXY_COUNTRY,
    session_ttl: overrides.sessionTtl || process.env.ZENROWS_BROWSER_SESSION_TTL,
  });

  return {
    apiKey,
    shopUrl,
    visitorCountry,
    intervalMs,
    maxTicks,
    matchConcurrency,
    discoveryAttempts,
    fastPollEnabled,
    fullDiscoveryEvery,
    fastFetchConcurrency,
    alertRetentionMs,
    matchJobAttempts,
    statePath,
    latestCyclePath,
    browserUrl,
    publicBrowserUrl: redactZenRowsUrl(browserUrl),
  };
}

export function loadPreviousState(path = DEFAULT_STATE_PATH) {
  try {
    const sqliteState = readPreviousStateFromSqlite();

    if (sqliteState) {
      return sqliteState;
    }
  } catch {
    // Fall back to JSON artifacts while SQLite is being initialized.
  }

  if (!existsSync(path)) {
    return null;
  }

  return JSON.parse(readFileSync(path, 'utf8'));
}

export function cycleArtifactPath(cycleStartedAt) {
  return `artifacts/fifa-cycles/${cycleStartedAt.replace(/[:.]/g, '-')}.json`;
}

export async function evaluate(cdp, sessionId, expression, timeoutMs = 45000) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId, timeoutMs);

  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description
        || result.exceptionDetails.exception?.value
        || result.exceptionDetails.text
        || 'Runtime.evaluate failed',
    );
  }

  return result.result?.value;
}

function createCaptureBucket() {
  const captures = [];
  const waiters = new Set();

  Object.defineProperties(captures, {
    pushCapture: {
      enumerable: false,
      value(capture) {
        captures.push(capture);

        for (const waiter of [...waiters]) {
          if (waiter.predicate(capture)) {
            clearTimeout(waiter.timeout);
            waiters.delete(waiter);
            waiter.resolve(capture);
          }
        }
      },
    },
    waitFor: {
      enumerable: false,
      value(predicate, timeoutMs) {
        const existing = captures.find(predicate);

        if (existing) {
          return Promise.resolve(existing);
        }

        return new Promise((resolve) => {
          const waiter = {
            predicate,
            resolve,
            timeout: setTimeout(() => {
              waiters.delete(waiter);
              resolve(null);
            }, timeoutMs),
          };
          waiters.add(waiter);
        });
      },
    },
  });

  return captures;
}

function installNetworkCapture(cdp, sessionId, bucket) {
  const requests = new Map();

  cdp.onMessage((message) => {
    if (message.sessionId !== sessionId) {
      return;
    }

    if (message.method === 'Network.responseReceived') {
      const { requestId, response } = message.params;

      if (response?.url?.includes('/next-api/lounges')) {
        requests.set(requestId, {
          url: response.url,
          status: response.status,
          ok: response.status >= 200 && response.status < 300,
          finalUrl: response.url,
          capturedAt: new Date().toISOString(),
          source: 'cdp-network',
        });
      }
    }

    if (message.method === 'Network.loadingFinished' && requests.has(message.params.requestId)) {
      const request = requests.get(message.params.requestId);
      requests.delete(message.params.requestId);

      cdp.send('Network.getResponseBody', { requestId: message.params.requestId }, sessionId)
        .then((result) => {
          bucket.pushCapture({
            ...request,
            body: result.base64Encoded
              ? Buffer.from(result.body, 'base64').toString('utf8')
              : result.body,
          });
        })
        .catch((error) => {
          bucket.pushCapture({
            ...request,
            body: '',
            error: error.message,
          });
        });
    }
  });
}

async function createBrowserSession(config) {
  const cdp = new CdpConnection(config.browserUrl.toString());
  await cdp.connect();
  const createdTarget = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const attachedTarget = await cdp.send('Target.attachToTarget', {
    targetId: createdTarget.targetId,
    flatten: true,
  });
  const { sessionId } = attachedTarget;
  const networkCaptures = createCaptureBucket();

  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);
  await cdp.send('Network.setBlockedURLs', {
    urls: [
      '*.avif',
      '*.gif',
      '*.jpeg',
      '*.jpg',
      '*.mp4',
      '*.otf',
      '*.png',
      '*.ttf',
      '*.webm',
      '*.webp',
      '*.woff',
      '*.woff2',
    ],
  }, sessionId).catch(() => {});
  installNetworkCapture(cdp, sessionId, networkCaptures);

  return {
    cdp,
    sessionId,
    targetId: createdTarget.targetId,
    networkCaptures,
    async close() {
      await cdp.send('Target.closeTarget', { targetId: createdTarget.targetId }, undefined, 2000).catch(() => {});
      cdp.close();
    },
  };
}

async function waitForDocumentReady(cdp, sessionId) {
  return evaluate(cdp, sessionId, `
    (() => new Promise((resolve) => {
      if (document.readyState !== 'loading') {
        resolve({ readyState: document.readyState });
        return;
      }

      document.addEventListener('DOMContentLoaded', () => {
        resolve({ readyState: document.readyState });
      }, { once: true });

      setTimeout(() => {
        resolve({ readyState: document.readyState, timedOut: true });
      }, 12000);
    }))()
  `, 15000);
}

export async function openShopAndChooseCountry(cdp, sessionId, config, emit = () => {}) {
  emit({ event: 'shop_navigation_started', url: config.shopUrl });
  const loaded = cdp.waitFor('Page.loadEventFired', sessionId, 8000).catch((error) => ({
    timeout: error.message,
  }));
  const navigated = cdp.send('Page.navigate', { url: config.shopUrl }, sessionId, 15000).catch((error) => ({
    timeout: error.message,
  }));
  const [navigationState, loadState] = await Promise.all([navigated, loaded]);
  const documentState = await waitForDocumentReady(cdp, sessionId);
  emit({ event: 'shop_document_ready', documentState, loadState, navigationState });

  const state = await evaluate(cdp, sessionId, `
    (() => {
      const country = ${JSON.stringify(config.visitorCountry)};
      const text = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
      document.getElementById('onetrust-accept-btn-handler')?.click();
      const candidates = [...document.querySelectorAll('button, [role="button"], a')];
      const countryButton = candidates.find((el) => text(el).toLowerCase() === country.toLowerCase())
        || candidates.find((el) => text(el).toLowerCase().includes(country.toLowerCase()));
      countryButton?.click();

      return {
        selectedShopCountryClicked: Boolean(countryButton),
        url: location.href,
        title: document.title,
        textPreview: text(document.body).slice(0, 1200)
      };
    })()
  `);
  emit({
    event: 'country_selection_checked',
    country: config.visitorCountry,
    selectedShopCountryClicked: state.selectedShopCountryClicked,
    url: state.url,
  });

  if (/proxy connection attempt timed out|connection attempt timed out/i.test(state.textPreview)) {
    return {
      ...state,
      documentState,
      readiness: {
        ready: false,
        cardCount: 0,
        source: 'proxy-timeout-page',
        textPreview: state.textPreview,
      },
    };
  }

  emit({ event: 'match_card_wait_started' });
  let readiness = await waitForMatchCards(cdp, sessionId).catch((error) => ({
    ready: false,
    cardCount: 0,
    source: 'wait-error',
    error: error.message,
  }));

  if (!readiness.ready) {
    emit({
      event: 'match_card_wait_empty',
      textPreview: readiness.textPreview,
      error: readiness.error,
    });
    await evaluate(cdp, sessionId, `
      (() => {
        const text = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
        const candidates = [...document.querySelectorAll('button, [role="button"], a, [tabindex]')];
        const browse = candidates.find((el) => /^browse matches$/i.test(text(el)))
          || candidates.find((el) => /browse matches/i.test(text(el)))
          || candidates.find((el) => /choose-matches/i.test(el.getAttribute('href') || ''));
        browse?.click();
        window.scrollTo(0, 0);
        return Boolean(browse);
      })()
    `).catch(() => false);
    readiness = await waitForMatchCards(cdp, sessionId).catch((error) => ({
      ready: false,
      cardCount: 0,
      source: 'wait-error',
      error: error.message,
    }));
  }
  emit({
    event: readiness.ready ? 'match_cards_ready' : 'match_cards_missing',
    cardCount: readiness.cardCount,
    textPreview: readiness.textPreview,
    error: readiness.error,
  });

  return {
    ...state,
    documentState,
    readiness,
  };
}

async function waitForMatchCards(cdp, sessionId, timeoutMs = 18000) {
  return evaluate(cdp, sessionId, `
    (() => new Promise((resolve) => {
      const text = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
      const cardSelector = 'button.match, button[class*="match"]';
      const readCards = () => [...document.querySelectorAll(cardSelector)]
        .filter((el) => /\\bM\\d+\\b/i.test(text(el)));
      const cards = readCards();

      if (cards.length > 0) {
        resolve({ ready: true, cardCount: cards.length, source: 'initial-dom' });
        return;
      }

      const root = document.documentElement || document.body;

      if (!root) {
        resolve({
          ready: false,
          cardCount: 0,
          source: 'missing-document-root',
          textPreview: ''
        });
        return;
      }

      const observer = new MutationObserver(() => {
        const nextCards = readCards();
        if (nextCards.length > 0) {
          observer.disconnect();
          clearTimeout(timeout);
          resolve({ ready: true, cardCount: nextCards.length, source: 'mutation-observer' });
        }
      });
      observer.observe(root, { childList: true, subtree: true });

      const timeout = setTimeout(() => {
        observer.disconnect();
        resolve({
          ready: false,
          cardCount: 0,
          source: 'timeout-guard',
          textPreview: text(document.body).slice(0, 1200)
        });
      }, ${JSON.stringify(timeoutMs)});
    }))()
  `, timeoutMs + 7000);
}

async function collectPageDataLayer(cdp, sessionId) {
  return evaluate(cdp, sessionId, `
    (() => {
      const nextData = document.getElementById('__NEXT_DATA__')?.textContent || null;
      const jsonScripts = [...document.querySelectorAll('script[type="application/json"]')]
        .map((script) => ({
          id: script.id || null,
          length: script.textContent?.length || 0,
          preview: (script.textContent || '').slice(0, 200)
        }))
        .slice(0, 20);
      const resourceUrls = performance.getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((name) => /next-api|_next|lounges|matches/i.test(name))
        .slice(0, 80);

      return {
        nextDataBytes: nextData ? nextData.length : 0,
        nextDataPreview: nextData ? nextData.slice(0, 300) : null,
        jsonScripts,
        resourceUrls
      };
    })()
  `).catch((error) => ({ error: error.message }));
}

export async function collectMatchCards(cdp, sessionId) {
  return evaluate(cdp, sessionId, `
    (async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const text = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
      let lastCount = 0;
      let stableRounds = 0;

      for (let i = 0; i < 12; i += 1) {
        const cards = [...document.querySelectorAll('button.match, button[class*="match"]')]
          .filter((el) => /\\bM\\d+\\b/i.test(text(el)));

        if (cards.length === lastCount) {
          stableRounds += 1;
        } else {
          lastCount = cards.length;
          stableRounds = 0;
        }

        window.scrollTo(0, document.body.scrollHeight);
        await sleep(250);

        if (stableRounds >= 2) {
          break;
        }
      }

      const cards = [...document.querySelectorAll('button.match, button[class*="match"]')]
        .filter((el) => /\\bM\\d+\\b/i.test(text(el)));

      return cards.map((el, index) => {
        const cardText = text(el);
        return {
          index,
          text: cardText,
          matchCode: cardText.match(/\\bM\\d+\\b/i)?.[0]?.toUpperCase() || null,
          isOtherCountryShop: /must be purchased in the .* ticket shop/i.test(cardText),
          isCurrentlyUnavailableOnCard: /currently unavailable/i.test(cardText),
          isDisabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
          attributes: Object.fromEntries([...el.attributes].map((attr) => [attr.name, attr.value]))
        };
      });
    })()
  `, 60000);
}

export function selectableCards(cards) {
  return cards.filter((card) => (
    !card.isOtherCountryShop &&
    !card.isCurrentlyUnavailableOnCard &&
    !card.isDisabled
  ));
}

async function clickMatchCard(cdp, sessionId, card) {
  return evaluate(cdp, sessionId, `
    (() => {
      const wantedCode = ${JSON.stringify(card.matchCode)};
      const wantedText = ${JSON.stringify(normalizeSpace(card.text))};
      const text = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
      const cards = [...document.querySelectorAll('button.match, button[class*="match"]')]
        .filter((el) => /\\bM\\d+\\b/i.test(text(el)));
      const match = cards.find((el) => wantedCode && text(el).includes(wantedCode))
        || cards.find((el) => text(el) === wantedText);

      if (!match) {
        return { clicked: false, reason: 'match_card_not_found', cardCount: cards.length };
      }

      match.scrollIntoView({ block: 'center' });
      match.click();
      return { clicked: true, text: text(match), cardCount: cards.length };
    })()
  `);
}

async function waitForLoungeCapture(bucket, minCapturedAtMs, timeoutMs = 15000) {
  const isFreshLounge = (capture) => (
    capture.url?.includes('/next-api/lounges') &&
    Date.parse(capture.capturedAt || '') >= minCapturedAtMs
  );
  const isSuccessfulFreshLounge = (capture) => (
    isFreshLounge(capture) &&
    capture.status >= 200 &&
    capture.status < 300
  );

  const existingSuccess = bucket.find(isSuccessfulFreshLounge);

  if (existingSuccess) {
    return existingSuccess;
  }

  const freshSuccess = await bucket.waitFor(isSuccessfulFreshLounge, timeoutMs);

  return freshSuccess
    || bucket.find(isSuccessfulFreshLounge)
    || bucket.find(isFreshLounge)
    || null;
}

async function ensureMatchList(session, config, emit = () => {}) {
  const current = await evaluate(session.cdp, session.sessionId, `
    (() => {
      const text = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
      const cardCount = [...document.querySelectorAll('button.match, button[class*="match"]')]
        .filter((el) => /\\bM\\d+\\b/i.test(text(el))).length;
      return { cardCount, url: location.href };
    })()
  `).catch((error) => ({ cardCount: 0, error: error.message }));

  if (current.cardCount > 0) {
    return current;
  }

  emit({ event: 'match_list_return_started', url: current.url, error: current.error });
  await evaluate(session.cdp, session.sessionId, `
    (() => {
      const text = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
      const candidates = [...document.querySelectorAll('button, [role="button"], a')];
      const back = candidates.find((el) => /^(back|volver|atras|regresar)$/i.test(text(el)))
        || candidates.find((el) => /back|volver|atras|regresar/i.test(el.getAttribute('aria-label') || ''));

      if (back) {
        back.click();
        return { method: 'button' };
      }

      history.back();
      return { method: 'history' };
    })()
  `).catch(() => null);

  const readiness = await waitForMatchCards(session.cdp, session.sessionId, 4500);

  if (readiness.ready) {
    emit({ event: 'match_list_returned', cardCount: readiness.cardCount, source: readiness.source });
    return readiness;
  }

  emit({ event: 'match_list_reload_started', reason: readiness.source });
  return openShopAndChooseCountry(session.cdp, session.sessionId, config, emit);
}

export async function discoverMatchJobs(config, emit = () => {}) {
  const session = await createBrowserSession(config);

  try {
    emit({ event: 'coordinator_started', country: config.visitorCountry });
    let initialState = null;
    let allCards = [];
    let dataLayer = null;

    for (let attempt = 1; attempt <= config.discoveryAttempts; attempt += 1) {
      emit({
        event: 'coordinator_attempt_started',
        attempt,
        attempts: config.discoveryAttempts,
      });
      initialState = await openShopAndChooseCountry(session.cdp, session.sessionId, config, emit);
      dataLayer = await collectPageDataLayer(session.cdp, session.sessionId);
      emit({
        event: 'page_data_layer_checked',
        nextDataBytes: dataLayer.nextDataBytes,
        jsonScriptCount: dataLayer.jsonScripts?.length ?? 0,
        resourceUrlCount: dataLayer.resourceUrls?.length ?? 0,
      });
      allCards = await collectMatchCards(session.cdp, session.sessionId);

      if (allCards.length > 0) {
        break;
      }

      emit({
        event: 'coordinator_attempt_empty',
        attempt,
        textPreview: initialState?.readiness?.textPreview,
      });
    }

    if (allCards.length === 0) {
      const error = new Error('No match cards discovered after retries.');
      error.initialState = initialState;
      error.dataLayer = dataLayer;
      throw error;
    }

    const jobs = selectableCards(allCards);

    emit({
      event: 'coordinator_completed',
      cardsFound: allCards.length,
      jobsCreated: jobs.length,
    });

    return {
      initialState,
      dataLayer,
      allCards,
      jobs,
    };
  } finally {
    await session.close();
  }
}

async function runMatchJobInSession(config, session, card, emit = () => {}) {
  const checkedAt = new Date().toISOString();

  emit({ event: 'match_job_started', matchCode: card.matchCode });

  await ensureMatchList(session, config, emit);
  session.networkCaptures.length = 0;

  const clickedAtMs = Date.now();
  emit({ event: 'match_card_click_started', matchCode: card.matchCode });
  const clicked = await clickMatchCard(session.cdp, session.sessionId, card);

  if (!clicked.clicked) {
    return {
      checkedAt,
      card,
      ok: false,
      error: clicked.reason,
      response: null,
      target: null,
      availability: null,
      rawTicketTypes: null,
    };
  }

  emit({ event: 'lounge_json_wait_started', matchCode: card.matchCode });
  const capture = await waitForLoungeCapture(session.networkCaptures, clickedAtMs);

  if (!capture) {
    const pageState = await evaluate(session.cdp, session.sessionId, `
      (() => ({
        url: location.href,
        title: document.title,
        textPreview: (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 1500)
      }))()
    `).catch((error) => ({ error: error.message }));

    return {
      checkedAt,
      card,
      ok: false,
      error: 'lounge_response_not_captured',
      response: null,
      target: null,
      availability: null,
      rawTicketTypes: null,
      pageState,
    };
  }

  const rawTicketTypes = parseJsonMaybe(capture.body);
  emit({
    event: 'lounge_json_captured',
    matchCode: card.matchCode,
    status: capture.status,
    bodyBytes: Buffer.byteLength(capture.body || ''),
  });
  const target = buildDiscoveredTarget({
    card: {
      ...card,
      text: normalizeSpace(card.text),
      matchCode: card.matchCode ?? matchCodeFromText(card.text),
    },
    loungeResponse: capture,
    shopUrl: config.shopUrl,
  });
  const availability = Array.isArray(rawTicketTypes)
    ? normalizeAvailability(rawTicketTypes, target)
    : null;

  return {
    checkedAt: new Date().toISOString(),
    card,
    ok: Boolean(capture.ok && availability),
    error: capture.error,
    response: {
      url: capture.url,
      status: capture.status,
      ok: capture.ok,
      bodyBytes: Buffer.byteLength(capture.body || ''),
      bodyHash: sha256(capture.body || ''),
      capturedAt: capture.capturedAt,
      source: capture.source,
    },
    target,
    availability,
    rawTicketTypes,
  };
}

export async function runMatchJob(config, card, emit = () => {}) {
  const session = await createBrowserSession(config);

  try {
    await openShopAndChooseCountry(session.cdp, session.sessionId, config, emit);
    return runMatchJobInSession(config, session, card, emit);
  } finally {
    await session.close();
    emit({ event: 'match_job_finished', matchCode: card.matchCode });
  }
}

function isRetryableMatchResult(result) {
  if (result?.ok) {
    return false;
  }

  return /Inspected target navigated or closed|timed out waiting for CDP response|lounge_response_not_captured|match_card_not_found|not of type 'Node'/i
    .test(result?.error || '');
}

async function runMatchJobWithRetries(config, session, card, emit = () => {}) {
  let result = null;

  for (let attempt = 1; attempt <= config.matchJobAttempts; attempt += 1) {
    if (attempt > 1) {
      emit({
        event: 'match_job_retry_started',
        matchCode: card.matchCode,
        attempt,
        attempts: config.matchJobAttempts,
        previousError: result?.error,
      });
    }

    result = await runMatchJobInSession(config, session, card, emit);

    if (!isRetryableMatchResult(result) || attempt >= config.matchJobAttempts) {
      return {
        ...result,
        attempts: attempt,
      };
    }

    emit({
      event: 'match_job_retry_scheduled',
      matchCode: card.matchCode,
      attempt,
      attempts: config.matchJobAttempts,
      error: result.error,
    });
  }

  return result;
}

export async function runMatchJobsInPool(config, cards, emit = () => {}) {
  if (cards.length === 0) {
    return [];
  }

  const results = new Array(cards.length);
  const workerCount = Math.min(config.matchConcurrency, cards.length);
  let nextIndex = 0;

  async function runWorker(workerIndex) {
    let session = null;

    try {
      session = await createBrowserSession(config);
      emit({
        event: 'match_worker_started',
        workerIndex: workerIndex + 1,
        totalWorkers: workerCount,
      });
      await openShopAndChooseCountry(session.cdp, session.sessionId, config, emit);

      while (nextIndex < cards.length) {
        const index = nextIndex;
        nextIndex += 1;
        const card = cards[index];

        emit({
          event: 'match_job_queued',
          matchCode: card.matchCode,
          index: index + 1,
          total: cards.length,
          workerIndex: workerIndex + 1,
        });
        let result;

        try {
          result = await runMatchJobWithRetries(config, session, card, emit);
        } catch (error) {
          result = {
            checkedAt: new Date().toISOString(),
            card,
            ok: false,
            error: error.message,
            response: null,
            target: null,
            availability: null,
            rawTicketTypes: null,
          };
        }

        results[index] = result;
        emit({
          event: 'match_job_result',
          matchCode: card.matchCode,
          ok: result.ok,
          rows: result.availability?.rowCount ?? 0,
          availableRows: result.availability?.availableRows?.length ?? 0,
          attempts: result.attempts ?? 1,
          error: result.error,
          workerIndex: workerIndex + 1,
        });
        emit({ event: 'match_job_finished', matchCode: card.matchCode, workerIndex: workerIndex + 1 });
      }
    } catch (error) {
      emit({
        event: 'match_worker_failed',
        workerIndex: workerIndex + 1,
        error: error.message,
      });
    } finally {
      await session?.close();
      emit({
        event: 'match_worker_finished',
        workerIndex: workerIndex + 1,
      });
    }
  }

  await Promise.all(Array.from({ length: workerCount }, (_, index) => runWorker(index)));

  for (let index = 0; index < results.length; index += 1) {
    if (!results[index]) {
      results[index] = {
        checkedAt: new Date().toISOString(),
        card: cards[index],
        ok: false,
        error: 'not_processed_by_worker',
        response: null,
        target: null,
        availability: null,
        rawTicketTypes: null,
      };
    }
  }

  return results;
}

async function fetchKnownTargetsInPage(cdp, sessionId, targets, concurrency) {
  return evaluate(cdp, sessionId, `
    (async () => {
      const targets = ${JSON.stringify(targets)};
      const concurrency = ${JSON.stringify(concurrency)};
      const results = new Array(targets.length);
      let nextIndex = 0;

      async function runWorker() {
        while (nextIndex < targets.length) {
          const index = nextIndex;
          nextIndex += 1;
          const target = targets[index];
          const startedAt = Date.now();

          try {
            const response = await fetch(target.loungeUrl, {
              credentials: 'include',
              headers: {
                accept: 'application/json, text/plain, */*'
              }
            });
            const body = await response.text();
            results[index] = {
              target,
              ok: response.ok,
              status: response.status,
              body,
              bodyBytes: body.length,
              durationMs: Date.now() - startedAt,
              capturedAt: new Date().toISOString(),
              source: 'browser-page-fetch'
            };
          } catch (error) {
            results[index] = {
              target,
              ok: false,
              status: 0,
              body: '',
              error: error.message,
              durationMs: Date.now() - startedAt,
              capturedAt: new Date().toISOString(),
              source: 'browser-page-fetch'
            };
          }
        }
      }

      await Promise.all(Array.from({ length: Math.min(concurrency, targets.length || 1) }, () => runWorker()));
      return results;
    })()
  `, 60000);
}

export async function runFifaFastCycle(config, previousState = null, emit = () => {}) {
  const cycleStartedAt = new Date().toISOString();
  const knownTargets = knownTargetsFromPreviousState(previousState, config.shopUrl);

  if (knownTargets.length === 0) {
    throw new Error('No known FIFA lounge targets available for fast polling.');
  }

  emit({
    event: 'fast_cycle_started',
    cycleStartedAt,
    targetCount: knownTargets.length,
    fastFetchConcurrency: config.fastFetchConcurrency,
  });

  const session = await createBrowserSession(config);
  let initialState = null;

  try {
    initialState = await openShopAndChooseCountry(session.cdp, session.sessionId, config, emit);
    emit({ event: 'fast_targets_fetch_started', targetCount: knownTargets.length });
    const captures = await fetchKnownTargetsInPage(
      session.cdp,
      session.sessionId,
      knownTargets,
      config.fastFetchConcurrency,
    );
    const matchResults = captures.map((capture) => {
      const rawTicketTypes = parseJsonMaybe(capture.body);
      const availability = Array.isArray(rawTicketTypes)
        ? normalizeAvailability(rawTicketTypes, capture.target)
        : null;
      const ok = Boolean(capture.ok && availability);

      emit({
        event: 'fast_target_result',
        matchCode: capture.target.matchCode,
        ok,
        status: capture.status,
        rows: availability?.rowCount ?? 0,
        availableRows: availability?.availableRows?.length ?? 0,
        durationMs: capture.durationMs,
        error: capture.error,
      });

      return {
        checkedAt: capture.capturedAt,
        card: {
          matchCode: capture.target.matchCode,
          text: capture.target.sourceCardText || capture.target.teams || capture.target.matchCode,
        },
        ok,
        error: capture.error || (ok ? null : `HTTP ${capture.status}`),
        response: {
          url: capture.target.loungeUrl,
          status: capture.status,
          ok: capture.ok,
          bodyBytes: Buffer.byteLength(capture.body || ''),
          bodyHash: sha256(capture.body || ''),
          capturedAt: capture.capturedAt,
          source: capture.source,
          durationMs: capture.durationMs,
        },
        target: capture.target,
        availability,
        rawTicketTypes,
      };
    });
    const cycleCompletedAt = new Date().toISOString();
    const failedMatchCount = matchResults.filter((result) => !result?.ok).length;
    const refreshedRows = enrichRowsWithFreshness(
      previousState,
      flattenRows(matchResults, cycleCompletedAt),
      cycleCompletedAt,
    );
    const rows = failedMatchCount > 0
      ? mergeRowsForPartialCycle(previousState, refreshedRows, cycleCompletedAt)
      : refreshedRows;
    const availableRows = rows.filter((row) => row.available);
    const alerts = activeAlertRows(rows, config.alertRetentionMs, cycleCompletedAt);
    const cycle = {
      tick: previousState?.lastCycleSummary?.tick ? previousState.lastCycleSummary.tick + 1 : 1,
      cycleStartedAt,
      cycleCompletedAt,
      partial: failedMatchCount > 0,
      mode: 'fast-target-poll',
      transport: 'ZenRows Scraping Browser page fetch',
      endpoint: config.publicBrowserUrl,
      shopUrl: config.shopUrl,
      visitorCountry: config.visitorCountry,
      matchConcurrency: config.matchConcurrency,
      fastFetchConcurrency: config.fastFetchConcurrency,
      alertRetentionMs: config.alertRetentionMs,
      initialState,
      matchCardsFound: knownTargets.length,
      matchCardsScanned: knownTargets.length,
      skippedCards: [],
      matches: matchResults,
      failedMatchCount,
      knownTargets,
      rowCount: rows.length,
      availableRowCount: availableRows.length,
      rows,
      availableRows,
      alerts,
    };

    emit({
      event: 'cycle_completed',
      cycleStartedAt,
      cycleCompletedAt: cycle.cycleCompletedAt,
      mode: cycle.mode,
      matchCardsFound: cycle.matchCardsFound,
      matchCardsScanned: cycle.matchCardsScanned,
      failedMatchCount: cycle.failedMatchCount,
      partial: cycle.partial,
      rowCount: cycle.rowCount,
      availableRowCount: cycle.availableRowCount,
      alertCount: cycle.alerts.length,
    });

    return cycle;
  } finally {
    await session.close();
  }
}

export async function runParallel(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length || 1) },
    () => runWorker(),
  );

  await Promise.all(workers);

  return results;
}

function rowKey(row) {
  return [
    row.matchCode,
    row.performanceId,
    row.loungeId,
    row.seatingCode,
    row.priceMxn,
  ].join('|');
}

function targetKey(target) {
  return [
    target.matchCode,
    target.performanceId,
    target.productCode,
    target.productTypeCode,
    target.quantity ?? 1,
  ].join('|');
}

function normalizeKnownTarget(target, shopUrl) {
  if (!target?.performanceId || !target?.productCode || !target?.productTypeCode) {
    return null;
  }

  const normalized = {
    matchCode: target.matchCode ?? null,
    teams: target.teams ?? null,
    venue: target.venue ?? null,
    city: target.city ?? null,
    country: target.country ?? null,
    matchDate: target.matchDate ?? null,
    performanceId: String(target.performanceId),
    productCode: target.productCode,
    productTypeCode: target.productTypeCode,
    quantity: Number(target.quantity ?? 1),
    sourceCardText: target.sourceCardText ?? target.cardText ?? null,
    shopUrl: target.shopUrl || shopUrl,
  };

  return {
    ...normalized,
    loungeUrl: target.loungeUrl || buildLoungeUrl(shopUrl, normalized),
  };
}

function uniqueTargets(targets, shopUrl) {
  const keyed = new Map();

  for (const rawTarget of targets) {
    const target = normalizeKnownTarget(rawTarget, shopUrl);

    if (target) {
      keyed.set(targetKey(target), target);
    }
  }

  return [...keyed.values()];
}

export function knownTargetsFromPreviousState(previousState, shopUrl) {
  const explicitTargets = Array.isArray(previousState?.knownTargets)
    ? previousState.knownTargets
    : [];
  const rowTargets = (previousState?.latestRows || []).map((row) => ({
    matchCode: row.matchCode,
    teams: row.teams,
    venue: row.venue,
    city: row.city,
    country: row.country,
    matchDate: row.matchDate,
    performanceId: row.performanceId,
    productCode: row.productCode,
    productTypeCode: row.productTypeCode,
    quantity: row.quantity,
    loungeUrl: row.loungeUrl,
    shopUrl: row.fifaShopUrl,
  }));

  return uniqueTargets([...explicitTargets, ...rowTargets], shopUrl);
}

function knownTargetsFromMatchResults(matchResults, shopUrl) {
  return uniqueTargets(matchResults.map((result) => result.target), shopUrl);
}

function flattenRows(matchResults, checkedAt) {
  return matchResults.flatMap((result) => (
    result.availability?.rows ?? []
  ).map((row) => ({
    ...row,
    checkedAt: result.checkedAt || checkedAt,
  })));
}

function alertTimestamp(row) {
  if (row?.lastAlertAt) {
    return row.lastAlertAt;
  }

  if (row?.availabilityFreshness === 'new') {
    return row.becameAvailableAt || row.lastChangedAt || row.checkedAt || null;
  }

  if (row?.availabilityFreshness === 'increased') {
    return row.lastChangedAt || row.checkedAt || null;
  }

  return null;
}

function alertReason(row) {
  if (['new', 'increased'].includes(row?.alertReason)) {
    return row.alertReason;
  }

  if (['new', 'increased'].includes(row?.availabilityFreshness)) {
    return row.availabilityFreshness;
  }

  return null;
}

function enrichRowsWithFreshness(previousState, currentRows, checkedAt) {
  const previousRows = previousState?.latestRows ?? [];
  const previous = new Map(previousRows.map((row) => [rowKey(row), row]));
  const previousCheckedAt = previousState?.lastTickAt
    || previousState?.lastCycleSummary?.cycleCompletedAt
    || null;

  return currentRows.map((row) => {
    const earlier = previous.get(rowKey(row));
    const changed = !earlier
      || Boolean(earlier.available) !== Boolean(row.available)
      || Number(earlier.availableQuantity ?? 0) !== Number(row.availableQuantity ?? 0)
      || Number(earlier.priceMxn ?? 0) !== Number(row.priceMxn ?? 0);
    const becameAvailable = row.available && !earlier?.available;
    const quantityIncreased = row.available
      && earlier?.available
      && Number(row.availableQuantity ?? 0) > Number(earlier.availableQuantity ?? 0);
    const lastKnownChange = earlier?.lastChangedAt || earlier?.checkedAt || previousCheckedAt;
    const currentAlertReason = becameAvailable ? 'new' : quantityIncreased ? 'increased' : null;
    const previousAlertAt = alertTimestamp(earlier);
    const previousAlertReason = alertReason(earlier);

    return {
      ...row,
      checkedAt,
      lastChangedAt: changed ? checkedAt : lastKnownChange,
      becameAvailableAt: row.available
        ? (becameAvailable ? checkedAt : earlier?.becameAvailableAt || null)
        : null,
      lastAvailableDetectedAt: row.available ? checkedAt : earlier?.lastAvailableDetectedAt || null,
      availabilityFreshness: becameAvailable ? 'new'
        : quantityIncreased ? 'increased'
          : row.available ? 'available'
            : 'unavailable',
      lastAlertAt: row.available
        ? (currentAlertReason ? checkedAt : previousAlertAt)
        : null,
      alertReason: row.available
        ? (currentAlertReason || previousAlertReason)
        : null,
    };
  });
}

function mergeRowsForPartialCycle(previousState, currentRows, checkedAt) {
  const merged = new Map(currentRows.map((row) => [rowKey(row), row]));

  for (const row of previousState?.latestRows || []) {
    if (!merged.has(rowKey(row))) {
      merged.set(rowKey(row), {
        ...row,
        stale: true,
        staleReason: 'not_refreshed_in_partial_cycle',
        lastRefreshAttemptAt: checkedAt,
      });
    }
  }

  return [...merged.values()];
}

function changedToAvailableRows(previousState, currentRows) {
  const previousRows = previousState?.latestRows ?? [];
  const previous = new Map(previousRows.map((row) => [rowKey(row), row]));

  return currentRows.filter((row) => {
    if (!row.available) {
      return false;
    }

    const earlier = previous.get(rowKey(row));
    return !earlier || !earlier.available || Number(earlier.availableQuantity ?? 0) < Number(row.availableQuantity ?? 0);
  });
}

function activeAlertRows(rows, retentionMs, referenceAt) {
  if (retentionMs <= 0) {
    return [];
  }

  const referenceTime = Date.parse(referenceAt || new Date().toISOString());
  const cutoff = referenceTime - retentionMs;

  return rows
    .filter((row) => {
      if (!row.available) {
        return false;
      }

      const timestamp = alertTimestamp(row);
      return timestamp && Date.parse(timestamp) >= cutoff;
    })
    .sort((a, b) => Date.parse(alertTimestamp(b)) - Date.parse(alertTimestamp(a)));
}

export async function runFifaCycle(config, previousState = null, emit = () => {}) {
  const cycleStartedAt = new Date().toISOString();
  emit({ event: 'cycle_started', cycleStartedAt });
  const discovery = await discoverMatchJobs(config, emit);
  const matchResults = await runMatchJobsInPool(config, discovery.jobs, emit);
  const cycleCompletedAt = new Date().toISOString();
  const failedMatchCount = matchResults.filter((result) => !result?.ok).length;
  const refreshedRows = enrichRowsWithFreshness(
    previousState,
    flattenRows(matchResults, cycleCompletedAt),
    cycleCompletedAt,
  );
  const rows = failedMatchCount > 0
    ? mergeRowsForPartialCycle(previousState, refreshedRows, cycleCompletedAt)
    : refreshedRows;
  const availableRows = rows.filter((row) => row.available);
  const alerts = activeAlertRows(rows, config.alertRetentionMs, cycleCompletedAt);
  const knownTargets = knownTargetsFromMatchResults(matchResults, config.shopUrl);
  const cycle = {
    tick: previousState?.lastCycleSummary?.tick ? previousState.lastCycleSummary.tick + 1 : 1,
    cycleStartedAt,
    cycleCompletedAt,
    partial: failedMatchCount > 0,
    mode: 'browser-discovery',
    transport: 'ZenRows Scraping Browser',
    endpoint: config.publicBrowserUrl,
    shopUrl: config.shopUrl,
    visitorCountry: config.visitorCountry,
    matchConcurrency: config.matchConcurrency,
    alertRetentionMs: config.alertRetentionMs,
    initialState: discovery.initialState,
    matchCardsFound: discovery.allCards.length,
    matchCardsScanned: discovery.jobs.length,
    skippedCards: discovery.allCards.filter((card) => !discovery.jobs.includes(card)),
    matches: matchResults,
    failedMatchCount,
    knownTargets,
    rowCount: rows.length,
    availableRowCount: availableRows.length,
    rows,
    availableRows,
    alerts,
  };

  emit({
    event: 'cycle_completed',
    cycleStartedAt,
    cycleCompletedAt: cycle.cycleCompletedAt,
    matchCardsFound: cycle.matchCardsFound,
    matchCardsScanned: cycle.matchCardsScanned,
    failedMatchCount: cycle.failedMatchCount,
    partial: cycle.partial,
    rowCount: cycle.rowCount,
    availableRowCount: cycle.availableRowCount,
    alertCount: cycle.alerts.length,
  });

  return cycle;
}

export function persistCycle(cycle, config) {
  const latestCyclePath = config.latestCyclePath || DEFAULT_LATEST_CYCLE_PATH;
  const statePath = config.statePath || DEFAULT_STATE_PATH;
  const historyPath = cycleArtifactPath(cycle.cycleStartedAt);

  writeJson(latestCyclePath, cycle);
  writeJson(historyPath, cycle);
  const state = stateFromCycle(cycle, latestCyclePath);
  writeJson(statePath, state);
  persistCycleToSqlite(cycle, { latestCyclePath, state });

  return {
    latestCyclePath,
    historyPath,
    statePath,
  };
}
