import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { q } from "@/lib/db";
import { loadCatalog } from "@/lib/achievements";
import { GAMES } from "@/lib/games";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/achievements?game=<slug>          — catalog + caller's unlocks (if signed in)
// GET /api/achievements?game=<slug>&user=<id> — catalog + unlocks for any public user id
// GET /api/achievements                       — catalogs for every registered game
//                                               (no user data). Useful for the stats
//                                               aggregate view.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const game = searchParams.get("game");
  const userParam = searchParams.get("user");

  if (!game) {
    // Aggregate: catalogs for every game. No user unlocks — callers that
    // need those should pass ?game= for one game at a time.
    const catalogs = await Promise.all(
      GAMES.map(async (g) => ({
        game: g.slug,
        catalog: (await loadCatalog(g.slug))?.achievements ?? [],
      }))
    );
    return NextResponse.json({ catalogs });
  }

  const catalog = (await loadCatalog(game))?.achievements ?? [];

  // Figure out which user's unlocks to return. Explicit ?user= wins
  // (for public profile pages); otherwise fall back to the session.
  let userId: number | null = null;
  if (userParam) {
    const n = Number(userParam);
    if (Number.isFinite(n) && n > 0) userId = Math.floor(n);
  } else {
    const session = await auth();
    if (session?.user?.id) userId = Number(session.user.id);
  }

  if (!userId) {
    return NextResponse.json({ game, catalog, unlocks: [] });
  }

  const rows = await q<{
    achievement_key: string;
    unlocked_at: Date;
    points: number;
  }>(
    `SELECT achievement_key, unlocked_at, points
       FROM user_achievements
      WHERE user_id=$1 AND game_slug=$2
      ORDER BY unlocked_at ASC`,
    [userId, game]
  );

  const unlocks = rows.map((r) => ({
    key: r.achievement_key,
    unlockedAt: new Date(r.unlocked_at).toISOString(),
    points: r.points,
  }));

  return NextResponse.json({ game, catalog, unlocks });
}
