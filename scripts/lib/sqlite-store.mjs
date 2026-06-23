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

      CREATE TABLE IF NOT EXISTS alert_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        row_key TEXT NOT NULL,
        match_code TEXT,
        performance_id TEXT,
        lounge_id TEXT,
        seating_code TEXT,
        package_title TEXT,
        seating_name TEXT,
        condition TEXT NOT NULL DEFAULT 'becomes_available',
        label TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS alert_rules_active_unique
        ON alert_rules (row_key, condition)
        WHERE active = 1;

      CREATE TABLE IF NOT EXISTS notification_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL DEFAULT 'telegram',
        source_type TEXT NOT NULL,
        source_id TEXT,
        row_key TEXT,
        priority TEXT NOT NULL DEFAULT 'normal',
        event_type TEXT,
        dedupe_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at TEXT,
        sent_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS notification_outbox_dedupe_unique
        ON notification_outbox (dedupe_key);

      CREATE INDEX IF NOT EXISTS notification_outbox_pending_idx
        ON notification_outbox (channel, status, next_attempt_at, priority);

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    ensureColumn(db, 'ticket_rows', 'country', 'TEXT');
    ensureColumn(db, 'ticket_rows', 'last_alert_at', 'TEXT');
    ensureColumn(db, 'notification_outbox', 'row_key', 'TEXT');
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

export function rowKey(row) {
  return [
    row.matchCode,
    row.performanceId,
    row.loungeId,
    row.seatingCode,
    row.priceMxn,
  ].join('|');
}

function safeParseJson(value, fallback = null) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeRuleCondition(condition) {
  const value = String(condition || 'becomes_available').trim();
  const allowed = new Set([
    'becomes_available',
    'stock_increase',
    'stock_change',
    'price_change',
    'any_change',
  ]);

  return allowed.has(value) ? value : 'becomes_available';
}

function normalizeRuleInput(input = {}) {
  const row = input.row || input.ticket || input;
  const key = input.rowKey || input.row_key || row.rowKey || row.row_key || rowKey(row);

  const keyParts = String(key || '').split('|').map((part) => part.trim()).filter(Boolean);

  if (!key || key.includes('undefined') || key.includes('null') || keyParts.length < 3) {
    throw new Error('Alert rule requires a stable row key or ticket row payload.');
  }

  const rule = {
    rowKey: key,
    matchCode: input.matchCode ?? row.matchCode ?? null,
    performanceId: input.performanceId ?? row.performanceId ?? null,
    loungeId: input.loungeId ?? row.loungeId ?? null,
    seatingCode: input.seatingCode ?? row.seatingCode ?? null,
    packageTitle: input.packageTitle ?? row.packageTitle ?? null,
    seatingName: input.seatingName ?? row.seatingName ?? null,
    condition: normalizeRuleCondition(input.condition),
    label: input.label ?? null,
  };

  const hasMatchIdentity = Boolean(rule.matchCode || rule.performanceId);
  const hasTicketIdentity = Boolean(rule.loungeId || rule.seatingCode || rule.packageTitle || rule.seatingName);

  if (!hasMatchIdentity || !hasTicketIdentity) {
    throw new Error('Alert rule requires match and ticket identifiers.');
  }

  return rule;
}

function serializeAlertRule(rule) {
  if (!rule) {
    return null;
  }

  return {
    id: Number(rule.id),
    rowKey: rule.row_key,
    matchCode: rule.match_code,
    performanceId: rule.performance_id,
    loungeId: rule.lounge_id,
    seatingCode: rule.seating_code,
    packageTitle: rule.package_title,
    seatingName: rule.seating_name,
    condition: rule.condition,
    label: rule.label,
    active: Boolean(rule.active),
    createdAt: rule.created_at,
    updatedAt: rule.updated_at,
  };
}

function activeRules(db) {
  return db.prepare(`
    SELECT *
    FROM alert_rules
    WHERE active = 1
    ORDER BY created_at ASC, id ASC
  `).all();
}

function previousRowsFromLatestState(db) {
  const row = db.prepare('SELECT state_json FROM latest_state WHERE id = 1').get();
  const state = safeParseJson(row?.state_json, {});
  const rows = Array.isArray(state?.latestRows) ? state.latestRows : [];
  return new Map(rows.map((item) => [rowKey(item), item]));
}

function rowsByKey(rows = []) {
  return new Map(rows.map((row) => [rowKey(row), row]));
}

