import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { q } from "@/lib/db";
import { getKv, NET_KV, type NetEvent } from "@/lib/kv";
import { z } from "zod";

export const runtime = "nodejs";

const Body = z.object({
  roomId: z.string().regex(/^\d+$/),
  patch: z.record(z.any()),
  // Optimistic concurrency: caller can pass the version they read; the
  // request fails 409 if it has moved on. Optional — clients that don't
  // care can omit and last write wins.
  expectedVersion: z.number().int().nonnegative().optional(),
  replace: z.boolean().optional(),
});

// PATCH /api/net/rooms/state — update the room's persistent JSONB state.
// Default semantics is shallow merge (`||` operator on jsonb); pass
// replace:true to overwrite the whole blob. Either way state_version
// increments and a 'state' event is broadcast so subscribers can re-sync.
export async function PATCH(req: Request) {
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

  // Authorization: any current member of the room can mutate state.
  // Owner-only writes are out of scope for v1 — games that need authority
  // can encode it inside the state itself (e.g. only_owner_writes flag).
  const member = await q<{ user_id: number }>(
    `SELECT user_id FROM net_room_members WHERE room_id=$1 AND user_id=$2`,
    [body.roomId, userId]
  );
  if (!member.length) {
    return NextResponse.json({ error: "not in room" }, { status: 403 });
  }

  const sql = body.replace
    ? `UPDATE net_rooms
          SET state = $2::jsonb,
              state_version = state_version + 1,
              updated_at = now()
        WHERE id = $1
          AND ($3::bigint IS NULL OR state_version = $3)
        RETURNING state, state_version`
    : `UPDATE net_rooms
          SET state = state || $2::jsonb,
              state_version = state_version + 1,
              updated_at = now()
        WHERE id = $1
          AND ($3::bigint IS NULL OR state_version = $3)
        RETURNING state, state_version`;
  const rows = await q<{ state: unknown; state_version: string }>(sql, [
    body.roomId,
    JSON.stringify(body.patch),
    body.expectedVersion ?? null,
  ]);
  if (!rows.length) {
    return NextResponse.json(
      { error: "version conflict or room missing" },
      { status: 409 }
    );
  }
  const stateVersion = Number(rows[0].state_version);

  // Broadcast a 'state' event so listeners can react without polling.
  // The portal inserts this directly with verb='state' (RESERVED_VERBS
  // blocks the user-send path from emitting it manually, which keeps
  // games from spoofing state writes via plain send calls).
  const evtPayload = {
    state: rows[0].state ?? {},
    version: stateVersion,
  };
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

  const ins = await q<{ id: string; created_at: Date }>(
    `INSERT INTO net_room_events(room_id, user_id, verb, payload)
     VALUES ($1,$2,'state',$3) RETURNING id, created_at`,
    [body.roomId, userId, evtPayload]
  );
  const evt: NetEvent = {
    id: String(ins[0].id),
    roomId: body.roomId,
    userId: String(userId),
    handle,
    avatar,
    verb: "state",
    payload: evtPayload,
    ts: new Date(ins[0].created_at).getTime(),
  };
  const kv = getKv();
  if (kv) {
    try {
      await kv.lpush(NET_KV.streamList(body.roomId), evt);
      await kv.ltrim(NET_KV.streamList(body.roomId), 0, 199);
      await kv.incr(NET_KV.streamSeq(body.roomId));
    } catch (e) {
      console.warn("[net/state] KV fanout failed:", (e as Error)?.message);
    }
  }

  return NextResponse.json({
    ok: true,
    state: rows[0].state ?? {},
    version: stateVersion,
  });
}
