import { Pool } from "pg";

let _pool: Pool | null = null;

export function getPool(): Pool | null {
  if (_pool) return _pool;
  const cs =
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL;
  if (!cs) return null;
  _pool = new Pool({
    connectionString: cs,
    ssl: cs.includes("localhost") ? false : { rejectUnauthorized: false },
    max: 3,
  });
  return _pool;
}

export async function q<T = unknown>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const pool = getPool();
  if (!pool) throw new Error("Postgres not configured");
  const res = await pool.query(text, params);
  return res.rows as T[];
}
