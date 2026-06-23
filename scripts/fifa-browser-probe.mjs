import { loadDotEnv, requireEnv } from './lib/env.mjs';
import { writeJson } from './lib/files.mjs';
import { CdpConnection, sleep } from './lib/cdp.mjs';
import {
  DEFAULT_SHOP_URL,
  loadTargets,
  loungeUrl,
  normalizeLounges,
  parseJsonMaybe,
} from './lib/fifa.mjs';
import { buildBrowserUrl, redactZenRowsUrl } from './lib/zenrows.mjs';

loadDotEnv();

const apiKey = requireEnv('ZENROWS_API_KEY');
const shopUrl = process.env.FIFA_SHOP_URL || DEFAULT_SHOP_URL;
const targets = loadTargets(process.env.FIFA_TARGETS_FILE || 'config/targets.json');
const target = targets[0];
const targetLoungeUrl = loungeUrl(shopUrl, target);
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

async function prepareShopPage(cdp, sessionId) {
  await evaluate(cdp, sessionId, `
    (() => {
      const text = (el) => (el.innerText || el.textContent || '').trim();
      document.getElementById('onetrust-accept-btn-handler')?.click();
      const candidates = [...document.querySelectorAll('button, [role="button"], a')];
      candidates.find((el) => /m[eé]xico|mexico/i.test(text(el)))?.click();
      return {
        url: location.href,
        title: document.title,
        textPreview: document.body?.innerText?.slice(0, 1000) || ''
      };
    })()
  `);

  await sleep(3000);
}

async function fetchLoungeFromPage(cdp, sessionId) {
  return evaluate(cdp, sessionId, `
    (async () => {
      const response = await fetch(${JSON.stringify(targetLoungeUrl)}, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { accept: 'application/json, text/plain, */*' }
      });
      const text = await response.text();

      return {
        status: response.status,
        ok: response.ok,
        finalUrl: response.url,
        body: text
      };
    })()
  `, 60000);
}

const startedAt = Date.now();
const cdp = new CdpConnection(browserUrl.toString());
let targetId = null;

try {
  await cdp.connect();
  const version = await cdp.send('Browser.getVersion');
  const createdTarget = await cdp.send('Target.createTarget', { url: 'about:blank' });
  targetId = createdTarget.targetId;
  const attachedTarget = await cdp.send('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  const { sessionId } = attachedTarget;

  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);

  const loaded = cdp.waitFor('Page.loadEventFired', sessionId, 45000).catch((error) => ({
    timeout: error.message,
  }));
  await cdp.send('Page.navigate', { url: shopUrl }, sessionId);
  await loaded;
  await sleep(5000);
  await prepareShopPage(cdp, sessionId);

  const pageState = await evaluate(cdp, sessionId, `
    (() => ({
      url: location.href,
      title: document.title,
      textPreview: document.body?.innerText?.replace(/\\s+/g, ' ').trim().slice(0, 1500) || ''
    }))()
  `);

  const loungeResponse = await fetchLoungeFromPage(cdp, sessionId);
  const bodyJson = parseJsonMaybe(loungeResponse.body);
  const normalized = Array.isArray(bodyJson) ? normalizeLounges(bodyJson, target) : null;

  const report = {
    generatedAt: new Date().toISOString(),
    transport: 'ZenRows Scraping Browser',
    endpoint: redactZenRowsUrl(browserUrl),
    protocol: 'Chrome DevTools Protocol over WebSocket',
    durationMs: Date.now() - startedAt,
    shopUrl,
    targetLoungeUrl,
    browserVersion: version,
    pageState,
    loungeResponse: {
      ok: loungeResponse.ok,
      status: loungeResponse.status,
      finalUrl: loungeResponse.finalUrl,
      bodyBytes: Buffer.byteLength(loungeResponse.body || ''),
      jsonTopLevelType: Array.isArray(bodyJson) ? 'array' : typeof bodyJson,
    },
    normalized,
    validated: Boolean(normalized?.checkedPackage === target.loungeId),
  };

  const outputPath = writeJson('artifacts/fifa-browser-probe.json', report);
  console.log(JSON.stringify(report, null, 2));
  console.error(`Saved FIFA Scraping Browser probe to ${outputPath}`);

  if (!report.validated) {
    process.exitCode = 2;
  }
} finally {
  if (targetId) {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  }

  cdp.close();
}
