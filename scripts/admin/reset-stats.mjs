#!/usr/bin/env node
// Manual one-shot: wipe all playtime/stats data. Does NOT touch saves,
// chat, or user accounts — only clears game_sessions so playtime
// calculations start from zero.
//
// Usage: node scripts/admin/reset-stats.mjs
// Prints counts before + after so you can see what was removed.

import pkg from "pg"; const { Pool } = pkg;
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const cs = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
const pool = new Pool({ connectionString: cs, ssl: { rejectUnauthorized: false } });

const before = await pool.query(
  `SELECT COUNT(*)::text AS n,
          COALESCE(SUM(EXTRACT(EPOCH FROM (last_heartbeat - started_at))), 0)::text AS secs
     FROM game_sessions`
);
console.log(`» before reset: ${before.rows[0].n} sessions, ${Math.round(Number(before.rows[0].secs))} total seconds`);

const del = await pool.query(`DELETE FROM game_sessions RETURNING id`);
console.log(`» deleted ${del.rows.length} rows from game_sessions`);

const after = await pool.query(`SELECT COUNT(*)::text AS n FROM game_sessions`);
console.log(`» after reset: ${after.rows[0].n} sessions`);
console.log(`» chat_messages untouched (leaderboard "messages" column preserved)`);
console.log(`» game_saves untouched (everyone's progress preserved)`);

await pool.end();
