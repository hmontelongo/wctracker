import { loadDotEnv, requireEnv } from './lib/env.mjs';
import { writeJson } from './lib/files.mjs';
import { CdpConnection, sleep } from './lib/cdp.mjs';
import {
  DEFAULT_SHOP_URL,
  buildDiscoveredTarget,
  matchCodeFromText,
  normalizeAvailability,
  normalizeSpace,
  parseJsonMaybe,
} from './lib/fifa.mjs';
import { buildBrowserUrl, redactZenRowsUrl } from './lib/zenrows.mjs';

loadDotEnv();

const apiKey = requireEnv('ZENROWS_API_KEY');
const shopUrl = process.env.FIFA_SHOP_URL || DEFAULT_SHOP_URL;
const visitorCountry = process.env.FIFA_VISITOR_COUNTRY || 'Mexico';
const browserUrl = buildBrowserUrl(apiKey, {
  proxy_region: process.env.ZENROWS_BROWSER_PROXY_REGION,
  proxy_country: process.env.ZENROWS_BROWSER_PROXY_COUNTRY,
  session_ttl: process.env.ZENROWS_BROWSER_SESSION_TTL,
});

async function evaluate(cdp, sessionId, expression, timeoutMs = 45000) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId, timeoutMs);

  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'Runtime.evaluate failed');
  }

  return result.result?.value;
}

async function installCapture(cdp, sessionId) {
  const captureScript = `
    (() => {
      if (window.__fifaCaptureInstalled) return;
      window.__fifaCaptureInstalled = true;
      window.__fifaCapturedResponses = [];
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        try {
          const requestUrl = String(args[0]?.url || args[0] || response.url || '');
          const responseUrl = String(response.url || requestUrl);
          if (responseUrl.includes('/next-api/lounges') || requestUrl.includes('/next-api/lounges')) {
            const text = await response.clone().text();
            window.__fifaCapturedResponses.push({
              url: responseUrl || requestUrl,
              status: response.status,
              ok: response.ok,
              body: text,
              capturedAt: new Date().toISOString()
            });
          }
        } catch {}
        return response;
      };
    })();
  `;

  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: captureScript }, sessionId);
  await evaluate(cdp, sessionId, captureScript);
}

async function navigateAndSelectCountry(cdp, sessionId) {
  const loaded = cdp.waitFor('Page.loadEventFired', sessionId, 45000).catch((error) => ({
    timeout: error.message,
  }));
  await cdp.send('Page.navigate', { url: shopUrl }, sessionId);
  await loaded;
  await installCapture(cdp, sessionId);

  return evaluate(cdp, sessionId, `
    (() => {
      const shopCountry = ${JSON.stringify(visitorCountry)};
      const text = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
      document.getElementById('onetrust-accept-btn-handler')?.click();
      const candidates = [...document.querySelectorAll('button, [role="button"], a')];
      const countryButton = candidates.find((el) => text(el).toLowerCase() === shopCountry.toLowerCase())
        || candidates.find((el) => text(el).toLowerCase().includes(shopCountry.toLowerCase()));
      countryButton?.click();
      return {
        selectedShopCountryClicked: Boolean(countryButton),
        url: location.href,
        title: document.title,
        textPreview: text(document.body).slice(0, 1000)
      };
    })()
  `);
}

async function scrollAndCollectCards(cdp, sessionId) {
  return evaluate(cdp, sessionId, `
    (async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const text = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
      let lastCount = 0;
      let stableRounds = 0;

      for (let i = 0; i < 15; i += 1) {
        const cards = [...document.querySelectorAll('button.match, button[class*="match"]')]
          .filter((el) => /\\bM\\d+\\b/i.test(text(el)));
        if (cards.length === lastCount) {
          stableRounds += 1;
        } else {
          stableRounds = 0;
          lastCount = cards.length;
        }
        window.scrollTo(0, document.body.scrollHeight);
        await sleep(500);
        if (stableRounds >= 2) break;
      }

      const cards = [...document.querySelectorAll('button.match, button[class*="match"]')]
        .filter((el) => /\\bM\\d+\\b/i.test(text(el)));

      return cards.map((el, index) => ({
        index,
        text: text(el),
        matchCode: text(el).match(/\\bM\\d+\\b/i)?.[0]?.toUpperCase() || null,
        isOtherCountryShop: /must be purchased in the .* ticket shop/i.test(text(el)),
        isCurrentlyUnavailableOnCard: /currently unavailable/i.test(text(el)),
        isDisabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
        attributes: Object.fromEntries([...el.attributes].map((attr) => [attr.name, attr.value]))
      }));
    })()
  `, 60000);
}

