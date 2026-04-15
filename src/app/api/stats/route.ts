import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { q } from "@/lib/db";
import { loadCatalog, type AchievementDef } from "@/lib/achievements";
import { GAMES } from "@/lib/games";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type StatsPayload = {
  user: { id: number; handle: string; joinedAt: string | null };
  totals: {
    playtimeSeconds: number;
    sessions: number;
    games: number;
    saves: number;
    messages: number;
    achievements: number;
    achievementPoints: number;
  };
  perGame: Array<{
    slug: string;
    playtimeSeconds: number;
    sessions: number;
    saves: number;
    lastPlayedAt: string | null;
    achievements: { unlocked: number; total: number; points: number };
  }>;
  activity30d: Array<{ day: string; playtimeSeconds: number; messages: number }>;
  recentSaves: Array<{ game: string; path: string; updatedAt: string }>;
  recentSessions: Array<{ game: string; startedAt: string; seconds: number }>;
  achievements: Array<{
    game: string;
    catalog: AchievementDef[];
    unlocked: Array<{ key: string; unlockedAt: string; points: number }>;
  }>;
};

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const userId = Number(session.user.id);

  const userRow = (
    await q<{ id: number; name: string | null; email: string | null }>(
      `SELECT id, name, email FROM users WHERE id=$1`,
      [userId]
    )
  )[0];
  const joinedRow = (
    await q<{ min: Date }>(
      `SELECT MIN(started_at) AS min FROM game_sessions WHERE user_id=$1`,
      [userId]
    )
  )[0];

  const perGame = await q<{
    game_slug: string;
    sessions: string;
    seconds: string;
    last_played_at: Date | null;
  }>(
    `SELECT game_slug,
            COUNT(*)::text AS sessions,
            COALESCE(SUM(EXTRACT(EPOCH FROM (last_heartbeat - started_at))),0)::text AS seconds,
            MAX(last_heartbeat) AS last_played_at
     FROM game_sessions
     WHERE user_id=$1
     GROUP BY game_slug
     ORDER BY seconds DESC`,
    [userId]
  );

  const savesPerGame = await q<{ game_slug: string; n: string }>(
    `SELECT game_slug, COUNT(*)::text AS n
     FROM game_saves WHERE user_id=$1 GROUP BY game_slug`,
    [userId]
  );
  const savesMap = new Map(savesPerGame.map((r) => [r.game_slug, Number(r.n)]));

  // All unlocks for this user, one row per (game, key). We load catalogs
  // in parallel (per registered game) and stitch locally — cheaper than
  // joining through JSONB stored in postgres.
  const unlockRows = await q<{
    game_slug: string;
    achievement_key: string;
    unlocked_at: Date;
    points: number;
  }>(
    `SELECT game_slug, achievement_key, unlocked_at, points
       FROM user_achievements
      WHERE user_id=$1
      ORDER BY unlocked_at ASC`,
    [userId]
  );
  const catalogs = new Map<string, AchievementDef[]>();
  await Promise.all(
    GAMES.map(async (g) => {
      catalogs.set(g.slug, (await loadCatalog(g.slug))?.achievements ?? []);
    })
  );
  const unlocksByGame = new Map<
    string,
    Array<{ key: string; unlockedAt: string; points: number }>
  >();
  let totalAchPoints = 0;
  for (const u of unlockRows) {
    const bucket = unlocksByGame.get(u.game_slug) ?? [];
    bucket.push({
      key: u.achievement_key,
      unlockedAt: new Date(u.unlocked_at).toISOString(),
      points: u.points,
    });
    unlocksByGame.set(u.game_slug, bucket);
    totalAchPoints += u.points;
  }
  const achievementsSection = Array.from(catalogs.entries())
    .map(([game, catalog]) => ({
      game,
      catalog,
      unlocked: unlocksByGame.get(game) ?? [],
    }))
    // Hide games that declare no achievements AND have no unlocks — not
    // useful to render empty cards for them.
    .filter((a) => a.catalog.length > 0 || a.unlocked.length > 0);

  const totalsRow = (
    await q<{
      sessions: string;
      seconds: string;
      games: string;
      saves: string;
      messages: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM game_sessions WHERE user_id=$1)::text AS sessions,
         (SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (last_heartbeat - started_at))),0)
            FROM game_sessions WHERE user_id=$1)::text AS seconds,
         (SELECT COUNT(DISTINCT game_slug) FROM game_sessions WHERE user_id=$1)::text AS games,
         (SELECT COUNT(*) FROM game_saves WHERE user_id=$1)::text AS saves,
         (SELECT COUNT(*) FROM chat_messages WHERE user_id=$1)::text AS messages
      `,
      [userId]
    )
  )[0];

  // Last 30 days: bucket sessions + messages by day.
  const activity = await q<{ day: string; seconds: string; messages: string }>(
    `WITH days AS (
       SELECT generate_series(
         date_trunc('day', now() - interval '29 days'),
         date_trunc('day', now()),
         interval '1 day'
       ) AS day
     )
     SELECT
       to_char(d.day, 'YYYY-MM-DD') AS day,
       COALESCE((
         SELECT SUM(EXTRACT(EPOCH FROM (
           LEAST(gs.last_heartbeat, d.day + interval '1 day')
           - GREATEST(gs.started_at, d.day)
         )))
         FROM game_sessions gs
         WHERE gs.user_id=$1
           AND gs.started_at < d.day + interval '1 day'
           AND gs.last_heartbeat >= d.day
       ),0)::text AS seconds,
       COALESCE((
         SELECT COUNT(*) FROM chat_messages cm
         WHERE cm.user_id=$1
           AND cm.created_at >= d.day
           AND cm.created_at < d.day + interval '1 day'
       ),0)::text AS messages
     FROM days d
     ORDER BY d.day ASC`,
    [userId]
  );

  const recentSaves = await q<{ game_slug: string; path: string; updated_at: Date }>(
    `SELECT game_slug, path, updated_at FROM game_saves
     WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 10`,
    [userId]
  );

  const recentSessions = await q<{ game_slug: string; started_at: Date; seconds: string }>(
    `SELECT game_slug, started_at,
            EXTRACT(EPOCH FROM (last_heartbeat - started_at))::text AS seconds
     FROM game_sessions
     WHERE user_id=$1
     ORDER BY started_at DESC LIMIT 10`,
    [userId]
  );

  const payload: StatsPayload = {
    user: {
      id: userId,
      handle: userRow?.name ?? userRow?.email ?? `user-${userId}`,
      joinedAt: joinedRow?.min ? new Date(joinedRow.min).toISOString() : null,
    },
    totals: {
      playtimeSeconds: Math.round(Number(totalsRow.seconds)),
      sessions: Number(totalsRow.sessions),
      games: Number(totalsRow.games),
      saves: Number(totalsRow.saves),
      messages: Number(totalsRow.messages),
      achievements: unlockRows.length,
      achievementPoints: totalAchPoints,
    },
    perGame: perGame.map((r) => {
      const catalog = catalogs.get(r.game_slug) ?? [];
      const unlocked = unlocksByGame.get(r.game_slug) ?? [];
      return {
        slug: r.game_slug,
        playtimeSeconds: Math.round(Number(r.seconds)),
        sessions: Number(r.sessions),
        saves: savesMap.get(r.game_slug) ?? 0,
        lastPlayedAt: r.last_played_at ? new Date(r.last_played_at).toISOString() : null,
        achievements: {
          unlocked: unlocked.length,
          total: catalog.length,
          points: unlocked.reduce((s, u) => s + u.points, 0),
        },
      };
    }),
    activity30d: activity.map((a) => ({
      day: a.day,
      playtimeSeconds: Math.round(Math.max(0, Number(a.seconds))),
      messages: Number(a.messages),
    })),
    recentSaves: recentSaves.map((r) => ({
      game: r.game_slug,
      path: r.path,
      updatedAt: new Date(r.updated_at).toISOString(),
    })),
    recentSessions: recentSessions.map((r) => ({
      game: r.game_slug,
      startedAt: new Date(r.started_at).toISOString(),
      seconds: Math.round(Math.max(0, Number(r.seconds))),
    })),
    achievements: achievementsSection,
  };

  return NextResponse.json(payload);
}
