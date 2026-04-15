import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { q } from "@/lib/db";
import { findDef } from "@/lib/achievements";
import { z } from "zod";

export const runtime = "nodejs";

const Body = z.object({
  game: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
  key: z.string().min(1).max(64).regex(/^[a-z0-9_]+$/),
  meta: z.record(z.any()).optional(),
});

// Idempotent: unlocking the same achievement twice is a no-op (first write
// wins on `unlocked_at`). The response always reports the final state so
// the game can hydrate its UI regardless of whether this was the first
// unlock or a replay.
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

  // Reject unknown keys — the catalog is the allowlist. Without this a
  // compromised game client could spam arbitrary keys into the DB and
  // poison the leaderboard totals.
  const def = await findDef(body.game, body.key);
  if (!def) {
    return NextResponse.json(
      { error: "unknown achievement", game: body.game, key: body.key },
      { status: 404 }
    );
  }

  const rows = await q<{
    achievement_key: string;
    unlocked_at: Date;
    points: number;
    fresh: boolean;
  }>(
    `INSERT INTO user_achievements(user_id, game_slug, achievement_key, points, meta)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id, game_slug, achievement_key)
     DO UPDATE SET meta = user_achievements.meta
     RETURNING achievement_key,
               unlocked_at,
               points,
               (xmax = 0) AS fresh`,
    [userId, body.game, body.key, def.points ?? 10, body.meta ?? {}]
  );
  const row = rows[0];

  return NextResponse.json({
    ok: true,
    fresh: row.fresh,
    unlock: {
      game: body.game,
      key: row.achievement_key,
      unlockedAt: new Date(row.unlocked_at).toISOString(),
      points: row.points,
    },
    definition: def,
  });
}
