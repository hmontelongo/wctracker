import { loadDotEnv, requireEnv } from './lib/env.mjs';
import { writeJson } from './lib/files.mjs';

loadDotEnv();

const apiKey = requireEnv('ZENROWS_API_KEY');
const targetUrl = process.env.ZENROWS_TARGET_URL || 'https://example.com';
const apiEndpoint = 'https://api.zenrows.com/v1/';

const cases = [
  {
    name: 'basic-html',
    expectedShape: 'raw HTML/text body',
    params: {
      url: targetUrl,
    },
  },
  {
    name: 'css-extractor',
    expectedShape: 'JSON object produced by css_extractor',
    params: {
      url: targetUrl,
      css_extractor: JSON.stringify({
        title: 'h1',
        paragraph: 'p',
        first_link: 'a @href',
      }),
    },
  },
  {
    name: 'markdown',
    expectedShape: 'Markdown text body from response_type=markdown',
    params: {
      url: targetUrl,
      response_type: 'markdown',
    },
  },
  {
    name: 'json-response-js',
    expectedShape: 'JSON object containing rendered html and xhr/fetch metadata',
    params: {
      url: targetUrl,
      js_render: 'true',
      json_response: 'true',
    },
  },
];

function interestingHeaders(headers) {
  const names = [
    'content-type',
    'content-length',
    'concurrency-limit',
    'concurrency-remaining',
    'x-request-cost',
    'x-request-id',
    'zr-final-url',
  ];

  return Object.fromEntries(
    names
      .map((name) => [name, headers.get(name)])
      .filter(([, value]) => value !== null),
  );
}

function previewText(value, maxLength = 240) {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

async function runCase(testCase) {
  const url = new URL(apiEndpoint);
  const params = new URLSearchParams({
    apikey: apiKey,
    ...testCase.params,
  });

  url.search = params.toString();

  const startedAt = Date.now();
  const response = await fetch(url);
  const body = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') || '';
  const text = body.toString('utf8');
  let parsedJson = null;

  if (contentType.includes('json') || text.trim().startsWith('{') || text.trim().startsWith('[')) {
    try {
      parsedJson = JSON.parse(text);
    } catch {
      parsedJson = null;
    }
  }

  const result = {
    name: testCase.name,
    ok: response.ok,
    status: response.status,
    durationMs: Date.now() - startedAt,
    expectedShape: testCase.expectedShape,
    requestParams: testCase.params,
    responseHeaders: interestingHeaders(response.headers),
    bodyBytes: body.byteLength,
  };

  if (parsedJson) {
    result.jsonTopLevelKeys = Object.keys(parsedJson);
    result.jsonSample = parsedJson;
  } else {
    result.textPreview = previewText(text);
  }

  return result;
}

const results = [];

for (const testCase of cases) {
  results.push(await runCase(testCase));
}

const report = {
  generatedAt: new Date().toISOString(),
  endpoint: apiEndpoint,
  targetUrl,
  cases: results,
};

const outputPath = writeJson('artifacts/universal-scraper-smoke.json', report);

console.log(JSON.stringify(report, null, 2));
console.error(`Saved Universal Scraper report to ${outputPath}`);

if (results.some((result) => !result.ok)) {
  process.exitCode = 1;
}

