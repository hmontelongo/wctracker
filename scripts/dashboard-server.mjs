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
} from './lib/fifa-job-system.mjs';
import {
  publishLatestCycleFromQueue,
  runDiscoveryOnce,
  runWorkerPoolOnce,
} from './lib/fifa-orchestrator.mjs';
import {
  backfillSqliteFromJson,
  createAlertRule,
  deleteAlertRule,
  listAlertRules,
  readLatestFromSqlite,
  readNotificationStats,
  readQueueStats,
  readTelegramSettings,
  updateTelegramSettings,
} from './lib/sqlite-store.mjs';
import {
  runTelegramNotifyOnce,
  sendTelegramRuleEvent,
  telegramConfigFromEnv,
  telegramReady,
} from './lib/telegram-notifier.mjs';

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
  discoveryLoopRunning: false,
  workerLoopRunning: false,
  telegramLoopRunning: false,
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
    queue: readQueueStats(),
    notifications: {
      telegramReady: telegramReady(telegramConfigFromEnv()),
      telegram: readNotificationStats(),
      settings: readTelegramSettings(),
    },
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
    discoveryIntervalMs: overrides.discoveryIntervalMs,
    discoveryLeaseMs: overrides.discoveryLeaseMs,
    jobLeaseMs: overrides.jobLeaseMs,
    jobRetryDelayMs: overrides.jobRetryDelayMs,
    queueJobAttempts: overrides.queueJobAttempts,
    workerIdleMs: overrides.workerIdleMs,
  });
}

async function sendRuleConfirmation(type, rule, row = null) {
  try {
    return await sendTelegramRuleEvent(telegramConfigFromEnv(), { type, rule, row });
  } catch (error) {
    return { sent: false, skipped: false, error: error.message };
  }
}

async function notifyTelegramOnce(reason) {
  const config = telegramConfigFromEnv();
  const owner = `telegram-dashboard-${process.pid}-immediate`;

  try {
    const result = await runTelegramNotifyOnce({ config, owner });

    if (result.claimed || result.sent || result.failed) {
      broadcast({
        event: 'telegram_notify_immediate',
        reason,
        claimed: result.claimed,
        sent: result.sent,
        failed: result.failed,
        ready: result.ready,
      });
    }

    return result;
  } catch (error) {
    jobState.lastError = error.message;
    broadcast({ event: 'telegram_notify_error', reason, error: error.message });
    return { sent: 0, failed: 0, claimed: 0, error: error.message };
  }
}

async function runOneSweep(overrides = {}) {
  const config = configForRun(overrides);
  jobState.running = true;
  jobState.startedAt = new Date().toISOString();
  jobState.completedAt = null;
  jobState.lastError = null;
  broadcast({
    event: 'dashboard_sweep_started',
    visitorCountry: config.visitorCountry,
    matchConcurrency: config.matchConcurrency,
    discoveryIntervalMs: config.discoveryIntervalMs,
  });

  try {
    await runDiscoveryOnce(config, broadcast);
    const sweep = await runWorkerPoolOnce(config, broadcast);
    const published = publishLatestCycleFromQueue(config, broadcast);
    await notifyTelegramOnce('dashboard_sweep_published');
    jobState.completedAt = published?.cycle?.cycleCompletedAt || new Date().toISOString();
    return { sweep, published };
  } catch (error) {
    jobState.lastError = error.message;
    broadcast({
      event: 'dashboard_sweep_failed',
      error: error.message,
    });
    throw error;
  } finally {
    jobState.running = false;
  }
}

async function fastPollLoop(overrides = {}) {
  jobState.workerLoopRunning = true;
  let lastDiscoveryAt = 0;

  try {
    while (jobState.tickerRunning) {
      const config = configForRun(overrides);
      const startedAt = Date.now();
      const previousState = loadPreviousState(config.statePath);
      const knownTargets = knownTargetsFromPreviousState(previousState, config.shopUrl);
      const discoveryStale = Date.now() - lastDiscoveryAt > config.discoveryIntervalMs;
      let discoveryResult = null;

      if (knownTargets.length === 0 || discoveryStale) {
        try {
          discoveryResult = await runDiscoveryOnce(config, broadcast);
          lastDiscoveryAt = Date.now();
        } catch (error) {
          jobState.lastError = error.message;
          broadcast({ event: 'discovery_loop_error', error: error.message });
        }
      }

      try {
        if (knownTargets.length === 0 || Number(discoveryResult?.jobsInserted || 0) > 0) {
          const sweep = await runWorkerPoolOnce(config, broadcast);
          const published = publishLatestCycleFromQueue(config, broadcast);
          await notifyTelegramOnce('bootstrap_cycle_published');
          jobState.completedAt = published?.cycle?.cycleCompletedAt || jobState.completedAt;
          if (published?.cycle) {
            jobState.lastError = null;
          }
          const bootstrappedState = loadPreviousState(config.statePath);
          const bootstrappedTargets = knownTargetsFromPreviousState(bootstrappedState, config.shopUrl);

          if (bootstrappedTargets.length === 0) {
            broadcast({
              event: 'fast_poll_bootstrap_waiting',
              reason: 'No known targets available after discovery/bootstrap.',
              jobsInserted: discoveryResult?.jobsInserted || 0,
              jobsProcessed: sweep?.processed || 0,
            });
            const elapsed = Date.now() - startedAt;
            const remaining = Math.max(0, config.intervalMs - elapsed);
            await sleep(remaining);
            continue;
          }

          if (knownTargets.length === 0 || Number(sweep?.processed || 0) > 0) {
            const elapsed = Date.now() - startedAt;
            const remaining = Math.max(0, config.intervalMs - elapsed);
            await sleep(remaining);
            continue;
          }
        }

        const freshState = loadPreviousState(config.statePath);
        const cycle = await runFifaFastCycle(config, freshState, broadcast);
        persistCycle(cycle, config);
        await notifyTelegramOnce('fast_poll_cycle_published');
        jobState.completedAt = cycle.cycleCompletedAt;
        jobState.lastError = null;
      } catch (error) {
        jobState.lastError = error.message;
        broadcast({ event: 'worker_loop_error', workerIndex: 1, error: error.message });
      }

      const elapsed = Date.now() - startedAt;
      const remaining = Math.max(0, config.intervalMs - elapsed);
      await sleep(remaining);
    }
  } finally {
    jobState.workerLoopRunning = false;
  }
}

