import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { q } from "@/lib/db";
import { getKv, NET_KV, type NetEvent } from "@/lib/kv";
import { ONLINE_WINDOW_MS, ROOM_CODE_RE } from "@/lib/net";
import { z } from "zod";

export const runtime = "nodejs";

const Body = z.object({
  game: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/).optional(),
  code: z.string().optional(),
  roomId: z.string().regex(/^\d+$/).optional(),
}).refine((b) => !!(b.code || b.roomId), {
  message: "code or roomId required",
});

type RoomRow = {
  id: string;
  game_slug: string;
  code: string;
  name: string;
  visibility: string;
  capacity: number;
  owner_id: number | null;
  state: unknown;
  state_version: string;
  closed_at: Date | null;
};

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

  let room: RoomRow | undefined;
  if (body.roomId) {
    room = (
      await q<RoomRow>(
        `SELECT id, game_slug, code, name, visibility, capacity, owner_id,
                state, state_version, closed_at
           FROM net_rooms WHERE id=$1`,
        [body.roomId]
      )
    )[0];
  } else if (body.code) {
    if (!ROOM_CODE_RE.test(body.code) || !body.game) {
      return NextResponse.json({ error: "bad code or missing game" }, { status: 400 });
    }
    room = (
      await q<RoomRow>(
        `SELECT id, game_slug, code, name, visibility, capacity, owner_id,
                state, state_version, closed_at
           FROM net_rooms WHERE game_slug=$1 AND code=$2`,
        [body.game, body.code]
      )
    )[0];
  }
  if (!room || room.closed_at) {
    return NextResponse.json({ error: "room not found" }, { status: 404 });
  }

  // Capacity check on the live roster; closed connections don't count
  // against capacity once their heartbeats lapse beyond the window.
  const liveRows = await q<{ n: string }>(
    `SELECT COUNT(*)::text AS n
       FROM net_room_members
      WHERE room_id=$1
        AND last_seen_at > now() - ($2 || ' milliseconds')::interval
        AND user_id <> $3`,
    [room.id, String(ONLINE_WINDOW_MS), userId]
  );
  if (Number(liveRows[0].n) >= room.capacity) {
    return NextResponse.json({ error: "room full" }, { status: 409 });
  }

  await q(
    `INSERT INTO net_room_members(room_id, user_id) VALUES($1,$2)
     ON CONFLICT (room_id, user_id) DO UPDATE SET last_seen_at = now()`,
    [room.id, userId]
  );

  // Look up the joiner's display profile so the join event carries their
  // handle without forcing every client that sees it to do a separate
  // /api/users/<id> lookup.
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

  // Persist a join event so the SSE stream's Postgres fallback can emit
  // it on reconnect, and broadcast via KV for snappy live delivery.
  const ins = await q<{ id: string; created_at: Date }>(
    `INSERT INTO net_room_events(room_id, user_id, verb, payload)
     VALUES ($1,$2,'join',$3) RETURNING id, created_at`,
    [room.id, userId, JSON.stringify({ handle, avatar })]
  );
  const evt: NetEvent = {
    id: String(ins[0].id),
    roomId: String(room.id),
    userId: String(userId),
    handle,
    avatar,
    verb: "join",
    payload: { handle, avatar },
    ts: new Date(ins[0].created_at).getTime(),
  };
  const kv = getKv();
  if (kv) {
    try {
      await kv.lpush(NET_KV.streamList(room.id), evt);
      await kv.ltrim(NET_KV.streamList(room.id), 0, 199);
      await kv.incr(NET_KV.streamSeq(room.id));
      await kv.incr(NET_KV.rosterSeq(room.id));
    } catch (e) {
      console.warn("[net/join] KV fanout failed:", (e as Error)?.message);
    }
  }

  return NextResponse.json({
    ok: true,
    room: {
      id: String(room.id),
      game: room.game_slug,
      code: room.code,
      name: room.name,
      visibility: room.visibility,
      capacity: room.capacity,
      ownerId: room.owner_id ? String(room.owner_id) : null,
      state: room.state ?? {},
      stateVersion: Number(room.state_version),
    },
  });
}
