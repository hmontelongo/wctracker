import { loadDotEnv, requireEnv } from './lib/env.mjs';
import { writeBase64, writeJson } from './lib/files.mjs';

loadDotEnv();

const apiKey = requireEnv('ZENROWS_API_KEY');
const targetUrl = process.env.ZENROWS_BROWSER_TARGET_URL || 'https://example.com';
const browserUrl = new URL('wss://browser.zenrows.com/');
browserUrl.searchParams.set('apikey', apiKey);

for (const [envName, queryName] of [
  ['ZENROWS_BROWSER_PROXY_REGION', 'proxy_region'],
  ['ZENROWS_BROWSER_PROXY_COUNTRY', 'proxy_country'],
  ['ZENROWS_BROWSER_SESSION_TTL', 'session_ttl'],
]) {
  if (process.env[envName]) {
    browserUrl.searchParams.set(queryName, process.env[envName]);
  }
}

function publicBrowserUrl() {
  const redacted = new URL(browserUrl);
  redacted.searchParams.set('apikey', '<redacted>');
  return redacted.toString();
}

function messageDataToString(data) {
  if (typeof data === 'string') {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8');
  }

  return Buffer.from(data).toString('utf8');
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

class CdpConnection {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = new Set();
    this.socket = null;
  }

  async connect() {
    if (typeof WebSocket === 'undefined') {
      throw new Error('This script requires Node.js with the global WebSocket API.');
    }

    this.socket = new WebSocket(this.url);

    this.socket.addEventListener('message', (event) => {
      this.handleMessage(event.data);
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timed out while opening Scraping Browser WebSocket.'));
      }, 30000);

      this.socket.addEventListener('open', () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });

      this.socket.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error('Failed to open Scraping Browser WebSocket.'));
      }, { once: true });
    });
  }

  handleMessage(data) {
    const message = JSON.parse(messageDataToString(data));

    if (message.id && this.pending.has(message.id)) {
      const request = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(request.timeout);

      if (message.error) {
        request.reject(new Error(`${request.method}: ${message.error.message}`));
      } else {
        request.resolve(message.result || {});
      }

      return;
    }

    for (const waiter of [...this.waiters]) {
      if (
        waiter.method === message.method &&
        (!waiter.sessionId || waiter.sessionId === message.sessionId)
      ) {
        clearTimeout(waiter.timeout);
        this.waiters.delete(waiter);
        waiter.resolve(message);
      }
    }
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    const payload = { id, method, params };

    if (sessionId) {
      payload.sessionId = sessionId;
    }

    this.socket.send(JSON.stringify(payload));

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: timed out waiting for CDP response.`));
      }, 45000);

      this.pending.set(id, { method, resolve, reject, timeout });
    });
  }

  waitFor(method, sessionId, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const waiter = {
        method,
        sessionId,
        resolve,
        timeout: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error(`${method}: timed out waiting for CDP event.`));
        }, timeoutMs),
      };

      this.waiters.add(waiter);
    });
  }

  close() {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.close();
    }
  }
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

  const pageLoaded = cdp.waitFor('Page.loadEventFired', sessionId, 30000).catch((error) => ({
    timeout: error.message,
  }));

  await cdp.send('Page.navigate', { url: targetUrl }, sessionId);
  await pageLoaded;
  await sleep(1000);

  const evaluation = await cdp.send('Runtime.evaluate', {
    expression: `(() => ({
      title: document.title,
      h1: document.querySelector('h1')?.innerText || null,
      url: location.href,
      textLength: document.body?.innerText?.length || 0,
      userAgent: navigator.userAgent
    }))()`,
    returnByValue: true,
  }, sessionId);

  const screenshot = await cdp.send('Page.captureScreenshot', {
    format: 'jpeg',
    quality: 60,
    captureBeyondViewport: false,
  }, sessionId);

  const screenshotPath = writeBase64('artifacts/scraping-browser-screenshot.jpeg', screenshot.data);

  const report = {
    generatedAt: new Date().toISOString(),
    endpoint: publicBrowserUrl(),
    targetUrl,
    durationMs: Date.now() - startedAt,
    protocol: 'Chrome DevTools Protocol over WebSocket',
    browserVersion: version,
    extracted: evaluation.result?.value || null,
    screenshot: {
      path: screenshotPath,
      bytes: Buffer.byteLength(screenshot.data, 'base64'),
      encoding: 'base64 from Page.captureScreenshot, saved as jpeg',
    },
  };

  const outputPath = writeJson('artifacts/scraping-browser-smoke.json', report);
  console.log(JSON.stringify(report, null, 2));
  console.error(`Saved Scraping Browser report to ${outputPath}`);
} finally {
  if (targetId) {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  }

  cdp.close();
}

