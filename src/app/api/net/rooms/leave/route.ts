import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { q } from "@/lib/db";
import { getKv, NET_KV, type NetEvent } from "@/lib/kv";
import { z } from "zod";

export const runtime = "nodejs";

const Body = z.object({ roomId: z.string().regex(/^\d+$/) });

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

  const removed = await q<{ user_id: number }>(
    `DELETE FROM net_room_members WHERE room_id=$1 AND user_id=$2 RETURNING user_id`,
    [body.roomId, userId]
  );
  if (!removed.length) {
    // Idempotent — already left or never joined. Don't 404; the runtime
    // calls this on tab close as a best-effort, and surfacing a 404 just
    // looks like a bug in the logs.
    return NextResponse.json({ ok: true, alreadyLeft: true });
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

  const ins = await q<{ id: string; created_at: Date }>(
    `INSERT INTO net_room_events(room_id, user_id, verb, payload)
     VALUES ($1,$2,'leave',$3) RETURNING id, created_at`,
    [body.roomId, userId, JSON.stringify({ handle, avatar })]
  );
  const evt: NetEvent = {
    id: String(ins[0].id),
    roomId: body.roomId,
    userId: String(userId),
    handle,
    avatar,
    verb: "leave",
    payload: { handle, avatar },
    ts: new Date(ins[0].created_at).getTime(),
  };
  const kv = getKv();
  if (kv) {
    try {
      await kv.lpush(NET_KV.streamList(body.roomId), evt);
      await kv.ltrim(NET_KV.streamList(body.roomId), 0, 199);
      await kv.incr(NET_KV.streamSeq(body.roomId));
      await kv.incr(NET_KV.rosterSeq(body.roomId));
    } catch (e) {
      console.warn("[net/leave] KV fanout failed:", (e as Error)?.message);
    }
  }

  return NextResponse.json({ ok: true });
}