function rowMatchesRule(row, rule) {
  if (!row) {
    return false;
  }

  if (rule.row_key) {
    return rowKey(row) === rule.row_key;
  }

  return (!rule.match_code || row.matchCode === rule.match_code)
    && (!rule.performance_id || row.performanceId === rule.performance_id)
    && (!rule.lounge_id || row.loungeId === rule.lounge_id)
    && (!rule.seating_code || row.seatingCode === rule.seating_code);
}

function ruleTrigger(rule, row, previousRow, cycle) {
  if (!row || row.stale) {
    return null;
  }

  const previousAvailable = Boolean(previousRow?.available);
  const currentAvailable = Boolean(row.available);
  const hasPrevious = Boolean(previousRow);
  const previousQuantity = Number(previousRow?.availableQuantity ?? 0);
  const currentQuantity = Number(row.availableQuantity ?? 0);
  const previousPrice = Number(previousRow?.priceMxn ?? 0);
  const currentPrice = Number(row.priceMxn ?? 0);
  const availabilityChanged = previousAvailable !== currentAvailable;
  const stockChanged = previousQuantity !== currentQuantity;
  const priceChanged = previousPrice !== currentPrice;
  const changed = availabilityChanged || stockChanged || priceChanged;
  const changedAt = row.lastChangedAt || row.checkedAt || cycle.cycleCompletedAt;

  if (!changed || toMs(changedAt) < toMs(cycle.cycleStartedAt)) {
    return null;
  }

  const condition = normalizeRuleCondition(rule.condition);

  if (condition === 'becomes_available' && !(currentAvailable && !previousAvailable)) {
    return null;
  }

  if (condition !== 'becomes_available' && !hasPrevious) {
    return null;
  }

  if (condition === 'stock_increase' && !(currentAvailable && currentQuantity > previousQuantity)) {
    return null;
  }

  if (condition === 'stock_change' && !stockChanged) {
    return null;
  }

  if (condition === 'price_change' && !priceChanged) {
    return null;
  }

  return {
    eventType: condition,
    eventAt: changedAt,
    previousAvailable,
    currentAvailable,
    previousQuantity,
    currentQuantity,
    previousPrice,
    currentPrice,
  };
}

function telegramCredentialsReady() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

function readSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row?.value ?? fallback;
}

function writeSetting(db, key, value) {
  const now = isoNow();

  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(key, String(value), now);
}

function telegramGlobalAlertsEnabledFromDb(db) {
  return readSetting(db, 'telegram_global_alerts_enabled', '0') === '1';
}

export function readTelegramSettings(options = {}) {
  initSqlite(options.sqlitePath);
  const db = openDatabase(options.sqlitePath);

  try {
    return {
      globalAlertsEnabled: telegramGlobalAlertsEnabledFromDb(db),
    };
  } finally {
    db.close();
  }
}

