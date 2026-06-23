import { loadDotEnv } from './lib/env.mjs';
import { backfillSqliteFromJson, readLatestFromSqlite } from './lib/sqlite-store.mjs';

loadDotEnv();

const backfilled = backfillSqliteFromJson();
const latest = readLatestFromSqlite();

console.log(JSON.stringify({
  ok: true,
  backfilled,
  latestTick: latest.latestCycle?.tick ?? null,
  latestRows: latest.latestCycle?.rowCount ?? 0,
  latestAvailableRows: latest.latestCycle?.availableRowCount ?? 0,
}, null, 2));
