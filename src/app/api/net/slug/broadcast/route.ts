import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { q } from "@/lib/db";
import { getKv, NET_KV, type NetEvent } from "@/lib/kv";
import { RESERVED_VERBS, SEND_RATE_BURST, SEND_RATE_PER_SEC } from "@/lib/net";
import { GAMES } from "@/lib/games";
import { z } from "zod";

export const runtime = "nodejs";

const Body = z.object({
  game: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
  verb: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/),
  payload: z.unknown().optional(),
});

// Slug-wide unicast token bucket. Same shape as the per-room limiter
// but a tighter ceiling — broadcasts hit every subscriber to the slug,
// so we don't want any one player firing them at gameplay rate.
async function rateLimited(userId: number, slug: string): Promise<boolean> {
  const kv = getKv();
  if (!kv) return false;
  const key = `net:rl:slug-bcast:${userId}:${slug}`;
  try {
    const now = Date.now();
    const raw = (await kv.get(key)) as string | { count: number; ts: number } | null;
    let bucket: { count: number; ts: number };
    if (typeof raw === "string") {
      try { bucket = JSON.parse(raw); } catch { bucket = { count: 0, ts: now }; }
    } else if (raw && typeof raw === "object") {
      bucket = raw;
    } else {
      bucket = { count: 0, ts: now };
    }
    const elapsed = (now - bucket.ts) / 1000;
    // Half the per-room rate.
    const refilled = Math.min(SEND_RATE_BURST / 2, bucket.count + elapsed * (SEND_RATE_PER_SEC / 2));
    if (refilled < 1) return true;
    await kv.set(key, JSON.stringify({ count: refilled - 1, ts: now }), { ex: 30 });
    return false;
  } catch {
    return false;
  }
}

// POST /api/net/slug/broadcast — emit a verb to every subscriber of
// the slug stream, bypassing the room mesh. Authenticated; rate-limited
// at half the per-room ceiling.
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const userId = Number(session.user.id);
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  if (!GAMES.find((g) => g.slug === body.game)) {
    return NextResponse.json({ error: "unknown game" }, { status: 404 });
  }
  if (RESERVED_VERBS.has(body.verb)) {
    return NextResponse.json({ error: "verb is reserved", verb: body.verb }, { status: 400 });
  }
  if (await rateLimited(userId, body.game)) {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }

  const profile = (
    await q<{ handle: string | null; avatar_url: string | null; name: string | null; image: string | null }>(
      `SELECT up.handle, up.avatar_url, u.name, u.image
         FROM users u LEFT JOIN user_profiles up ON up.user_id=u.id
        WHERE u.id=$1`,
      [userId]
    )
  )[0];
  const handle = profile?.handle ?? profile?.name ?? `user-${userId}`;
  const avatar = profile?.avatar_url ?? profile?.image ?? null;

  const payload = body.payload ?? {};
  const ins = await q<{ id: string; created_at: Date }>(
    `INSERT INTO net_slug_events(game_slug, user_id, verb, payload)
     VALUES($1,$2,$3,$4) RETURNING id, created_at`,
    [body.game, userId, body.verb, payload as object]
  );
  const evt: NetEvent = {
    id: String(ins[0].id),
    roomId: "",
    userId: String(userId),
    handle,
    avatar,
    verb: body.verb,
    payload,
    ts: new Date(ins[0].created_at).getTime(),
  };
  const kv = getKv();
  if (kv) {
    try {
      await kv.lpush(NET_KV.slugStreamList(body.game), evt);
      await kv.ltrim(NET_KV.slugStreamList(body.game), 0, 199);
      await kv.incr(NET_KV.slugStreamSeq(body.game));
    } catch (e) {
      console.warn("[net/slug/broadcast] KV fanout failed:", (e as Error)?.message);
    }
  }

  return NextResponse.json({ ok: true, event: evt });
}
