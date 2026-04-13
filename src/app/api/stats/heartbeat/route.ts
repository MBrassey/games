import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { q } from "@/lib/db";
import { z } from "zod";

export const runtime = "nodejs";

const Body = z.object({
  game: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
});

const GAP_SECONDS = 120; // new session if previous heartbeat is older

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = Body.parse(await req.json());
  const userId = Number(session.user.id);

  // Find the most recent session for this user+game.
  const rows = await q<{ id: string; last_heartbeat: Date }>(
    `SELECT id, last_heartbeat FROM game_sessions
     WHERE user_id=$1 AND game_slug=$2
     ORDER BY last_heartbeat DESC LIMIT 1`,
    [userId, b.game]
  );

  if (rows.length) {
    const last = new Date(rows[0].last_heartbeat).getTime();
    if (Date.now() - last <= GAP_SECONDS * 1000) {
      await q(
        `UPDATE game_sessions SET last_heartbeat=now() WHERE id=$1`,
        [rows[0].id]
      );
      return NextResponse.json({ ok: true, sessionId: rows[0].id, resumed: true });
    }
  }
  const ins = await q<{ id: string }>(
    `INSERT INTO game_sessions(user_id, game_slug) VALUES($1,$2) RETURNING id`,
    [userId, b.game]
  );
  return NextResponse.json({ ok: true, sessionId: ins[0].id, resumed: false });
}
