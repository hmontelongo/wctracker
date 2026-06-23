import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DEFAULT_SQLITE_PATH = 'artifacts/worldcup.sqlite';

function dbPath(path = process.env.FIFA_SQLITE_PATH || DEFAULT_SQLITE_PATH) {
  return resolve(process.cwd(), path);
}

function openDatabase(path) {
  const fullPath = dbPath(path);
  mkdirSync(dirname(fullPath), { recursive: true });
  const db = new DatabaseSync(fullPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);

  if (!columns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function isoNow() {
  return new Date().toISOString();
}

function toMs(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

export function initSqlite(path) {
  const db = openDatabase(path);

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cycles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tick INTEGER,
        mode TEXT,
        cycle_started_at TEXT NOT NULL,
        cycle_completed_at TEXT NOT NULL,
        visitor_country TEXT,
        match_cards_found INTEGER NOT NULL DEFAULT 0,
        match_cards_scanned INTEGER NOT NULL DEFAULT 0,
        failed_match_count INTEGER NOT NULL DEFAULT 0,
        row_count INTEGER NOT NULL DEFAULT 0,
        available_row_count INTEGER NOT NULL DEFAULT 0,
        alert_count INTEGER NOT NULL DEFAULT 0,
        partial INTEGER NOT NULL DEFAULT 0,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE UNIQUE INDEX IF NOT EXISTS cycles_started_unique
        ON cycles (cycle_started_at);

      CREATE TABLE IF NOT EXISTS latest_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state_json TEXT NOT NULL,
        latest_cycle_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ticket_rows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cycle_started_at TEXT NOT NULL,
        checked_at TEXT,
        match_code TEXT,
        performance_id TEXT,
        teams TEXT,
        venue TEXT,
        city TEXT,
        country TEXT,
        match_date TEXT,
        lounge_id TEXT,
        package_title TEXT,
        seating_code TEXT,
        seating_name TEXT,
        price_mxn INTEGER,
        available INTEGER NOT NULL DEFAULT 0,
        available_quantity INTEGER NOT NULL DEFAULT 0,
        availability_freshness TEXT,
        became_available_at TEXT,
        last_changed_at TEXT,
        last_alert_at TEXT,
        alert_reason TEXT,
        fifa_shop_url TEXT,
        row_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        FOREIGN KEY (cycle_started_at) REFERENCES cycles(cycle_started_at)
          ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS ticket_rows_cycle_idx
        ON ticket_rows (cycle_started_at);

      CREATE INDEX IF NOT EXISTS ticket_rows_row_key_idx
        ON ticket_rows (row_key);

      CREATE INDEX IF NOT EXISTS ticket_rows_available_idx
        ON ticket_rows (available, match_code);

      CREATE TABLE IF NOT EXISTS runtime_locks (
        name TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS discovery_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        visitor_country TEXT,
        shop_url TEXT,
        cards_found INTEGER NOT NULL DEFAULT 0,
        jobs_created INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        payload_json TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS discovery_runs_started_idx
        ON discovery_runs (started_at);

      CREATE TABLE IF NOT EXISTS match_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        discovery_run_id INTEGER,
        job_key TEXT NOT NULL,
        match_code TEXT,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        available_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        checked_at TEXT,
        last_error TEXT,
        card_json TEXT NOT NULL,
        target_json TEXT,
        result_json TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (discovery_run_id) REFERENCES discovery_runs(id)
          ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS match_jobs_status_available_idx
        ON match_jobs (status, available_at);

      CREATE INDEX IF NOT EXISTS match_jobs_match_code_idx
        ON match_jobs (match_code);

      CREATE UNIQUE INDEX IF NOT EXISTS match_jobs_active_key_unique
        ON match_jobs (job_key)
        WHERE status IN ('pending', 'running');

      CREATE TABLE IF NOT EXISTS alert_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        row_key TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_at TEXT NOT NULL,
        match_code TEXT,
        package_title TEXT,
        seating_code TEXT,
        available_quantity INTEGER,
        price_mxn INTEGER,
        notified_at TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE UNIQUE INDEX IF NOT EXISTS alert_events_unique
        ON alert_events (row_key, event_type, event_at);
    `);
    ensureColumn(db, 'ticket_rows', 'country', 'TEXT');
    ensureColumn(db, 'ticket_rows', 'last_alert_at', 'TEXT');
    ensureColumn(db, 'ticket_rows', 'alert_reason', 'TEXT');
  } finally {
    db.close();
  }
}

function readJson(path, fallback = null) {
  if (!existsSync(path)) {
    return fallback;
  }

  return JSON.parse(readFileSync(path, 'utf8'));
}

function rowKey(row) {
  return [
    row.matchCode,
    row.performanceId,
    row.loungeId,
    row.seatingCode,
    row.priceMxn,
  ].join('|');
}

export function stateFromCycle(cycle, latestCyclePath = 'artifacts/fifa-cycle-latest.json') {
  return {
    lastTickAt: cycle.cycleCompletedAt,
    transport: cycle.transport,
    mode: cycle.mode,
    shopUrl: cycle.shopUrl,
    visitorCountry: cycle.visitorCountry,
    alertRetentionMs: cycle.alertRetentionMs,
    knownTargets: cycle.knownTargets,
    latestRows: cycle.rows,
    latestAvailableRows: cycle.availableRows,
    latestCyclePath,
    lastCycleSummary: {
      tick: cycle.tick,
      mode: cycle.mode,
      cycleStartedAt: cycle.cycleStartedAt,
      cycleCompletedAt: cycle.cycleCompletedAt,
      matchCardsFound: cycle.matchCardsFound,
      matchCardsScanned: cycle.matchCardsScanned,
      failedMatchCount: cycle.failedMatchCount,
      partial: cycle.partial,
      rowCount: cycle.rowCount,
      availableRowCount: cycle.availableRowCount,
      alertCount: cycle.alerts.length,
      alertRetentionMs: cycle.alertRetentionMs,
    },
  };
}

export function persistCycleToSqlite(cycle, options = {}) {
  initSqlite(options.sqlitePath);
  const db = openDatabase(options.sqlitePath);
  const latestCyclePath = options.latestCyclePath || 'artifacts/fifa-cycle-latest.json';
  const state = options.state || stateFromCycle(cycle, latestCyclePath);

  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare(`
      INSERT INTO cycles (
        tick,
        mode,
        cycle_started_at,
        cycle_completed_at,
        visitor_country,
        match_cards_found,
        match_cards_scanned,
        failed_match_count,
        row_count,
        available_row_count,
        alert_count,
        partial,
        payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cycle_started_at) DO UPDATE SET
        tick = excluded.tick,
        mode = excluded.mode,
        cycle_completed_at = excluded.cycle_completed_at,
        visitor_country = excluded.visitor_country,
        match_cards_found = excluded.match_cards_found,
        match_cards_scanned = excluded.match_cards_scanned,
        failed_match_count = excluded.failed_match_count,
        row_count = excluded.row_count,
        available_row_count = excluded.available_row_count,
        alert_count = excluded.alert_count,
        partial = excluded.partial,
        payload_json = excluded.payload_json
    `).run(
      cycle.tick ?? null,
      cycle.mode ?? null,
      cycle.cycleStartedAt,
      cycle.cycleCompletedAt,
      cycle.visitorCountry ?? null,
      cycle.matchCardsFound ?? 0,
      cycle.matchCardsScanned ?? 0,
      cycle.failedMatchCount ?? 0,
      cycle.rowCount ?? 0,
      cycle.availableRowCount ?? 0,
      cycle.alerts?.length ?? 0,
      cycle.partial ? 1 : 0,
      JSON.stringify(cycle),
    );

    db.prepare('DELETE FROM ticket_rows WHERE cycle_started_at = ?').run(cycle.cycleStartedAt);
    const insertRow = db.prepare(`
      INSERT INTO ticket_rows (
        cycle_started_at,
        checked_at,
        match_code,
        performance_id,
        teams,
        venue,
        city,
        country,
        match_date,
        lounge_id,
        package_title,
        seating_code,
        seating_name,
        price_mxn,
        available,
        available_quantity,
        availability_freshness,
        became_available_at,
        last_changed_at,
        last_alert_at,
        alert_reason,
        fifa_shop_url,
        row_key,
        payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const row of cycle.rows || []) {
      insertRow.run(
        cycle.cycleStartedAt,
        row.checkedAt ?? null,
        row.matchCode ?? null,
        row.performanceId ?? null,
        row.teams ?? null,
        row.venue ?? null,
        row.city ?? null,
        row.country ?? null,
        row.matchDate ?? null,
        row.loungeId ?? null,
        row.packageTitle ?? null,
        row.seatingCode ?? null,
        row.seatingName ?? null,
        row.priceMxn ?? null,
        row.available ? 1 : 0,
        Number(row.availableQuantity ?? 0),
        row.availabilityFreshness ?? null,
        row.becameAvailableAt ?? null,
        row.lastChangedAt ?? null,
        row.lastAlertAt ?? null,
        row.alertReason ?? null,
        row.fifaShopUrl ?? null,
        rowKey(row),
        JSON.stringify(row),
      );
    }

    const insertAlert = db.prepare(`
      INSERT INTO alert_events (
        row_key,
        event_type,
        event_at,
        match_code,
        package_title,
        seating_code,
        available_quantity,
        price_mxn,
        payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(row_key, event_type, event_at) DO NOTHING
    `);

    for (const row of cycle.alerts || []) {
      const eventAt = row.lastAlertAt || row.lastChangedAt || row.checkedAt || cycle.cycleCompletedAt;
      const eventType = row.alertReason || row.availabilityFreshness || 'availability';

      insertAlert.run(
        rowKey(row),
        eventType,
        eventAt,
        row.matchCode ?? null,
        row.packageTitle ?? null,
        row.seatingCode ?? null,
        Number(row.availableQuantity ?? 0),
        row.priceMxn ?? null,
        JSON.stringify(row),
      );
    }

    db.prepare(`
      INSERT INTO latest_state (id, state_json, latest_cycle_json, updated_at)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        state_json = excluded.state_json,
        latest_cycle_json = excluded.latest_cycle_json,
        updated_at = excluded.updated_at
    `).run(
      JSON.stringify(state),
      JSON.stringify(cycle),
      cycle.cycleCompletedAt,
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}

export function readLatestFromSqlite(options = {}) {
  initSqlite(options.sqlitePath);
  const db = openDatabase(options.sqlitePath);

  try {
    const row = db.prepare('SELECT state_json, latest_cycle_json FROM latest_state WHERE id = 1').get();

    if (!row) {
      return {
        state: null,
        latestCycle: null,
      };
    }

    return {
      state: JSON.parse(row.state_json),
      latestCycle: JSON.parse(row.latest_cycle_json),
    };
  } finally {
    db.close();
  }
}

export function readPreviousStateFromSqlite(options = {}) {
  return readLatestFromSqlite(options).state;
}

export function backfillSqliteFromJson(options = {}) {
  const latestCycle = options.latestCycle || readJson(options.latestCyclePath || 'artifacts/fifa-cycle-latest.json');

  if (!latestCycle) {
    initSqlite(options.sqlitePath);
    return false;
  }

  const state = options.state || readJson(options.statePath || 'artifacts/fifa-ticket-state.json')
    || stateFromCycle(latestCycle, options.latestCyclePath);
  persistCycleToSqlite(latestCycle, {
    sqlitePath: options.sqlitePath,
    latestCyclePath: options.latestCyclePath,
    state,
  });

  return true;
}

export function tryAcquireLock(name, owner, ttlMs, options = {}) {
  initSqlite(options.sqlitePath);
  const db = openDatabase(options.sqlitePath);
  const now = isoNow();
  const leaseExpiresAt = new Date(Date.now() + ttlMs).toISOString();

  try {
    db.exec('BEGIN IMMEDIATE');
    const existing = db.prepare('SELECT owner, lease_expires_at FROM runtime_locks WHERE name = ?').get(name);

    if (existing && existing.owner !== owner && toMs(existing.lease_expires_at) > Date.now()) {
      db.exec('COMMIT');
      return false;
    }

    db.prepare(`
      INSERT INTO runtime_locks (name, owner, lease_expires_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        owner = excluded.owner,
        lease_expires_at = excluded.lease_expires_at,
        updated_at = excluded.updated_at
    `).run(name, owner, leaseExpiresAt, now);
    db.exec('COMMIT');
    return true;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}

export function releaseLock(name, owner, options = {}) {
  initSqlite(options.sqlitePath);
  const db = openDatabase(options.sqlitePath);

  try {
    db.prepare('DELETE FROM runtime_locks WHERE name = ? AND owner = ?').run(name, owner);
  } finally {
    db.close();
  }
}

export function recordDiscoveryResult(discovery, config, options = {}) {
  initSqlite(options.sqlitePath);
  const db = openDatabase(options.sqlitePath);
  const now = isoNow();
  const startedAt = discovery.startedAt || now;
  const completedAt = discovery.completedAt || now;
  const cards = discovery.allCards || [];
  const jobs = discovery.jobs || [];
  const maxAttempts = Math.max(1, Number(config.queueJobAttempts || config.matchJobAttempts || 3));

  try {
    db.exec('BEGIN IMMEDIATE');
    const result = db.prepare(`
      INSERT INTO discovery_runs (
        status,
        started_at,
        completed_at,
        visitor_country,
        shop_url,
        cards_found,
        jobs_created,
        error,
        payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      discovery.error ? 'failed' : 'completed',
      startedAt,
      completedAt,
      config.visitorCountry ?? null,
      config.shopUrl ?? null,
      cards.length,
      jobs.length,
      discovery.error ?? null,
      JSON.stringify(discovery),
    );
    const discoveryRunId = Number(result.lastInsertRowid);
    const insertJob = db.prepare(`
      INSERT INTO match_jobs (
        discovery_run_id,
        job_key,
        match_code,
        status,
        max_attempts,
        available_at,
        card_json,
        updated_at
      ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)
      ON CONFLICT(job_key) WHERE status IN ('pending', 'running') DO NOTHING
    `);
    let inserted = 0;

    for (const job of jobs) {
      const insertResult = insertJob.run(
        discoveryRunId,
        job.jobKey,
        job.matchCode ?? null,
        maxAttempts,
        now,
        JSON.stringify(job),
        now,
      );
      inserted += Number(insertResult.changes || 0);
    }

    db.exec('COMMIT');
    return {
      discoveryRunId,
      cardsFound: cards.length,
      jobsSeen: jobs.length,
      jobsInserted: inserted,
    };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}

export function claimNextMatchJob(owner, leaseMs, options = {}) {
  initSqlite(options.sqlitePath);
  const db = openDatabase(options.sqlitePath);
  const now = isoNow();
  const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();

  try {
    db.exec('BEGIN IMMEDIATE');
    const job = db.prepare(`
      SELECT *
      FROM match_jobs
      WHERE (
        status = 'pending'
        OR (status = 'running' AND lease_expires_at <= ?)
      )
      AND available_at <= ?
      AND attempts < max_attempts
      ORDER BY available_at ASC, id ASC
      LIMIT 1
    `).get(now, now);

    if (!job) {
      db.exec('COMMIT');
      return null;
    }

    db.prepare(`
      UPDATE match_jobs
      SET status = 'running',
        attempts = attempts + 1,
        lease_owner = ?,
        lease_expires_at = ?,
        started_at = COALESCE(started_at, ?),
        updated_at = ?
      WHERE id = ?
    `).run(owner, leaseExpiresAt, now, now, job.id);
    db.exec('COMMIT');

    return {
      ...job,
      attempts: Number(job.attempts) + 1,
      card: JSON.parse(job.card_json),
    };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}

export function completeMatchJob(jobId, owner, result, options = {}) {
  initSqlite(options.sqlitePath);
  const db = openDatabase(options.sqlitePath);
  const now = isoNow();
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs ?? 15000));

  try {
    db.exec('BEGIN IMMEDIATE');
    const job = db.prepare('SELECT attempts, max_attempts FROM match_jobs WHERE id = ? AND lease_owner = ?').get(jobId, owner);

    if (!job) {
      db.exec('COMMIT');
      return { updated: false };
    }

    const canRetry = !result?.ok && Number(job.attempts) < Number(job.max_attempts);
    const status = result?.ok ? 'succeeded' : canRetry ? 'pending' : 'failed_terminal';
    const availableAt = canRetry
      ? new Date(Date.now() + retryDelayMs * Number(job.attempts || 1)).toISOString()
      : now;

    db.prepare(`
      UPDATE match_jobs
      SET status = ?,
        available_at = ?,
        lease_owner = NULL,
        lease_expires_at = NULL,
        completed_at = ?,
        checked_at = ?,
        last_error = ?,
        target_json = ?,
        result_json = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      status,
      availableAt,
      now,
      result?.checkedAt ?? now,
      result?.error ?? null,
      result?.target ? JSON.stringify(result.target) : null,
      JSON.stringify(result),
      now,
      jobId,
    );
    db.exec('COMMIT');

    return { updated: true, status, willRetry: canRetry };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}

export function readLatestMatchJobResults(options = {}) {
  initSqlite(options.sqlitePath);
  const db = openDatabase(options.sqlitePath);

  try {
    const rows = db.prepare(`
      SELECT job_key, result_json, completed_at
      FROM match_jobs
      WHERE result_json IS NOT NULL
      AND status IN ('succeeded', 'failed_terminal')
      ORDER BY completed_at DESC, id DESC
    `).all();
    const latest = new Map();

    for (const row of rows) {
      if (!latest.has(row.job_key)) {
        latest.set(row.job_key, JSON.parse(row.result_json));
      }
    }

    return [...latest.values()];
  } finally {
    db.close();
  }
}

export function readQueueStats(options = {}) {
  initSqlite(options.sqlitePath);
  const db = openDatabase(options.sqlitePath);

  try {
    const statusRows = db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM match_jobs
      GROUP BY status
    `).all();
    const latestDiscovery = db.prepare(`
      SELECT *
      FROM discovery_runs
      ORDER BY started_at DESC, id DESC
      LIMIT 1
    `).get();

    return {
      jobsByStatus: Object.fromEntries(statusRows.map((row) => [row.status, Number(row.count)])),
      latestDiscovery,
    };
  } finally {
    db.close();
  }
}