export function updateTelegramSettings(input = {}, options = {}) {
  initSqlite(options.sqlitePath);
  const db = openDatabase(options.sqlitePath);

  try {
    db.exec('BEGIN IMMEDIATE');

    if (Object.prototype.hasOwnProperty.call(input, 'globalAlertsEnabled')) {
      writeSetting(db, 'telegram_global_alerts_enabled', input.globalAlertsEnabled ? '1' : '0');
    }

    const settings = {
      globalAlertsEnabled: telegramGlobalAlertsEnabledFromDb(db),
    };

    db.exec('COMMIT');
    return settings;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}

function enqueueNotification(db, notification) {
  if (!telegramCredentialsReady()) {
    return;
  }

  const now = isoNow();

  db.prepare(`
    INSERT INTO notification_outbox (
      channel,
      source_type,
      source_id,
      row_key,
      priority,
      event_type,
      dedupe_key,
      payload_json,
      status,
      next_attempt_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    ON CONFLICT(dedupe_key) DO NOTHING
  `).run(
    notification.channel || 'telegram',
    notification.sourceType,
    notification.sourceId == null ? null : String(notification.sourceId),
    notification.rowKey || null,
    notification.priority || 'normal',
    notification.eventType || null,
    notification.dedupeKey,
    JSON.stringify(notification.payload),
    now,
    now,
  );
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
    const previousRows = previousRowsFromLatestState(db);
    const currentRows = rowsByKey(cycle.rows || []);
    const triggeredAlertKeys = new Set();
    const enqueueNotifications = options.enqueueNotifications !== false;
    const enqueueGlobalAlerts = enqueueNotifications && telegramGlobalAlertsEnabledFromDb(db);

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
    const alertEvents = [];

    for (const row of cycle.alerts || []) {
      const eventAt = row.lastAlertAt || row.lastChangedAt || row.checkedAt || cycle.cycleCompletedAt;
      const eventType = row.alertReason || row.availabilityFreshness || 'availability';
      const key = rowKey(row);

      const insertResult = insertAlert.run(
        key,
        eventType,
        eventAt,
        row.matchCode ?? null,
        row.packageTitle ?? null,
        row.seatingCode ?? null,
        Number(row.availableQuantity ?? 0),
        row.priceMxn ?? null,
        JSON.stringify(row),
      );

      if (Number(insertResult.changes || 0) === 0) {
        continue;
      }

      const alertEvent = db.prepare(`
        SELECT id, row_key, event_type, event_at
        FROM alert_events
        WHERE row_key = ? AND event_type = ? AND event_at = ?
      `).get(key, eventType, eventAt);

      if (alertEvent && enqueueNotifications) {
        alertEvents.push({ ...alertEvent, row });
      }
    }

    for (const rule of enqueueNotifications ? activeRules(db) : []) {
      const currentRow = currentRows.get(rule.row_key)
        || [...currentRows.values()].find((row) => rowMatchesRule(row, rule));
      const previousRow = previousRows.get(rule.row_key) || previousRows.get(currentRow ? rowKey(currentRow) : '');
      const trigger = ruleTrigger(rule, currentRow, previousRow, cycle);

      if (!trigger) {
        continue;
      }

      const key = rowKey(currentRow);
      triggeredAlertKeys.add(`${key}|${trigger.eventAt}`);
      enqueueNotification(db, {
        sourceType: 'alert_rule',
        sourceId: rule.id,
        rowKey: key,
        priority: 'high',
        eventType: trigger.eventType,
        dedupeKey: `alert_rule:${rule.id}:${trigger.eventType}:${key}:${trigger.eventAt}`,
        payload: {
          sourceType: 'alert_rule',
          priority: 'high',
          rule: serializeAlertRule(rule),
          event: trigger,
          row: currentRow,
          previousRow,
          cycleCompletedAt: cycle.cycleCompletedAt,
          shopUrl: cycle.shopUrl,
        },
      });
    }

    for (const event of enqueueGlobalAlerts ? alertEvents : []) {
      if (triggeredAlertKeys.has(`${event.row_key}|${event.event_at}`)) {
        continue;
      }

      enqueueNotification(db, {
        sourceType: 'global_alert',
        sourceId: event.id,
        rowKey: event.row_key,
        priority: 'normal',
        eventType: event.event_type,
        dedupeKey: `global_alert:${event.id}`,
        payload: {
          sourceType: 'global_alert',
          priority: 'normal',
          event: {
            eventType: event.event_type,
            eventAt: event.event_at,
          },
          row: event.row,
          cycleCompletedAt: cycle.cycleCompletedAt,
          shopUrl: cycle.shopUrl,
        },
      });
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

export function createAlertRule(input, options = {}) {
  initSqlite(options.sqlitePath);
  const db = openDatabase(options.sqlitePath);
  const rule = normalizeRuleInput(input);
  const now = isoNow();

  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare(`
      INSERT INTO alert_rules (
        row_key,
        match_code,
        performance_id,
        lounge_id,
        seating_code,
        package_title,
        seating_name,
        condition,
        label,
        active,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(row_key, condition) WHERE active = 1 DO UPDATE SET
        match_code = excluded.match_code,
        performance_id = excluded.performance_id,
        lounge_id = excluded.lounge_id,
        seating_code = excluded.seating_code,
        package_title = excluded.package_title,
        seating_name = excluded.seating_name,
        label = COALESCE(excluded.label, alert_rules.label),
        updated_at = excluded.updated_at
    `).run(
      rule.rowKey,
      rule.matchCode,
      rule.performanceId,
      rule.loungeId,
      rule.seatingCode,
      rule.packageTitle,
      rule.seatingName,
      rule.condition,
      rule.label,
      now,
    );

    const stored = db.prepare(`
      SELECT *
      FROM alert_rules
      WHERE row_key = ? AND condition = ? AND active = 1
      ORDER BY id DESC
      LIMIT 1
    `).get(rule.rowKey, rule.condition);
    db.exec('COMMIT');
    return serializeAlertRule(stored);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}

export function listAlertRules(options = {}) {
  initSqlite(options.sqlitePath);
  const db = openDatabase(options.sqlitePath);

  try {
    return db.prepare(`
      SELECT *
      FROM alert_rules
      WHERE active = 1
      ORDER BY created_at DESC, id DESC
    `).all().map(serializeAlertRule);
  } finally {
    db.close();
  }
}

export function deleteAlertRule(id, options = {}) {
  initSqlite(options.sqlitePath);
  const db = openDatabase(options.sqlitePath);
  const now = isoNow();

  try {
    db.exec('BEGIN IMMEDIATE');
    const row = db.prepare(`
      SELECT *
      FROM alert_rules
      WHERE id = ? AND active = 1
    `).get(Number(id));

    if (!row) {
      db.exec('COMMIT');
      return null;
    }

    const result = db.prepare(`
      UPDATE alert_rules
      SET active = 0, updated_at = ?
      WHERE id = ? AND active = 1
    `).run(now, Number(id));

    db.exec('COMMIT');
    return Number(result.changes || 0) > 0
      ? serializeAlertRule({ ...row, active: 0, updated_at: now })
      : null;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}

export function readNotificationStats(options = {}) {
  initSqlite(options.sqlitePath);
  const db = openDatabase(options.sqlitePath);

  try {
    const rows = db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM notification_outbox
      WHERE channel = 'telegram'
      GROUP BY status
    `).all();

    return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
  } finally {
    db.close();
  }
}

export function claimPendingNotifications(owner, options = {}) {
  initSqlite(options.sqlitePath);
  const db = openDatabase(options.sqlitePath);
  const now = isoNow();
  const limit = Math.max(1, Number(options.limit || 5));
  const maxAttempts = Math.max(1, Number(options.maxAttempts || 5));
  const leaseMs = Math.max(5000, Number(options.leaseMs || 30000));
  const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();

  try {
    db.exec('BEGIN IMMEDIATE');
    const rows = db.prepare(`
      SELECT *
      FROM notification_outbox
      WHERE channel = 'telegram'
      AND next_attempt_at <= ?
      AND attempts < ?
      AND (
        status IN ('pending', 'failed')
        OR (status = 'sending' AND lease_expires_at <= ?)
      )
      ORDER BY
        CASE priority WHEN 'high' THEN 0 ELSE 1 END,
        created_at ASC,
        id ASC
      LIMIT ?
    `).all(now, maxAttempts, now, limit);

    const claim = db.prepare(`
      UPDATE notification_outbox
      SET status = 'sending',
        attempts = attempts + 1,
        lease_owner = ?,
        lease_expires_at = ?,
        updated_at = ?
      WHERE id = ?
    `);

    for (const row of rows) {
      claim.run(owner, leaseExpiresAt, now, row.id);
    }

    db.exec('COMMIT');
    return rows.map((row) => ({
      id: Number(row.id),
      channel: row.channel,
      sourceType: row.source_type,
      sourceId: row.source_id,
      rowKey: row.row_key,
      priority: row.priority,
      eventType: row.event_type,
      dedupeKey: row.dedupe_key,
      payload: safeParseJson(row.payload_json, {}),
      attempts: Number(row.attempts) + 1,
    }));
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}

export function markNotificationSent(id, owner, options = {}) {
  initSqlite(options.sqlitePath);
  const db = openDatabase(options.sqlitePath);
  const now = isoNow();

  try {
    db.exec('BEGIN IMMEDIATE');
    const row = db.prepare(`
      SELECT source_type, source_id
      FROM notification_outbox
      WHERE id = ? AND lease_owner = ?
    `).get(Number(id), owner);

    if (!row) {
      db.exec('COMMIT');
      return false;
    }

    db.prepare(`
      UPDATE notification_outbox
      SET status = 'sent',
        sent_at = ?,
        lease_owner = NULL,
        lease_expires_at = NULL,
        last_error = NULL,
        updated_at = ?
      WHERE id = ?
    `).run(now, now, Number(id));

    if (row.source_type === 'global_alert' && row.source_id) {
      db.prepare('UPDATE alert_events SET notified_at = ? WHERE id = ?').run(now, Number(row.source_id));
    }

    db.exec('COMMIT');
    return true;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}

export function markNotificationFailed(id, owner, error, options = {}) {
  initSqlite(options.sqlitePath);
  const db = openDatabase(options.sqlitePath);
  const now = isoNow();
  const retryDelayMs = Math.max(1000, Number(options.retryDelayMs || 30000));
  const nextAttemptAt = new Date(Date.now() + retryDelayMs).toISOString();

  try {
    const result = db.prepare(`
      UPDATE notification_outbox
      SET status = 'failed',
        next_attempt_at = ?,
        lease_owner = NULL,
        lease_expires_at = NULL,
        last_error = ?,
        updated_at = ?
      WHERE id = ? AND lease_owner = ?
    `).run(nextAttemptAt, String(error || '').slice(0, 1000), now, Number(id), owner);

    return Number(result.changes || 0) > 0;
  } finally {
    db.close();
  }
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
    enqueueNotifications: false,
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
