import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { loadDotEnv, requireEnv } from './lib/env.mjs';
import { sleep } from './lib/cdp.mjs';
import {
  DEFAULT_LATEST_CYCLE_PATH,
  DEFAULT_STATE_PATH,
  configFromEnv,
  knownTargetsFromPreviousState,
  loadPreviousState,
  persistCycle,
  runFifaFastCycle,
  runFifaCycle,
} from './lib/fifa-job-system.mjs';
import { backfillSqliteFromJson, readLatestFromSqlite } from './lib/sqlite-store.mjs';

loadDotEnv();

const apiKey = requireEnv('ZENROWS_API_KEY');
const port = Number(process.env.DASHBOARD_PORT || 5177);
const host = process.env.DASHBOARD_HOST || '127.0.0.1';
const autostartTicker = String(process.env.DASHBOARD_AUTOSTART_TICKER ?? '1') !== '0';
const root = process.cwd();
const staticRoot = resolve(root, 'dashboard');
const clients = new Set();
const jobState = {
  running: false,
  tickerRunning: false,
  tickerIntervalMs: Number(process.env.FIFA_POLL_INTERVAL_MS || 60000),
  lastEvent: null,
  lastError: null,
  startedAt: null,
  completedAt: null,
  events: [],
};

backfillSqliteFromJson({
  latestCyclePath: DEFAULT_LATEST_CYCLE_PATH,
  statePath: DEFAULT_STATE_PATH,
});

function readJson(path, fallback = null) {
  if (!existsSync(path)) {
    return fallback;
  }

  return JSON.parse(readFileSync(path, 'utf8'));
}

