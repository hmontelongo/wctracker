import { loadDotEnv, requireEnv } from './lib/env.mjs';
import { writeJson } from './lib/files.mjs';
import {
  DEFAULT_SHOP_URL,
  loadTargets,
  loungeUrl,
  normalizeLounges,
  parseJsonMaybe,
} from './lib/fifa.mjs';
import { requestUniversal, UNIVERSAL_ENDPOINT } from './lib/zenrows.mjs';

loadDotEnv();

const apiKey = requireEnv('ZENROWS_API_KEY');
const shopUrl = process.env.FIFA_SHOP_URL || DEFAULT_SHOP_URL;
const targets = loadTargets(process.env.FIFA_TARGETS_FILE || 'config/targets.json');
const target = targets[0];
const targetLoungeUrl = loungeUrl(shopUrl, target);

function preview(value, maxLength = 500) {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function summarizeJsonResponse(text, target) {
  const parsed = parseJsonMaybe(text);

  if (!parsed) {
    return {
      parsed: false,
      textPreview: preview(text),
    };
  }

  const xhr = Array.isArray(parsed.xhr) ? parsed.xhr : [];
  const loungeResponses = [];

  for (const item of xhr) {
    const body = typeof item.body === 'string' ? item.body : '';
    const bodyJson = parseJsonMaybe(body);
    const isLoungeUrl = typeof item.url === 'string' && item.url.includes('/next-api/lounges');
    const bodyMentionsTarget = body.includes(target.loungeId) || body.includes(target.seatingCode);

    if (isLoungeUrl || bodyMentionsTarget) {
      loungeResponses.push({
        url: item.url,
        method: item.method,
        statusCode: item.status_code,
        bodyBytes: Buffer.byteLength(body),
        normalized: Array.isArray(bodyJson) ? normalizeLounges(bodyJson, target) : null,
        bodyPreview: bodyJson ? undefined : preview(body),
      });
    }
  }

  return {
    parsed: true,
    topLevelKeys: Object.keys(parsed),
    htmlMentions: {
      matchCode: typeof parsed.html === 'string' && parsed.html.includes(target.matchCode),
      loungeId: typeof parsed.html === 'string' && parsed.html.includes(target.loungeId),
      seatingCode: typeof parsed.html === 'string' && parsed.html.includes(target.seatingCode),
      suiteEssentials: typeof parsed.html === 'string' && parsed.html.includes('Suite Essentials'),
      unavailable: typeof parsed.html === 'string' && parsed.html.includes('Currently Unavailable'),
    },
    xhrCount: xhr.length,
    xhrUrls: xhr.slice(0, 30).map((item) => ({
      url: item.url,
      method: item.method,
      statusCode: item.status_code,
    })),
    loungeResponses,
    jsInstructionsReport: parsed.js_instructions_report ?? null,
  };
}

const direct = await requestUniversal(apiKey, {
  url: targetLoungeUrl,
  original_status: 'true',
  allowed_status_codes: '401,403,404,500',
});

const pageJson = await requestUniversal(apiKey, {
  url: shopUrl,
  js_render: 'true',
  json_response: 'true',
  wait: '8000',
});

const clickInstructions = [
  { wait_event: 'networkalmostidle' },
  {
    evaluate: `
      (() => {
        const text = (el) => (el.innerText || el.textContent || '').trim();
        const clickById = (id) => document.getElementById(id)?.click();
        clickById('onetrust-accept-btn-handler');

        const candidates = [...document.querySelectorAll('button, [role="button"], a')];
        candidates.find((el) => /m[eé]xico|mexico/i.test(text(el)))?.click();
      })();
    `,
  },
  { wait: 3000 },
  {
    evaluate: `
      (() => {
        const text = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
        const candidates = [...document.querySelectorAll('button.match, button, [role="button"], a')];
        const match = candidates.find((el) => text(el).includes('${target.matchCode}'))
          || candidates.find((el) => /Uruguay/i.test(text(el)) && /Spain/i.test(text(el)));
        match?.scrollIntoView({ block: 'center' });
        match?.click();
      })();
    `,
  },
  { wait: 8000 },
];

const pageAfterClick = await requestUniversal(apiKey, {
  url: shopUrl,
  js_render: 'true',
  json_response: 'true',
  js_instructions: JSON.stringify(clickInstructions),
});

const report = {
  generatedAt: new Date().toISOString(),
  transport: 'ZenRows Universal Scraper API',
  endpoint: UNIVERSAL_ENDPOINT,
  shopUrl,
  target: {
    matchCode: target.matchCode,
    teams: target.teams,
    performanceId: target.performanceId,
    loungeId: target.loungeId,
    seatingCode: target.seatingCode,
  },
  directLoungeEndpoint: {
    url: targetLoungeUrl,
    ok: direct.ok,
    status: direct.status,
    durationMs: direct.durationMs,
    headers: direct.headers,
    bodyBytes: direct.bodyBytes,
    bodyPreview: preview(direct.text),
  },
  pageJsonResponse: {
    ok: pageJson.ok,
    status: pageJson.status,
    durationMs: pageJson.durationMs,
    headers: pageJson.headers,
    bodyBytes: pageJson.bodyBytes,
    summary: summarizeJsonResponse(pageJson.text, target),
  },
  pageAfterClick: {
    ok: pageAfterClick.ok,
    status: pageAfterClick.status,
    durationMs: pageAfterClick.durationMs,
    headers: pageAfterClick.headers,
    bodyBytes: pageAfterClick.bodyBytes,
    summary: summarizeJsonResponse(pageAfterClick.text, target),
  },
};

report.validated = [
  ...report.pageJsonResponse.summary.loungeResponses,
  ...report.pageAfterClick.summary.loungeResponses,
].some((item) => item.normalized?.checkedPackage === target.loungeId);

const outputPath = writeJson('artifacts/fifa-universal-probe.json', report);
console.log(JSON.stringify(report, null, 2));
console.error(`Saved FIFA Universal probe to ${outputPath}`);

if (!report.validated) {
  process.exitCode = 2;
}

