import { NextResponse } from "next/server";
import { q } from "@/lib/db";
import { GAMES } from "@/lib/games";
import {
  SLUG_ACTIVE_WINDOW_MS,
  SLUG_PRESENCE_TOP_DEFAULT,
  SLUG_PRESENCE_TOP_MAX,
} from "@/lib/net";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ProfileRow = {
  user_id: number;
  handle: string | null;
  github_login: string | null;
  name: string | null;
  avatar_url: string | null;
  image: string | null;
  data: string | null;          // base64-encoded JSON from game_saves
  last_seen_at: Date | null;
};

function decodeProfile(raw: string | null): unknown | null {
  if (!raw) return null;
  try {
    const json = Buffer.from(raw, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// GET /api/net/slug/presence?game=<slug>
//   &rankBy=<top-level numeric field of public_profile.json>  (optional)
//   &limit=<n>                                                (optional, default 20)
//
// Counts and a Top-N facility list scoped to one game. Generic across
// any portal-hosted LÖVE2D game: each user's public_profile.json (the
// game writes whatever it wants there via love.filesystem.write) is
// embedded as the `profile` field of every top-N entry. The optional
// `rankBy` param sorts by that JSON field's numeric value descending;
// without it, ranking is by recency of last activity.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const game = searchParams.get("game");
  const rankBy = searchParams.get("rankBy") || null;
  const limit = Math.min(
    SLUG_PRESENCE_TOP_MAX,
    Math.max(1, Number(searchParams.get("limit")) || SLUG_PRESENCE_TOP_DEFAULT)
  );
  if (!game) {
    return NextResponse.json({ error: "game required" }, { status: 400 });
  }
  if (!GAMES.find((g) => g.slug === game)) {
    return NextResponse.json({ error: "unknown game" }, { status: 404 });
  }

  // Aggregate counts. last24h is taken from net_room_events + slug
  // events together so a player who's been broadcasting but hasn't
  // joined a room still counts.
  const counts = (
    await q<{
      active_users: string;
      total_rooms: string;
      last24h_users: string;
      all_time_users: string;
    }>(
      `SELECT
         (SELECT COUNT(DISTINCT m.user_id)
            FROM net_room_members m
            JOIN net_rooms r ON r.id = m.room_id
           WHERE r.game_slug = $1
             AND m.last_seen_at > now() - ($2 || ' milliseconds')::interval
         )::text AS active_users,
         (SELECT COUNT(*)
            FROM net_rooms
           WHERE game_slug = $1
             AND closed_at IS NULL
         )::text AS total_rooms,
         (SELECT COUNT(DISTINCT u)
            FROM (
              SELECT e.user_id AS u
                FROM net_room_events e
                JOIN net_rooms r ON r.id = e.room_id
               WHERE r.game_slug = $1
                 AND e.user_id IS NOT NULL
                 AND e.created_at > now() - interval '24 hours'
              UNION
              SELECT s.user_id
                FROM net_slug_events s
               WHERE s.game_slug = $1
                 AND s.user_id IS NOT NULL
                 AND s.created_at > now() - interval '24 hours'
              UNION
              SELECT m.user_id
                FROM net_room_members m
                JOIN net_rooms r ON r.id = m.room_id
               WHERE r.game_slug = $1
                 AND m.last_seen_at > now() - interval '24 hours'
            ) sub
         )::text AS last24h_users,
         (SELECT COUNT(DISTINCT u)
            FROM (
              SELECT e.user_id AS u
                FROM net_room_events e
                JOIN net_rooms r ON r.id = e.room_id
               WHERE r.game_slug = $1 AND e.user_id IS NOT NULL
              UNION
              SELECT s.user_id
                FROM net_slug_events s
               WHERE s.game_slug = $1 AND s.user_id IS NOT NULL
              UNION
              SELECT m.user_id
                FROM net_room_members m
                JOIN net_rooms r ON r.id = m.room_id
               WHERE r.game_slug = $1
              UNION
              SELECT gs.user_id
                FROM game_saves gs
               WHERE gs.game_slug = $1
            ) sub
         )::text AS all_time_users`,
      [game, String(SLUG_ACTIVE_WINDOW_MS)]
    )
  )[0];

  // Top-N candidates. We pull anyone who has either (a) a public_profile
  // saved for the game, or (b) recent activity in the last 24h. Profile
  // is read straight out of game_saves where path = 'public_profile.json'.
  // Sorting by a profile field is done in JS after decode — Postgres
  // jsonb path indexing on game_saves.data isn't worth maintaining for
  // a list capped at SLUG_PRESENCE_TOP_MAX.
  const candidates = await q<ProfileRow>(
    `WITH active AS (
       SELECT m.user_id, MAX(m.last_seen_at) AS last_seen_at
         FROM net_room_members m
         JOIN net_rooms r ON r.id = m.room_id
        WHERE r.game_slug = $1
        GROUP BY m.user_id
       UNION
       SELECT s.user_id, MAX(s.created_at) AS last_seen_at
         FROM net_slug_events s
        WHERE s.game_slug = $1 AND s.user_id IS NOT NULL
        GROUP BY s.user_id
       UNION
       SELECT gs.user_id, MAX(gs.updated_at) AS last_seen_at
         FROM game_saves gs
        WHERE gs.game_slug = $1 AND gs.path = 'public_profile.json'
        GROUP BY gs.user_id
     )
     SELECT a.user_id,
            up.handle, up.github_login, up.avatar_url,
            u.name, u.image,
            (SELECT data FROM game_saves
              WHERE user_id = a.user_id
                AND game_slug = $1
                AND path = 'public_profile.json'
              LIMIT 1) AS data,
            MAX(a.last_seen_at) AS last_seen_at
       FROM active a
       JOIN users u ON u.id = a.user_id
       LEFT JOIN user_profiles up ON up.user_id = u.id
      GROUP BY a.user_id, up.handle, up.github_login, up.avatar_url, u.name, u.image
      ORDER BY MAX(a.last_seen_at) DESC NULLS LAST
      LIMIT $2`,
    [game, Math.max(limit * 4, 60)]
  );

  type TopEntry = {
    userId: string;
    handle: string;
    avatar: string | null;
    profile: unknown | null;
    lastSeenAt: string | null;
  };
  let top: TopEntry[] = candidates.map((r) => ({
    userId: String(r.user_id),
    handle: r.handle ?? r.github_login ?? r.name ?? `user-${r.user_id}`,
    avatar: r.avatar_url ?? r.image ?? null,
    profile: decodeProfile(r.data),
    lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at).toISOString() : null,
  }));
  if (rankBy && /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(rankBy)) {
    top.sort((a, b) => {
      const av = (a.profile && typeof a.profile === "object" && rankBy in (a.profile as Record<string, unknown>))
        ? Number((a.profile as Record<string, unknown>)[rankBy]) : -Infinity;
      const bv = (b.profile && typeof b.profile === "object" && rankBy in (b.profile as Record<string, unknown>))
        ? Number((b.profile as Record<string, unknown>)[rankBy]) : -Infinity;
      return (Number.isFinite(bv) ? bv : -Infinity) - (Number.isFinite(av) ? av : -Infinity);
    });
  }
  top = top.slice(0, limit);

  return NextResponse.json({
    slug: game,
    activeUsers: Number(counts.active_users),
    totalRooms: Number(counts.total_rooms),
    last24hUsers: Number(counts.last24h_users),
    allTimeUsers: Number(counts.all_time_users),
    topUsers: top,
    rankBy: rankBy || null,
    at: Date.now(),
  });
}
