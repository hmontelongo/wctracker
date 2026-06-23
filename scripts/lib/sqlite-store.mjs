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
