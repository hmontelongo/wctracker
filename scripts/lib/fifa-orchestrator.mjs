import { createHash, randomUUID } from 'node:crypto';
import {
  buildCycleFromMatchResults,
  createBrowserSession,
  discoverMatchJobs,
  loadPreviousState,
  openShopAndChooseCountry,
  persistCycle,
  runMatchJobWithRetries,
} from './fifa-job-system.mjs';
import {
  claimNextMatchJob,
  completeMatchJob,
  readLatestMatchJobResults,
  readQueueStats,
  recordDiscoveryResult,
  releaseLock,
  tryAcquireLock,
} from './sqlite-store.mjs';

function jobKeyForCard(config, card) {
  const hash = createHash('sha256')
    .update([config.shopUrl, card.matchCode || '', card.text || ''].join('|'))
    .digest('hex')
    .slice(0, 16);

  return `${config.shopUrl}|${card.matchCode || 'unknown'}|${hash}`;
}

function owner(prefix) {
  return `${prefix}:${process.pid}:${randomUUID()}`;
}

function durableDiscoveryPayload(config, discovery, startedAt, completedAt, error = null) {
  return {
    ...discovery,
    startedAt,
    completedAt,
    error: error?.message || error || null,
    allCards: (discovery?.allCards || []).map((card) => ({
      ...card,
      jobKey: jobKeyForCard(config, card),
    })),
    jobs: (discovery?.jobs || []).map((card) => ({
      ...card,
      jobKey: jobKeyForCard(config, card),
    })),
  };
}

export async function runDiscoveryOnce(config, emit = () => {}) {
  const lockOwner = owner('discovery');
  const acquired = tryAcquireLock('fifa.discovery', lockOwner, config.discoveryLeaseMs);

  if (!acquired) {
    emit({ event: 'discovery_skipped_locked' });
    return { acquired: false };
  }

  const startedAt = new Date().toISOString();
  emit({ event: 'discovery_started', startedAt });

  try {
    const discovery = await discoverMatchJobs(config, emit);
    const completedAt = new Date().toISOString();
    const stored = recordDiscoveryResult(
      durableDiscoveryPayload(config, discovery, startedAt, completedAt),
      config,
    );
    emit({
      event: 'discovery_completed',
      discoveryRunId: stored.discoveryRunId,
      cardsFound: stored.cardsFound,
      jobsSeen: stored.jobsSeen,
      jobsInserted: stored.jobsInserted,
      completedAt,
    });

    return {
      acquired: true,
      ok: true,
      ...stored,
    };
  } catch (error) {
    const completedAt = new Date().toISOString();
    recordDiscoveryResult(
      durableDiscoveryPayload(config, { allCards: [], jobs: [] }, startedAt, completedAt, error),
      config,
    );
    emit({
      event: 'discovery_failed',
      error: error.message,
      completedAt,
    });
    return {
      acquired: true,
      ok: false,
      error: error.message,
    };
  } finally {
    releaseLock('fifa.discovery', lockOwner);
  }
}

async function openWorkerSession(config, workerIndex, emit) {
  const session = await createBrowserSession(config);
  emit({
    event: 'match_worker_started',
    workerIndex: workerIndex + 1,
    totalWorkers: config.matchConcurrency,
  });
  await openShopAndChooseCountry(session.cdp, session.sessionId, config, emit);

  return session;
}

export async function runWorkerPoolOnce(config, emit = () => {}) {
  let processed = 0;
  let claimed = 0;
  const workerCount = Math.max(1, Number(config.matchConcurrency || 1));

  async function runWorker(workerIndex) {
    const workerOwner = owner(`match-worker-${workerIndex + 1}`);
    let session = null;

    try {
      while (true) {
        const job = claimNextMatchJob(workerOwner, config.jobLeaseMs);

        if (!job) {
          break;
        }

        claimed += 1;
        emit({
          event: 'match_job_claimed',
          jobId: job.id,
          matchCode: job.match_code || job.card?.matchCode,
          attempt: job.attempts,
          workerIndex: workerIndex + 1,
        });

        let result;

        try {
          session ??= await openWorkerSession(config, workerIndex, emit);
          result = await runMatchJobWithRetries(config, session, job.card, emit);
        } catch (error) {
          result = {
            checkedAt: new Date().toISOString(),
            card: job.card,
            ok: false,
            error: error.message,
            response: null,
            target: null,
            availability: null,
            rawTicketTypes: null,
          };
        }

        const completion = completeMatchJob(job.id, workerOwner, result, {
          retryDelayMs: config.jobRetryDelayMs,
        });
        processed += completion.updated ? 1 : 0;
        emit({
          event: 'match_job_stored',
          jobId: job.id,
          matchCode: job.match_code || job.card?.matchCode,
          ok: result.ok,
          rows: result.availability?.rowCount ?? 0,
          availableRows: result.availability?.availableRows?.length ?? 0,
          status: completion.status,
          willRetry: completion.willRetry,
          error: result.error,
          workerIndex: workerIndex + 1,
        });
      }
    } finally {
      await session?.close();
      emit({
        event: 'match_worker_finished',
        workerIndex: workerIndex + 1,
      });
    }
  }

  await Promise.all(Array.from({ length: workerCount }, (_, index) => runWorker(index)));

  return {
    claimed,
    processed,
  };
}

export function publishLatestCycleFromQueue(config, emit = () => {}) {
  const matchResults = readLatestMatchJobResults();

  if (matchResults.length === 0) {
    return null;
  }

  const previousState = loadPreviousState(config.statePath);
  const queueStats = readQueueStats();
  const latestDiscovery = queueStats.latestDiscovery || null;
  const cycleStartedAt = latestDiscovery?.started_at || new Date().toISOString();
  const cycle = buildCycleFromMatchResults(config, previousState, matchResults, {
    cycleStartedAt,
    cycleCompletedAt: new Date().toISOString(),
    mode: 'job-queue',
    transport: 'ZenRows Scraping Browser job queue',
    matchCardsFound: latestDiscovery?.cards_found ?? matchResults.length,
    matchCardsScanned: matchResults.length,
  });
  const paths = persistCycle(cycle, config);

  emit({
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
    queue: queueStats.jobsByStatus,
  });

  return {
    cycle,
    paths,
    queueStats,
  };
}
