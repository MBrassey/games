import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import TopBar from "@/components/TopBar";
import ChatDrawer from "@/components/ChatDrawer";
import Avatar from "@/components/Avatar";
import { q } from "@/lib/db";
import { ActivityChart, PerGameChart } from "@/components/stats/StatsCharts";
import AchievementsPanel from "@/components/AchievementsPanel";
import type { StatsPayload } from "@/app/api/stats/route";

export const dynamic = "force-dynamic";

async function fetchStats(): Promise<StatsPayload | null> {
  // Server-component fetch needs the session cookie forwarded. Easiest
  // path: read the current request's cookie header and pass it along.
  const h = await headers();
  const host = h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  const cookie = h.get("cookie") ?? "";
  const r = await fetch(`${proto}://${host}/api/stats`, {
    cache: "no-store",
    headers: { cookie },
  });
  if (!r.ok) return null;
  return (await r.json()) as StatsPayload;
}

function fmtDur(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = m / 60;
  return `${h.toFixed(1)}h`;
}
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type ProfileRow = {
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

export default async function StatsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");
  const [stats, profile] = await Promise.all([
    fetchStats(),
    q<ProfileRow>(
      `SELECT handle, avatar_url, bio, github_login, location, blog, company,
              twitter, public_repos, followers, github_html_url
         FROM user_profiles WHERE user_id=$1`,
      [Number(session.user.id)]
    ).then((r) => r[0] ?? null),
  ]);

  const displayHandle = profile?.handle ?? stats?.user.handle ?? session.user.name ?? "operator";
  const avatarSrc = profile?.avatar_url ?? session.user.image ?? null;

  return (
    <>
      <TopBar />
      <ChatDrawer
        signedIn
        meHandle={displayHandle}
      />
      <main className="pr-0 md:pr-[380px]">
        <div className="mx-auto max-w-6xl px-6 py-8">
          {/* Profile hero — everything here is pulled straight from GitHub. */}
          <div className="flex flex-col md:flex-row items-start md:items-end gap-5 mb-5">
            <Avatar src={avatarSrc} handle={displayHandle} size={92} radius={18} />
            <div className="flex-1 min-w-0">
              <div className="stamp text-eldritch-purple">session :: telemetry</div>
              <h1 className="text-3xl tracking-[0.14em] uppercase text-bone mt-1 truncate">
                {displayHandle}
              </h1>
              {profile?.bio && <p className="text-sm text-bone/70 mt-1 max-w-2xl">{profile.bio}</p>}
              <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[0.68rem] uppercase tracking-[0.2em] text-bone/55">
                {profile?.github_login && (
                  <a href={profile.github_html_url ?? `https://github.com/${profile.github_login}`} target="_blank" rel="noreferrer" className="link-term">
                    @{profile.github_login}
                  </a>
                )}
                {profile?.location && <span>▸ {profile.location}</span>}
                {profile?.company && <span>▸ {profile.company}</span>}
                {profile?.blog && (
                  <a href={profile.blog.startsWith("http") ? profile.blog : `https://${profile.blog}`} target="_blank" rel="noreferrer" className="link-term">
                    ▸ {profile.blog}
                  </a>
                )}
                {typeof profile?.public_repos === "number" && <span>▸ {profile.public_repos} repos</span>}
                {typeof profile?.followers === "number" && <span>▸ {profile.followers} followers</span>}
                {stats?.user.joinedAt && <span>▸ since {fmtDate(stats.user.joinedAt)}</span>}
              </div>
            </div>
          </div>
          <hr className="hr-dither mb-6" />

          {/* KPI row */}
          <section className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-8">
            <Kpi label="playtime" value={fmtDur(stats?.totals.playtimeSeconds ?? 0)} accent="#8a4fff" />
            <Kpi label="sessions" value={String(stats?.totals.sessions ?? 0)} accent="#66e0ff" />
            <Kpi label="games" value={String(stats?.totals.games ?? 0)} accent="#33ff66" />
            <Kpi label="saves" value={String(stats?.totals.saves ?? 0)} accent="#ffb347" />
            <Kpi label="achv" value={`${stats?.totals.achievements ?? 0} · ${stats?.totals.achievementPoints ?? 0}p`} accent="#ffd54a" />
            <Kpi label="messages" value={String(stats?.totals.messages ?? 0)} accent="#ff6bd6" />
          </section>

          {/* Activity chart */}
          <section className="mb-10">
            <div className="flex items-end justify-between mb-2">
              <div>
                <div className="stamp">activity :: last 30 days</div>
                <h2 className="text-lg uppercase tracking-[0.25em] text-bone/85 mt-1">timeline</h2>
              </div>
            </div>
            <div className="panel p-4">
              {stats ? (
                <ActivityChart data={stats.activity30d} />
              ) : (
                <div className="text-bone/40 text-xs">no data</div>
              )}
            </div>
          </section>

          {/* Per-game bar chart */}
          <section className="mb-10">
            <div className="flex items-end justify-between mb-2">
              <div>
                <div className="stamp">library :: playtime breakdown</div>
                <h2 className="text-lg uppercase tracking-[0.25em] text-bone/85 mt-1">per game</h2>
              </div>
            </div>
            <div className="panel p-4">
              {stats ? (
                <PerGameChart data={stats.perGame} />
              ) : (
                <div className="text-bone/40 text-xs">no data</div>
              )}
            </div>
          </section>

          {/* Achievements section — one card per game with at least one
              published achievement or unlock. Hidden entirely if no games
              match. */}
          {stats && stats.achievements.length > 0 && (
            <section className="mb-10">
              <div className="flex items-end justify-between mb-2">
                <div>
                  <div className="stamp text-amber-signal">trophies :: unlocked</div>
                  <h2 className="text-lg uppercase tracking-[0.25em] text-bone/85 mt-1">achievements</h2>
                </div>
              </div>
              <AchievementsPanel groups={stats.achievements} />
            </section>
          )}

          {/* Two-up: recent sessions + recent saves */}
          <section className="grid md:grid-cols-2 gap-5">
            <div className="panel p-4">
              <div className="stamp mb-3">recent :: sessions</div>
              {stats?.recentSessions.length ? (
                <ul className="space-y-2 text-sm">
                  {stats.recentSessions.map((s, i) => (
                    <li key={i} className="flex justify-between gap-3 border-b border-eldritch-deep/40 pb-1.5">
                      <span className="text-abyss-cyan">{s.game}</span>
                      <span className="text-bone/55">{fmtDate(s.startedAt)}</span>
                      <span className="text-amber-signal">{fmtDur(s.seconds)}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-bone/40 text-xs">no sessions yet.</p>}
            </div>
            <div className="panel p-4">
              <div className="stamp mb-3">recent :: saves</div>
              {stats?.recentSaves.length ? (
                <ul className="space-y-2 text-sm">
                  {stats.recentSaves.map((s, i) => (
                    <li key={i} className="flex justify-between gap-3 border-b border-eldritch-deep/40 pb-1.5">
                      <span className="text-abyss-cyan">{s.game}</span>
                      <span className="text-bone/70 text-xs truncate flex-1">{s.path}</span>
                      <span className="text-bone/55">{fmtDate(s.updatedAt)}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-bone/40 text-xs">no saves yet.</p>}
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
