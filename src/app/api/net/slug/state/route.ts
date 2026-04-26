import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { q } from "@/lib/db";
import { getKv, NET_KV, type NetEvent } from "@/lib/kv";
import { GAMES } from "@/lib/games";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PatchBody = z.object({
  game: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
  patch: z.record(z.any()),
  expectedVersion: z.number().int().nonnegative().optional(),
  replace: z.boolean().optional(),
});

// GET /api/net/slug/state?game=<slug>  — read the current slug-wide
// JSONB blob. Anyone (signed in or not) can read; writes require auth.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const game = searchParams.get("game");
  if (!game) return NextResponse.json({ error: "game required" }, { status: 400 });
  if (!GAMES.find((g) => g.slug === game)) {
    return NextResponse.json({ error: "unknown game" }, { status: 404 });
  }
  const rows = await q<{ state: unknown; state_version: string; updated_at: Date | null }>(
    `SELECT state, state_version, updated_at
       FROM net_slug_state WHERE game_slug=$1`,
    [game]
  );
  if (!rows.length) {
    return NextResponse.json({
      slug: game,
      state: {},
      version: 0,
      updatedAt: null,
    });
  }
  return NextResponse.json({
    slug: game,
    state: rows[0].state ?? {},
    version: Number(rows[0].state_version),
    updatedAt: rows[0].updated_at ? new Date(rows[0].updated_at).toISOString() : null,
  });
}

// PATCH /api/net/slug/state — merge (default) or replace the JSONB
// blob. Optional CAS via expectedVersion. Every successful patch
// inserts a `slug_state` event into net_slug_events so subscribers can
// re-sync without polling.
export async function PATCH(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const userId = Number(session.user.id);
  let body: z.infer<typeof PatchBody>;
  try {
    body = PatchBody.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  if (!GAMES.find((g) => g.slug === body.game)) {
    return NextResponse.json({ error: "unknown game" }, { status: 404 });
  }

  const sql = body.replace
    ? `INSERT INTO net_slug_state (game_slug, state, state_version, updated_at)
            VALUES ($1, $2::jsonb, 1, now())
       ON CONFLICT (game_slug) DO UPDATE
            SET state = EXCLUDED.state,
                state_version = net_slug_state.state_version + 1,
                updated_at = now()
        WHERE $3::bigint IS NULL OR net_slug_state.state_version = $3
       RETURNING state, state_version`
    : `INSERT INTO net_slug_state (game_slug, state, state_version, updated_at)
            VALUES ($1, $2::jsonb, 1, now())
       ON CONFLICT (game_slug) DO UPDATE
            SET state = net_slug_state.state || EXCLUDED.state,
                state_version = net_slug_state.state_version + 1,
                updated_at = now()
        WHERE $3::bigint IS NULL OR net_slug_state.state_version = $3
       RETURNING state, state_version`;
  const rows = await q<{ state: unknown; state_version: string }>(sql, [
    body.game,
    JSON.stringify(body.patch),
    body.expectedVersion ?? null,
  ]);
  if (!rows.length) {
    return NextResponse.json({ error: "version conflict" }, { status: 409 });
  }
  const stateVersion = Number(rows[0].state_version);

  const ins = await q<{ id: string; created_at: Date }>(
    `INSERT INTO net_slug_events(game_slug, user_id, verb, payload)
     VALUES($1,$2,'slug_state',$3) RETURNING id, created_at`,
    [body.game, userId, { state: rows[0].state ?? {}, version: stateVersion }]
  );
  const evt: NetEvent = {
    id: String(ins[0].id),
    roomId: "",
    userId: String(userId),
    handle: null,
    avatar: null,
    verb: "slug_state",
    payload: { state: rows[0].state ?? {}, version: stateVersion },
    ts: new Date(ins[0].created_at).getTime(),
  };
  const kv = getKv();
  if (kv) {
    try {
      await kv.lpush(NET_KV.slugStreamList(body.game), evt);
      await kv.ltrim(NET_KV.slugStreamList(body.game), 0, 199);
      await kv.incr(NET_KV.slugStreamSeq(body.game));
    } catch (e) {
      console.warn("[net/slug/state] KV fanout failed:", (e as Error)?.message);
    }
  }

  return NextResponse.json({
    ok: true,
    slug: body.game,
    state: rows[0].state ?? {},
    version: stateVersion,
  });
}
