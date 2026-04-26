import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { q } from "@/lib/db";
import { getKv, NET_KV, type NetEvent } from "@/lib/kv";
import { RESERVED_VERBS, SEND_RATE_BURST, SEND_RATE_PER_SEC, SLUG_MIRROR_VERBS } from "@/lib/net";
import { z } from "zod";

export const runtime = "nodejs";

const Body = z.object({
  roomId: z.string().regex(/^\d+$/),
  verb: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/),
  payload: z.unknown().optional(),
  // Optional unicast filter — when set, the stream route only delivers
  // this event to the targeted user (plus the sender, who already has
  // the synthesized echo in send:result). Reduces wasted bandwidth on
  // boost / thanks / pool_request / wave verbs.
  target: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]).optional(),
});

// Best-effort token bucket. We don't atomically refill here — we just
// check the count, decide, and bump. A racing pair of requests in the
// same 1s window can each get through; that's fine, the cap is a soft
// rate-limit not a security boundary. KV cost: 1 GET + 1 SETEX per send
// (skipped entirely when KV isn't configured).
async function rateLimited(userId: number, roomId: string): Promise<boolean> {
  const kv = getKv();
  if (!kv) return false;
  const key = NET_KV.sendBucket(userId, roomId);
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
    const refilled = Math.min(SEND_RATE_BURST, bucket.count + elapsed * SEND_RATE_PER_SEC);
    // refilled minus 1 for the cost of this send. If we go negative we've
    // exhausted the budget; bail without recording the spend so the next
    // request finds the same starved bucket.
    if (refilled < 1) return true;
    const next = { count: refilled - 1, ts: now };
    await kv.set(key, JSON.stringify(next), { ex: 30 });
    return false;
  } catch {
    return false;
  }
}

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
  if (RESERVED_VERBS.has(body.verb)) {
    return NextResponse.json(
      { error: "verb is reserved", verb: body.verb },
      { status: 400 }
    );
  }

  // Membership gate — sending into a room you're not in is silently a
  // no-op rather than a wide error so games don't trip up on race
  // conditions during reconnect.
  const member = await q<{ user_id: number }>(
    `SELECT user_id FROM net_room_members WHERE room_id=$1 AND user_id=$2`,
    [body.roomId, userId]
  );
  if (!member.length) {
    return NextResponse.json({ error: "not in room" }, { status: 403 });
  }

  if (await rateLimited(userId, body.roomId)) {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }

  // Bump last_seen_at so a chatty sender doesn't get dropped from the
  // live roster between heartbeat ticks.
  await q(
    `UPDATE net_room_members SET last_seen_at = now()
      WHERE room_id=$1 AND user_id=$2`,
    [body.roomId, userId]
  );

  // Snap the sender's profile once per request — we want the broadcast
  // to carry the human-readable handle so subscribers don't need a
  // second round-trip.
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
  const target = body.target != null ? Number(body.target) : null;
  const ins = await q<{ id: string; created_at: Date; game_slug: string }>(
    `WITH inserted AS (
       INSERT INTO net_room_events(room_id, user_id, verb, payload, target_user_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at, room_id
     )
     SELECT i.id, i.created_at, r.game_slug
       FROM inserted i JOIN net_rooms r ON r.id = i.room_id`,
    [body.roomId, userId, body.verb, payload as object, target]
  );
  const evt: NetEvent & { target?: string | null } = {
    id: String(ins[0].id),
    roomId: body.roomId,
    userId: String(userId),
    handle,
    avatar,
    verb: body.verb,
    payload,
    ts: new Date(ins[0].created_at).getTime(),
    target: target != null ? String(target) : null,
  };

  // KV fanout — best-effort, mirroring the chat send. The SSE stream
  // route falls back to Postgres if KV is dead, so delivery always works,
  // just with slightly higher latency on the fallback path.
  const kv = getKv();
  if (kv) {
    try {
      await kv.lpush(NET_KV.streamList(body.roomId), evt);
      await kv.ltrim(NET_KV.streamList(body.roomId), 0, 199);
      await kv.incr(NET_KV.streamSeq(body.roomId));
    } catch (e) {
      console.warn("[net/send] KV fanout failed:", (e as Error)?.message);
    }
    // Slug-wide auto-mirror — only the "global ticker" verbs, and only
    // for non-targeted broadcasts (a unicast event isn't world news).
    if (target == null && SLUG_MIRROR_VERBS.has(body.verb)) {
      try {
        const slug = ins[0].game_slug;
        await kv.lpush(NET_KV.slugStreamList(slug), evt);
        await kv.ltrim(NET_KV.slugStreamList(slug), 0, 199);
        await kv.incr(NET_KV.slugStreamSeq(slug));
      } catch (e) {
        console.warn("[net/send] slug mirror fanout failed:", (e as Error)?.message);
      }
    }
  }

  return NextResponse.json({ ok: true, event: evt });
}