function selectableCards(cards) {
  return cards.filter((card) => (
    !card.isOtherCountryShop &&
    !card.isCurrentlyUnavailableOnCard &&
    !card.isDisabled
  ));
}

async function clearCaptures(cdp, sessionId) {
  await evaluate(cdp, sessionId, 'window.__fifaCapturedResponses = []');
}

async function readCaptures(cdp, sessionId) {
  return evaluate(cdp, sessionId, 'window.__fifaCapturedResponses || []');
}

async function clickCard(cdp, sessionId, card) {
  return evaluate(cdp, sessionId, `
    (() => {
      const wantedCode = ${JSON.stringify(card.matchCode)};
      const wantedText = ${JSON.stringify(card.text)};
      const text = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
      const cards = [...document.querySelectorAll('button.match, button[class*="match"]')]
        .filter((el) => /\\bM\\d+\\b/i.test(text(el)));
      const match = cards.find((el) => wantedCode && text(el).includes(wantedCode))
        || cards.find((el) => text(el) === wantedText)
        || cards[${card.index}];

      if (!match) {
        return { clicked: false, reason: 'match_card_not_found' };
      }

      match.scrollIntoView({ block: 'center' });
      match.click();
      return { clicked: true, text: text(match) };
    })()
  `);
}

async function returnToList(cdp, sessionId) {
  await evaluate(cdp, sessionId, `
    (() => {
      const text = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
      const candidates = [...document.querySelectorAll('button, [role="button"], a')];
      const back = candidates.find((el) => /^(back|volver|atrás|regresar)$/i.test(text(el)))
        || candidates.find((el) => /back|volver|atrás|regresar/i.test(el.getAttribute('aria-label') || ''));
      if (back) {
        back.click();
        return { method: 'button' };
      }
      history.back();
      return { method: 'history' };
    })()
  `).catch(() => null);
  await sleep(2500);
}

function targetFromCardAndCapture(card, capture) {
  const bodyJson = parseJsonMaybe(capture.body);
  const target = buildDiscoveredTarget({
    card: {
      ...card,
      text: normalizeSpace(card.text),
      matchCode: card.matchCode ?? matchCodeFromText(card.text),
    },
    loungeResponse: capture,
    shopUrl,
  });

  return {
    target,
    response: {
      url: capture.url,
      status: capture.status,
      ok: capture.ok,
      bodyBytes: Buffer.byteLength(capture.body || ''),
      capturedAt: capture.capturedAt,
    },
    availability: Array.isArray(bodyJson) ? normalizeAvailability(bodyJson, target) : null,
  };
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
          const body = result.base64Encoded
            ? Buffer.from(result.body, 'base64').toString('utf8')
            : result.body;

          bucket.push({
            ...request,
            body,
          });
        })
        .catch((error) => {
          bucket.push({
            ...request,
            body: '',
            error: error.message,
          });
        });
    }
  });
}

async function waitForLoungeCapture(read, timeoutMs = 12000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const captures = await read();

    if (captures.some((capture) => capture.url?.includes('/next-api/lounges'))) {
      return captures;
    }

    await sleep(500);
  }

  return read();
}

const startedAt = Date.now();
const cdp = new CdpConnection(browserUrl.toString());
let targetId = null;

