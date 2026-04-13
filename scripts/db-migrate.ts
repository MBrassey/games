import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";

async function main() {
  const cs =
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL;
  if (!cs) {
    console.error("No POSTGRES_URL / DATABASE_URL in env");
    process.exit(1);
  }
  const pool = new Pool({
    connectionString: cs,
    ssl: cs.includes("localhost") ? false : { rejectUnauthorized: false },
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      ran_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const dir = join(process.cwd(), "migrations");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const f of files) {
    const { rows } = await pool.query(
      "SELECT 1 FROM _migrations WHERE name=$1",
      [f]
    );
    if (rows.length) {
      console.log(`  ok  ${f}`);
      continue;
    }
    const sql = readFileSync(join(dir, f), "utf8");
    console.log(`... run ${f}`);
    await pool.query("BEGIN");
    try {
      await pool.query(sql);
      await pool.query("INSERT INTO _migrations(name) VALUES($1)", [f]);
      await pool.query("COMMIT");
      console.log(`  ok  ${f}`);
    } catch (e) {
      await pool.query("ROLLBACK");
      console.error(`fail  ${f}:`, e);
      process.exit(1);
    }
  }
  await pool.end();
}

main();
