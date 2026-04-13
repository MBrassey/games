import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import TopBar from "@/components/TopBar";
import ChatDrawer from "@/components/ChatDrawer";
import Avatar from "@/components/Avatar";
import { q } from "@/lib/db";
import { ActivityChart, PerGameChart } from "@/components/stats/StatsCharts";

export const dynamic = "force-dynamic";

type ProfileRow = {
  user_id: number;
  handle: string | null;
  avatar_url: string | null;
  bio: string | null;
  github_login: string | null;
  location: string | null;
  blog: string | null;
  company: string | null;
  twitter: string | null;
  public_repos: number | null;
  followers: number | null;
  github_html_url: string | null;
};

function fmtDur(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${(m / 60).toFixed(1)}h`;
}
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default async function UserProfilePage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle: raw } = await params;
  const handle = decodeURIComponent(raw);
  const session = await auth();
  const meHandle = session?.user?.name ?? null;

  // Look up by handle OR github_login (handle usually = github login, but
  // keep both lookups to be forgiving about case + aliases).
  const profiles = await q<ProfileRow>(
    `SELECT user_id, handle, avatar_url, bio, github_login, location, blog,
            company, twitter, public_repos, followers, github_html_url
       FROM user_profiles
      WHERE handle ILIKE $1 OR github_login ILIKE $1
      LIMIT 1`,
    [handle]
  );
  const profile = profiles[0];
  if (!profile) notFound();

  const userId = profile.user_id;
  const displayHandle = profile.handle ?? profile.github_login ?? handle;

  // Pull public stats directly (not via /api/stats which is session-gated).
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
    `SELECT game_slug, COUNT(*)::text AS n FROM game_saves WHERE user_id=$1 GROUP BY game_slug`,
    [userId]
  );
  const savesMap = new Map(savesPerGame.map((r) => [r.game_slug, Number(r.n)]));

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

  const firstSeenRow = (
    await q<{ min: Date | null }>(
      `SELECT MIN(started_at) AS min FROM game_sessions WHERE user_id=$1`,
      [userId]
    )
  )[0];
  const firstSeen = firstSeenRow?.min ? new Date(firstSeenRow.min).toISOString() : null;

  const payload = {
    totals: {
      playtimeSeconds: Math.round(Number(totalsRow.seconds)),
      sessions: Number(totalsRow.sessions),
      games: Number(totalsRow.games),
      saves: Number(totalsRow.saves),
      messages: Number(totalsRow.messages),
    },
    perGame: perGame.map((r) => ({
      slug: r.game_slug,
      playtimeSeconds: Math.round(Number(r.seconds)),
      sessions: Number(r.sessions),
      saves: savesMap.get(r.game_slug) ?? 0,
      lastPlayedAt: r.last_played_at ? new Date(r.last_played_at).toISOString() : null,
    })),
    activity30d: activity.map((a) => ({
      day: a.day,
      playtimeSeconds: Math.round(Math.max(0, Number(a.seconds))),
      messages: Number(a.messages),
    })),
  };

  return (
    <>
      <TopBar />
      <ChatDrawer signedIn={!!session?.user?.id} meHandle={meHandle} />
      <main className="pr-0 md:pr-[380px]">
        <div className="mx-auto max-w-6xl px-6 py-8">
          <div className="flex flex-col md:flex-row items-start md:items-end gap-5 mb-5">
            <Avatar src={profile.avatar_url} handle={displayHandle} size={92} radius={18} />
            <div className="flex-1 min-w-0">
              <div className="stamp text-eldritch-purple">operator :: profile</div>
              <h1 className="text-3xl tracking-[0.14em] uppercase text-bone mt-1 truncate">
                {displayHandle}
              </h1>
              {profile.bio && <p className="text-sm text-bone/70 mt-1 max-w-2xl">{profile.bio}</p>}
              <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[0.68rem] uppercase tracking-[0.2em] text-bone/55">
                {profile.github_login && (
                  <a href={profile.github_html_url ?? `https://github.com/${profile.github_login}`} target="_blank" rel="noreferrer" className="link-term">
                    @{profile.github_login}
                  </a>
                )}
                {profile.location && <span>▸ {profile.location}</span>}
                {profile.company && <span>▸ {profile.company}</span>}
                {profile.blog && (
                  <a href={profile.blog.startsWith("http") ? profile.blog : `https://${profile.blog}`} target="_blank" rel="noreferrer" className="link-term">
                    ▸ {profile.blog}
                  </a>
                )}
                {typeof profile.public_repos === "number" && <span>▸ {profile.public_repos} repos</span>}
                {typeof profile.followers === "number" && <span>▸ {profile.followers} followers</span>}
                {firstSeen && <span>▸ since {fmtDate(firstSeen)}</span>}
              </div>
            </div>
          </div>
          <hr className="hr-dither mb-6" />

          <section className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-8">
            <Kpi label="playtime" value={fmtDur(payload.totals.playtimeSeconds)} accent="#8a4fff" />
            <Kpi label="sessions" value={String(payload.totals.sessions)} accent="#66e0ff" />
            <Kpi label="games" value={String(payload.totals.games)} accent="#33ff66" />
            <Kpi label="saves" value={String(payload.totals.saves)} accent="#ffb347" />
            <Kpi label="messages" value={String(payload.totals.messages)} accent="#ff6bd6" />
          </section>

          <section className="mb-10">
            <div className="stamp mb-1">activity :: last 30 days</div>
            <div className="panel p-4">
              <ActivityChart data={payload.activity30d} />
            </div>
          </section>

          <section className="mb-10">
            <div className="stamp mb-1">library :: playtime breakdown</div>
            <div className="panel p-4">
              <PerGameChart data={payload.perGame} />
            </div>
          </section>
        </div>
      </main>
    </>
  );
}

function Kpi({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div className="panel relative p-4 overflow-hidden">
      <span className="absolute left-0 top-0 h-3 w-3 border-l border-t" style={{ borderColor: accent }} />
      <span className="absolute right-0 top-0 h-3 w-3 border-r border-t" style={{ borderColor: accent }} />
      <span className="absolute left-0 bottom-0 h-3 w-3 border-l border-b" style={{ borderColor: accent }} />
      <span className="absolute right-0 bottom-0 h-3 w-3 border-r border-b" style={{ borderColor: accent }} />
      <div className="stamp" style={{ color: accent }}>{label}</div>
      <div
        className="mt-2 text-2xl font-mono tracking-[0.05em] text-bone"
        style={{ textShadow: `0 0 8px ${accent}88` }}
      >
        {value}
      </div>
    </div>
  );
}