try {
  console.error('Connecting to ZenRows Scraping Browser...');
  await cdp.connect();
  const version = await cdp.send('Browser.getVersion');
  console.error(`Connected: ${version.product}`);
  const createdTarget = await cdp.send('Target.createTarget', { url: 'about:blank' });
  targetId = createdTarget.targetId;
  const attachedTarget = await cdp.send('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  const { sessionId } = attachedTarget;

  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);
  const networkCaptures = [];
  installNetworkCapture(cdp, sessionId, networkCaptures);

  console.error(`Opening FIFA shop with buyer/shop context: ${visitorCountry}`);
  const initialState = await navigateAndSelectCountry(cdp, sessionId);
  console.error('Collecting match cards...');
  let cards = await scrollAndCollectCards(cdp, sessionId);
  const selectedCards = selectableCards(cards);
  console.error(`Found ${cards.length} match cards; queued ${selectedCards.length} purchasable cards.`);
  const discoveries = [];
  const failures = [];
  const writePartial = () => {
    const targets = discoveries
      .map((item) => item.target)
      .filter((target, index, all) => (
        target.performanceId &&
        all.findIndex((candidate) => candidate.performanceId === target.performanceId) === index
      ));

    writeJson('artifacts/fifa-availability-snapshot.partial.json', {
      generatedAt: new Date().toISOString(),
      partial: true,
      shopUrl,
      visitorCountry,
      matchCardsFound: cards.length,
      matchCardsQueued: selectedCards.length,
      skippedCards: cards.filter((card) => !selectedCards.includes(card)),
      targetsDiscovered: targets.length,
      targets,
      discoveries,
      failures,
    });

    if (targets.length > 0) {
      writeJson(process.env.FIFA_DISCOVERED_TARGETS_FILE || 'artifacts/fifa-discovered-targets.json', targets);
    }
  };

  for (let index = 0; index < selectedCards.length; index += 1) {
    const card = selectedCards[index];
    console.error(`Clicking ${card.matchCode || `card ${index + 1}`} (${index + 1}/${selectedCards.length})...`);
    await clearCaptures(cdp, sessionId);
    networkCaptures.length = 0;
    const clicked = await clickCard(cdp, sessionId, card);

    if (!clicked.clicked) {
      failures.push({ card, reason: clicked.reason });
      await navigateAndSelectCountry(cdp, sessionId);
      cards = await scrollAndCollectCards(cdp, sessionId);
      continue;
    }

    const captures = await waitForLoungeCapture(async () => [
      ...networkCaptures,
      ...(await readCaptures(cdp, sessionId)).map((capture) => ({
        ...capture,
        source: capture.source || 'in-page-fetch',
      })),
    ]);
    console.error(`Captured ${captures.length} lounge/API responses for ${card.matchCode || `card ${index + 1}`}.`);
    const loungeCapture = captures.find((capture) => (
      capture.url?.includes('/next-api/lounges') &&
      capture.url?.includes('performanceId=')
    ));

    if (loungeCapture) {
      discoveries.push(targetFromCardAndCapture(card, loungeCapture));
    } else {
      const afterClickState = await evaluate(cdp, sessionId, `
        (() => ({
          url: location.href,
          title: document.title,
          textPreview: (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 1500)
        }))()
      `).catch((error) => ({ error: error.message }));

      failures.push({
        card,
        reason: 'lounge_response_not_captured',
        captures: captures.map((capture) => ({
          url: capture.url,
          status: capture.status,
          source: capture.source,
          error: capture.error,
        })),
        afterClickState,
      });
    }

    writePartial();

    if (index >= selectedCards.length - 1) {
      continue;
    }

    await navigateAndSelectCountry(cdp, sessionId);
    cards = await scrollAndCollectCards(cdp, sessionId);
  }

  const targets = discoveries
    .map((item) => item.target)
    .filter((target, index, all) => (
      target.performanceId &&
      all.findIndex((candidate) => candidate.performanceId === target.performanceId) === index
    ));

  const report = {
    generatedAt: new Date().toISOString(),
    transport: 'ZenRows Scraping Browser',
    endpoint: redactZenRowsUrl(browserUrl),
    protocol: 'Chrome DevTools Protocol over WebSocket',
    durationMs: Date.now() - startedAt,
    shopUrl,
    visitorCountry,
    browserVersion: version,
    initialState,
    matchCardsFound: cards.length,
    matchCardsQueued: selectedCards.length,
    skippedCards: cards.filter((card) => !selectedCards.includes(card)),
    targetsDiscovered: targets.length,
    availabilityRows: discoveries.reduce((sum, item) => sum + (item.availability?.rowCount || 0), 0),
    availableRows: discoveries.flatMap((item) => item.availability?.availableRows || []),
    targets,
    discoveries,
    failures,
  };

  const reportPath = writeJson('artifacts/fifa-availability-snapshot.json', report);
  const targetPath = targets.length > 0
    ? writeJson(process.env.FIFA_DISCOVERED_TARGETS_FILE || 'artifacts/fifa-discovered-targets.json', targets)
    : null;
  console.log(JSON.stringify(report, null, 2));
  console.error(`Saved FIFA availability snapshot to ${reportPath}`);
  if (targetPath) {
    console.error(`Saved discovered targets to ${targetPath}`);
  } else {
    console.error('No targets discovered; preserving any previous discovered target file.');
  }

  if (!targets.length) {
    process.exitCode = 2;
  }
} finally {
  if (targetId) {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  }

  cdp.close();
}
