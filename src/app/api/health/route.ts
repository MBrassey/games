import { NextResponse } from "next/server";
import { q } from "@/lib/db";
import { getKv } from "@/lib/kv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Quick diagnostics for prod wiring. Hit /api/health to confirm DB + KV are
// reachable. Returns 200 with a status map even if one backend is down,
// so you can see exactly which one is misconfigured.
export async function GET() {
  const env = {
    AUTH_SECRET: !!process.env.AUTH_SECRET,
    AUTH_GITHUB_ID: !!process.env.AUTH_GITHUB_ID,
    AUTH_GITHUB_SECRET: !!process.env.AUTH_GITHUB_SECRET,
    AUTH_URL: process.env.AUTH_URL || null,
    POSTGRES_URL: !!process.env.POSTGRES_URL,
    KV_REST_API_URL: !!process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN: !!process.env.KV_REST_API_TOKEN,
  };

  let db: { ok: boolean; users?: number; tables?: string[]; error?: string };
  try {
    const rows = await q<{ n: string }>("SELECT count(*)::text AS n FROM users");
    const tables = await q<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' ORDER BY table_name`
    );
    db = { ok: true, users: Number(rows[0]?.n ?? 0), tables: tables.map((t) => t.table_name) };
  } catch (e) {
    db = { ok: false, error: (e as Error).message };
  }

  let kv: { ok: boolean; ping?: unknown; error?: string };
  const c = getKv();
  if (!c) {
    kv = { ok: false, error: "KV env vars missing" };
  } else {
    try {
      await c.set("health:ping", Date.now(), { ex: 60 });
      const v = await c.get("health:ping");
      kv = { ok: true, ping: v };
    } catch (e) {
      kv = { ok: false, error: (e as Error).message };
    }
  }

  return NextResponse.json({ env, db, kv, at: new Date().toISOString() });
}
