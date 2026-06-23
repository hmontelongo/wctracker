export const UNIVERSAL_ENDPOINT = 'https://api.zenrows.com/v1/';

export function buildBrowserUrl(apiKey, options = {}) {
  const url = new URL('wss://browser.zenrows.com/');
  url.searchParams.set('apikey', apiKey);

  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  return url;
}

export function redactZenRowsUrl(url) {
  const redacted = new URL(url.toString());

  if (redacted.searchParams.has('apikey')) {
    redacted.searchParams.set('apikey', '<redacted>');
  }

  return redacted.toString();
}

export function interestingHeaders(headers) {
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

export async function requestUniversal(apiKey, params) {
  const url = new URL(UNIVERSAL_ENDPOINT);
  url.search = new URLSearchParams({
    apikey: apiKey,
    ...params,
  }).toString();

  const startedAt = Date.now();
  const response = await fetch(url);
  const body = Buffer.from(await response.arrayBuffer());
  const text = body.toString('utf8');

  return {
    ok: response.ok,
    status: response.status,
    durationMs: Date.now() - startedAt,
    headers: interestingHeaders(response.headers),
    bodyBytes: body.byteLength,
    text,
  };
}

