import Link from "next/link";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import TopBar from "@/components/TopBar";
import ChatDrawer from "@/components/ChatDrawer";
import Avatar from "@/components/Avatar";
import type { LeaderboardRow } from "@/app/api/leaderboard/route";

export const dynamic = "force-dynamic";

async function fetchBoard(): Promise<LeaderboardRow[]> {
  const h = await headers();
  const host = h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  const r = await fetch(`${proto}://${host}/api/leaderboard`, {
    cache: "no-store",
    headers: { cookie: h.get("cookie") ?? "" },
  });
  if (!r.ok) return [];
  const j = (await r.json()) as { leaderboard: LeaderboardRow[] };
  return j.leaderboard;
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
  const then = new Date(iso).getTime();
  const s = Math.floor((Date.now() - then) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

// Rank tier drives the medallion treatment:
//   • Podium (1–3): large numeral, breathing glow in medal color.
//   • High (4–10):  medium numeral, subtle purple glow.
//   • Low  (11+):   small subdued numeral.
// The shimmer pass is CSS-driven (see .rank-cell::before in globals.css).
function rankTier(rank: number): { color: string; kind: "podium" | "high" | "low" } {
  if (rank === 1) return { color: "#ffd54a", kind: "podium" };   // gold
  if (rank === 2) return { color: "#d8dce6", kind: "podium" };   // silver
  if (rank === 3) return { color: "#ff8c5a", kind: "podium" };   // bronze
  if (rank <= 10) return { color: "#8a4fff", kind: "high" };     // purple
  return { color: "#6b5f82", kind: "low" };                      // subdued
}

export default async function LeaderboardPage() {
  const session = await auth();
  const board = await fetchBoard();
  const meHandle = session?.user?.name ?? null;

  return (
    <>
      <TopBar />
      <ChatDrawer signedIn={!!session?.user?.id} meHandle={meHandle} />
      <main className="pr-0 md:pr-[380px]">
        <div className="mx-auto max-w-6xl px-6 py-8">
          <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
            <div>
              <div className="stamp text-eldritch-purple">ranked :: global</div>
              <h1 className="text-2xl tracking-[0.3em] uppercase text-bone mt-1">
                <span className="text-eldritch-purple">[</span> leaderboard <span className="text-eldritch-purple">]</span>
              </h1>
              <p className="text-sm text-bone/55 mt-1">
                operators ordered by total playtime across every title.
                Updated every request.
              </p>
            </div>
            <div className="text-[0.65rem] uppercase tracking-[0.25em] text-bone/50">
              {board.length.toString().padStart(3, "0")} / 100 operators
            </div>
          </div>
          <hr className="hr-dither mb-5" />

          {board.length === 0 ? (
            <p className="text-bone/40 text-sm">no operators on record yet.</p>
          ) : (
            <div className="panel overflow-hidden">
              {/* header row */}
              <div className="grid grid-cols-[56px_1fr_92px_68px_60px_60px_88px_68px_92px] items-center gap-3 px-4 py-2 border-b border-eldritch-deep/60 bg-void-1/60 text-[0.6rem] uppercase tracking-[0.25em] text-bone/45">
                <span>rank</span>
                <span>operator</span>
                <span className="text-right">playtime</span>
                <span className="text-right">sess</span>
                <span className="text-right">games</span>
                <span className="text-right">saves</span>
                <span className="text-right">achv · pts</span>
                <span className="text-right">msgs</span>
                <span className="text-right">last seen</span>
              </div>

              {board.map((r, i) => {
                const tier = rankTier(r.rank);
                const isMe = meHandle && r.handle === meHandle;
                const rankClass =
                  tier.kind === "podium" ? "rank-podium"
                  : tier.kind === "high"   ? "rank-high"
                  :                          "rank-low";
                return (
                  <div
                    key={r.userId}
                    className={`grid grid-cols-[56px_1fr_92px_68px_60px_60px_88px_68px_92px] items-center gap-3 px-4 py-2.5 transition-colors hover:bg-eldritch-purple/5 ${
                      i % 2 === 0 ? "bg-eldritch-deep/10" : ""
                    } ${isMe ? "ring-1 ring-inset ring-abyss-cyan/40" : ""}`}
                  >
                    <span
                      className={`rank-cell ${rankClass}`}
                      style={
                        tier.kind === "podium"
                          ? ({ "--rank-color": tier.color, color: tier.color } as React.CSSProperties)
                          : ({ "--rank-color": tier.color } as React.CSSProperties)
                      }
                    >
                      {r.rank}
                    </span>
                    <Link href={`/u/${encodeURIComponent(r.handle)}`} className="flex items-center gap-2.5 min-w-0 group">
                      <Avatar src={r.avatarUrl} handle={r.handle} size={30} radius={7} />
                      <div className="min-w-0">
                        <div className="font-mono text-sm text-bone truncate group-hover:text-abyss-cyan">
                          {r.handle}
                          {isMe && <span className="ml-2 text-[0.6rem] uppercase tracking-widest text-abyss-cyan">you</span>}
                        </div>
                        {r.githubLogin && r.githubLogin !== r.handle && (
                          <div className="text-[0.62rem] text-bone/40 truncate">@{r.githubLogin}</div>
                        )}
                      </div>
                    </Link>
                    <span className="text-right font-mono text-sm text-eldritch-purple tabular-nums" style={{ textShadow: "0 0 6px #8a4fff55" }}>
                      {fmtDur(r.playtimeSeconds)}
                    </span>
                    <span className="text-right font-mono text-xs text-bone/75 tabular-nums">{r.sessions}</span>
                    <span className="text-right font-mono text-xs text-bone/75 tabular-nums">{r.games}</span>
                    <span className="text-right font-mono text-xs text-bone/75 tabular-nums">{r.saves}</span>
                    <span
                      className="text-right font-mono text-xs tabular-nums"
                      style={{
                        color: r.achievementPoints > 0 ? "#ffd54a" : "#6b5f82",
                        textShadow: r.achievementPoints > 0 ? "0 0 6px #ffd54a55" : "none",
                      }}
                    >
                      {r.achievements}
                      <span className="text-bone/35"> · </span>
                      {r.achievementPoints}
                    </span>
                    <span className="text-right font-mono text-xs text-bone/75 tabular-nums">{r.messages}</span>
                    <span className="text-right font-mono text-[0.65rem] text-bone/45 tabular-nums">
                      {fmtDate(r.lastSeenAt)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          <p className="mt-4 text-[0.62rem] uppercase tracking-[0.25em] text-bone/35">
            ▸ click any operator to view their profile · tie-break order: playtime · achievement pts · sessions · messages
          </p>
        </div>
      </main>
    </>
  );
}
