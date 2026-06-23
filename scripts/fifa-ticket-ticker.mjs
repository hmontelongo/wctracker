import { loadDotEnv, requireEnv } from './lib/env.mjs';
import { sleep } from './lib/cdp.mjs';
import {
  configFromEnv,
  loadPreviousState,
  persistCycle,
  runFifaCycle,
} from './lib/fifa-job-system.mjs';

loadDotEnv();

const apiKey = requireEnv('ZENROWS_API_KEY');
const config = configFromEnv(apiKey);

console.log(JSON.stringify({
  event: 'ticker_start',
  mode: 'coordinator_plus_parallel_match_jobs',
  endpoint: config.publicBrowserUrl,
  shopUrl: config.shopUrl,
  visitorCountry: config.visitorCountry,
  intervalMs: config.intervalMs,
  maxTicks: config.maxTicks,
  matchConcurrency: config.matchConcurrency,
}));

let tick = 0;

while (config.maxTicks === 0 || tick < config.maxTicks) {
  tick += 1;
  const previousState = loadPreviousState(config.statePath);
  const cycle = await runFifaCycle(config, previousState, (event) => {
    if (
      event.event === 'cycle_started' ||
      event.event === 'coordinator_completed' ||
      event.event === 'match_job_result' ||
      event.event === 'cycle_completed'
    ) {
      console.error(JSON.stringify(event));
    }
  });
  const paths = persistCycle(cycle, config);

  console.log(JSON.stringify({
    event: cycle.alerts.length > 0 ? 'availability_alert' : 'availability_check',
    tick,
    cycleStartedAt: cycle.cycleStartedAt,
    cycleCompletedAt: cycle.cycleCompletedAt,
    visitorCountry: config.visitorCountry,
    matchCardsFound: cycle.matchCardsFound,
    matchCardsScanned: cycle.matchCardsScanned,
    matchConcurrency: config.matchConcurrency,
    rowCount: cycle.rowCount,
    availableRowCount: cycle.availableRowCount,
    alertCount: cycle.alerts.length,
    alerts: cycle.alerts,
    latestCyclePath: paths.latestCyclePath,
    historyPath: paths.historyPath,
  }));

  if (config.maxTicks !== 0 && tick >= config.maxTicks) {
    break;
  }

  const jitterMs = Math.floor(Math.random() * Math.min(5000, Math.max(1000, config.intervalMs / 10)));
  await sleep(config.intervalMs + jitterMs);
}