function latestState() {
  const sqlite = readLatestFromSqlite();

  return {
    job: jobState,
    latestCycle: sqlite.latestCycle || readJson(DEFAULT_LATEST_CYCLE_PATH, null),
    state: sqlite.state || readJson(DEFAULT_STATE_PATH, null),
  };
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(payload)}\n`);
}

function broadcast(event) {
  const enriched = {
    ...event,
    emittedAt: new Date().toISOString(),
  };
  jobState.lastEvent = enriched;
  jobState.events.unshift(enriched);
  jobState.events = jobState.events.slice(0, 100);

  for (const client of clients) {
    client.write(`data: ${JSON.stringify(enriched)}\n\n`);
  }
}

async function readBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString('utf8');

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function configForRun(overrides = {}) {
  return configFromEnv(apiKey, {
    visitorCountry: overrides.visitorCountry,
    matchConcurrency: overrides.matchConcurrency,
    intervalMs: overrides.intervalMs,
    fastFetchConcurrency: overrides.fastFetchConcurrency,
    fastPollEnabled: overrides.fastPollEnabled,
    fullDiscoveryEvery: overrides.fullDiscoveryEvery,
    matchJobAttempts: overrides.matchJobAttempts,
  });
}

function shouldRunFullDiscovery(config, previousState, overrides = {}) {
  if (overrides.fullDiscovery) {
    return true;
  }

  if (!config.fastPollEnabled) {
    return true;
  }

  if (knownTargetsFromPreviousState(previousState, config.shopUrl).length === 0) {
    return true;
  }

  const previousTick = Number(previousState?.lastCycleSummary?.tick || 0);
  return config.fullDiscoveryEvery > 0 && previousTick > 0 && previousTick % config.fullDiscoveryEvery === 0;
}

async function runOneCycle(overrides = {}) {
  if (jobState.running) {
    throw new Error('A cycle is already running.');
  }

  const config = configForRun(overrides);
  const previousState = loadPreviousState(config.statePath);
  const fullDiscovery = shouldRunFullDiscovery(config, previousState, overrides);
  jobState.running = true;
  jobState.startedAt = new Date().toISOString();
  jobState.completedAt = null;
  jobState.lastError = null;
  broadcast({
    event: 'dashboard_cycle_started',
    visitorCountry: config.visitorCountry,
    matchConcurrency: config.matchConcurrency,
    mode: fullDiscovery ? 'browser-discovery' : 'fast-target-poll',
  });

  try {
    let cycle;

    if (fullDiscovery) {
      cycle = await runFifaCycle(config, previousState, broadcast);
    } else {
      try {
        cycle = await runFifaFastCycle(config, previousState, broadcast);

        if (cycle.rowCount === 0 || cycle.failedMatchCount >= cycle.matchCardsScanned) {
          throw new Error('Fast poll returned no usable ticket rows.');
        }
      } catch (error) {
        broadcast({
          event: 'fast_cycle_failed_fallback',
          error: error.message,
        });
        cycle = await runFifaCycle(config, previousState, broadcast);
      }
    }

    const paths = persistCycle(cycle, config);
    jobState.completedAt = cycle.cycleCompletedAt;
    broadcast({
      event: 'dashboard_cycle_completed',
      mode: cycle.mode,
      matchCardsFound: cycle.matchCardsFound,
      matchCardsScanned: cycle.matchCardsScanned,
      failedMatchCount: cycle.failedMatchCount,
      partial: cycle.partial,
      rowCount: cycle.rowCount,
      availableRowCount: cycle.availableRowCount,
      alertCount: cycle.alerts.length,
      latestCyclePath: paths.latestCyclePath,
      historyPath: paths.historyPath,
    });
    return { cycle, paths };
  } catch (error) {
    jobState.lastError = error.message;
    broadcast({
      event: 'dashboard_cycle_failed',
      error: error.message,
    });
    throw error;
  } finally {
    jobState.running = false;
  }
}

async function tickerLoop(overrides = {}) {
  while (jobState.tickerRunning) {
    const startedAt = Date.now();

    try {
      await runOneCycle(overrides);
    } catch {
      // Error already broadcast.
    }

    const intervalMs = Number(overrides.intervalMs || jobState.tickerIntervalMs || 60000);
    const remaining = Math.max(0, intervalMs - (Date.now() - startedAt));
    await sleep(remaining);
  }
}

function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const pathname = ['/', '/admin'].includes(url.pathname) ? '/index.html' : url.pathname;
  const filePath = resolve(join(staticRoot, pathname));

  if (!filePath.startsWith(staticRoot) || !existsSync(filePath)) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }

  const type = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
  }[extname(filePath)] || 'application/octet-stream';

  response.writeHead(200, { 'content-type': type });
  response.end(readFileSync(filePath));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (url.pathname === '/events') {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    response.write(`data: ${JSON.stringify({ event: 'connected', emittedAt: new Date().toISOString() })}\n\n`);
    clients.add(response);
    request.on('close', () => clients.delete(response));
    return;
  }

  if (url.pathname === '/api/state' && request.method === 'GET') {
    sendJson(response, 200, latestState());
    return;
  }

  if (url.pathname === '/api/run-cycle' && request.method === 'POST') {
    if (jobState.running) {
      sendJson(response, 409, { accepted: false, error: 'A cycle is already running.', job: jobState });
      return;
    }

    const body = await readBody(request);
    runOneCycle(body).catch(() => {});
    sendJson(response, 202, { accepted: true, job: jobState });
    return;
  }

  if (url.pathname === '/api/start-ticker' && request.method === 'POST') {
    const body = await readBody(request);

    if (!jobState.tickerRunning) {
      jobState.tickerRunning = true;
      jobState.tickerIntervalMs = Number(body.intervalMs || jobState.tickerIntervalMs || 60000);
      broadcast({
        event: 'dashboard_ticker_started',
        intervalMs: jobState.tickerIntervalMs,
      });
      tickerLoop(body).catch(() => {});
    }

    sendJson(response, 202, { accepted: true, job: jobState });
    return;
  }

  if (url.pathname === '/api/stop-ticker' && request.method === 'POST') {
    jobState.tickerRunning = false;
    broadcast({ event: 'dashboard_ticker_stopped' });
    sendJson(response, 202, { accepted: true, job: jobState });
    return;
  }

  serveStatic(request, response);
});

server.listen(port, host, () => {
  console.log(`Dashboard listening on http://${host}:${port}`);

  if (autostartTicker && !jobState.tickerRunning) {
    jobState.tickerRunning = true;
    broadcast({
      event: 'dashboard_ticker_started',
      intervalMs: jobState.tickerIntervalMs,
      autostart: true,
    });
    tickerLoop({}).catch(() => {});
  }
});