async function telegramLoop() {
  const owner = `telegram-dashboard-${process.pid}`;
  jobState.telegramLoopRunning = true;

  try {
    while (true) {
      const config = telegramConfigFromEnv();

      try {
        const result = await runTelegramNotifyOnce({ config, owner });

        if (result.claimed || result.sent || result.failed) {
          broadcast({
            event: 'telegram_notify_tick',
            claimed: result.claimed,
            sent: result.sent,
            failed: result.failed,
            ready: result.ready,
          });
        }
      } catch (error) {
        jobState.lastError = error.message;
        broadcast({ event: 'telegram_notify_error', error: error.message });
      }

      await sleep(config.intervalMs);
    }
  } finally {
    jobState.telegramLoopRunning = false;
  }
}

function startTicker(overrides = {}) {
  if (jobState.tickerRunning) {
    return false;
  }

  const config = configForRun(overrides);
  jobState.tickerRunning = true;
  jobState.running = true;
  jobState.startedAt = new Date().toISOString();
  jobState.completedAt = null;
  jobState.tickerIntervalMs = config.intervalMs;
  broadcast({
    event: 'dashboard_ticker_started',
    intervalMs: config.intervalMs,
    discoveryIntervalMs: config.discoveryIntervalMs,
    workerIdleMs: config.workerIdleMs,
    mode: 'fast-poll',
    autostart: Boolean(overrides.autostart),
  });
  fastPollLoop(overrides).catch(() => {});

  return true;
}

async function tickerLoop(overrides = {}) {
  while (jobState.tickerRunning) {
    const startedAt = Date.now();

    try {
      await runOneSweep(overrides);
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
    '.svg': 'image/svg+xml',
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

  if (url.pathname === '/api/alert-rules' && request.method === 'GET') {
    sendJson(response, 200, { rules: listAlertRules() });
    return;
  }

  if (url.pathname === '/api/telegram-settings' && request.method === 'GET') {
    sendJson(response, 200, { settings: readTelegramSettings() });
    return;
  }

  if (url.pathname === '/api/telegram-settings' && request.method === 'POST') {
    try {
      const body = await readBody(request);
      const settings = updateTelegramSettings(body);
      broadcast({
        event: 'telegram_settings_updated',
        globalAlertsEnabled: settings.globalAlertsEnabled,
      });
      sendJson(response, 200, { settings });
    } catch (error) {
      sendJson(response, 422, { error: error.message });
    }
    return;
  }

  if (url.pathname === '/api/alert-rules' && request.method === 'POST') {
    try {
      const body = await readBody(request);
      const rule = createAlertRule(body);
      const telegramConfirmation = await sendRuleConfirmation('created', rule, body.row || body.ticket || null);
      sendJson(response, 201, { rule, telegramConfirmation });
    } catch (error) {
      sendJson(response, 422, { error: error.message });
    }
    return;
  }

  const alertRuleDelete = url.pathname.match(/^\/api\/alert-rules\/(\d+)$/);
  if (alertRuleDelete && request.method === 'DELETE') {
    const rule = deleteAlertRule(alertRuleDelete[1]);
    const telegramConfirmation = rule
      ? await sendRuleConfirmation('deleted', rule)
      : null;
    sendJson(response, rule ? 200 : 404, { deleted: Boolean(rule), rule, telegramConfirmation });
    return;
  }

  if (url.pathname === '/api/run-cycle' && request.method === 'POST') {
    if (jobState.tickerRunning) {
      sendJson(response, 409, { accepted: false, error: 'The scheduler is already running.', job: jobState });
      return;
    }

    const body = await readBody(request);
    runOneSweep(body).catch(() => {});
    sendJson(response, 202, { accepted: true, job: jobState });
    return;
  }

  if (url.pathname === '/api/start-ticker' && request.method === 'POST') {
    const body = await readBody(request);

    startTicker(body);

    sendJson(response, 202, { accepted: true, job: jobState });
    return;
  }

  if (url.pathname === '/api/stop-ticker' && request.method === 'POST') {
    jobState.tickerRunning = false;
    jobState.running = false;
    broadcast({ event: 'dashboard_ticker_stopped' });
    sendJson(response, 202, { accepted: true, job: jobState });
    return;
  }

  serveStatic(request, response);
});

server.listen(port, host, () => {
  console.log(`Dashboard listening on http://${host}:${port}`);

  if (telegramConfigFromEnv().enabled) {
    telegramLoop().catch(() => {});
  }

  if (autostartTicker && !jobState.tickerRunning) {
    startTicker({ autostart: true });
  }
});
