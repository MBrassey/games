import { NextResponse } from "next/server";
import { q } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type LeaderboardRow = {
  rank: number;
  userId: number;
  handle: string;
  avatarUrl: string | null;
  githubLogin: string | null;
  playtimeSeconds: number;
  sessions: number;
  games: number;
  saves: number;
  messages: number;
  achievements: number;
  achievementPoints: number;
  lastSeenAt: string | null;
};

// Rank is assigned by playtime desc — that's the load-bearing engagement
// metric for a game portal. Achievement points slot in as the secondary
// tie-break ahead of sessions/messages so dedicated completionists surface
// above raw idle time when playtime is identical.
export async function GET() {
  const rows = await q<{
    user_id: number;
    handle: string | null;
    avatar_url: string | null;
    github_login: string | null;
    seconds: string;
    sessions: string;
    games: string;
    saves: string;
    messages: string;
    achievements: string;
    achievement_points: string;
    last_seen_at: Date | null;
  }>(
    `SELECT
       up.user_id,
       up.handle,
       up.avatar_url,
       up.github_login,
       COALESCE(ss.seconds, 0)::text                AS seconds,
       COALESCE(ss.sessions, 0)::text               AS sessions,
       COALESCE(ss.games, 0)::text                  AS games,
       COALESCE(sv.saves, 0)::text                  AS saves,
       COALESCE(cm.messages, 0)::text               AS messages,
       COALESCE(ua.achievements, 0)::text           AS achievements,
       COALESCE(ua.achievement_points, 0)::text     AS achievement_points,
       GREATEST(ss.last_seen, cm.last_seen, up.last_seen_at) AS last_seen_at
     FROM user_profiles up
     LEFT JOIN LATERAL (
       SELECT
         COALESCE(SUM(EXTRACT(EPOCH FROM (last_heartbeat - started_at))), 0) AS seconds,
         COUNT(*) AS sessions,
         COUNT(DISTINCT game_slug) AS games,
         MAX(last_heartbeat) AS last_seen
       FROM game_sessions WHERE user_id = up.user_id
     ) ss ON true
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS saves FROM game_saves WHERE user_id = up.user_id
     ) sv ON true
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS messages, MAX(created_at) AS last_seen
       FROM chat_messages WHERE user_id = up.user_id
     ) cm ON true
     LEFT JOIN LATERAL (
       SELECT
         COUNT(*) AS achievements,
         COALESCE(SUM(points), 0) AS achievement_points
       FROM user_achievements WHERE user_id = up.user_id
     ) ua ON true
     ORDER BY
       COALESCE(ss.seconds, 0) DESC,
       COALESCE(ua.achievement_points, 0) DESC,
       COALESCE(ss.sessions, 0) DESC,
       COALESCE(cm.messages, 0) DESC,
       up.user_id ASC
     LIMIT 100`
  );

  const leaderboard: LeaderboardRow[] = rows.map((r, i) => ({
    rank: i + 1,
    userId: r.user_id,
    handle: r.handle ?? r.github_login ?? `user-${r.user_id}`,
    avatarUrl: r.avatar_url,
    githubLogin: r.github_login,
    playtimeSeconds: Math.round(Number(r.seconds)),
    sessions: Number(r.sessions),
    games: Number(r.games),
    saves: Number(r.saves),
    messages: Number(r.messages),
    achievements: Number(r.achievements),
    achievementPoints: Number(r.achievement_points),
    lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at).toISOString() : null,
  }));

  return NextResponse.json({ leaderboard });
}
