import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { q } from "@/lib/db";
import { z } from "zod";

export const runtime = "nodejs";

const Body = z.object({ roomId: z.string().regex(/^\d+$/) });

// Bumps last_seen_at so the SSE stream's periodic roster sweep keeps
// the player visible to other members. Idempotent and cheap — the
// runtime calls this every ~15s while in a room.
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

  const updated = await q<{ user_id: number }>(
    `UPDATE net_room_members SET last_seen_at = now()
      WHERE room_id=$1 AND user_id=$2 RETURNING user_id`,
    [body.roomId, userId]
  );
  if (!updated.length) {
    // Not currently a member. Don't 404 — heartbeats race with leave;
    // signal via the response so the client can stop pinging.
    return NextResponse.json({ ok: true, member: false });
  }
  return NextResponse.json({ ok: true, member: true });
}
