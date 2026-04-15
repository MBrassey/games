import type { AchievementDef } from "@/lib/achievements";
import { getGame } from "@/lib/games";

type GameGroup = {
  game: string;
  catalog: AchievementDef[];
  unlocked: Array<{ key: string; unlockedAt: string; points: number }>;
};

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

// Rarity drives the tile's glow color. Legendary is warmer than the
// portal's purple accent on purpose — a legendary unlock should read
// differently from the game's own branding.
const RARITY_COLOR: Record<string, string> = {
  common: "#8a8a9e",
  uncommon: "#33ff66",
  rare: "#66e0ff",
  legendary: "#ffd54a",
};

// Common achievements glow in the game's own accent (cohesive with the
// game's branding); higher rarities always use the rarity palette above
// so a legendary in any game reads as "legendary" at a glance.
function glowColor(rarity: string | undefined, accent: string): string {
  const r = rarity ?? "common";
  if (r === "common") return accent;
  return RARITY_COLOR[r] ?? accent;
}

// Shared renderer for both the signed-in stats page and public profile
// pages. Pure server component — caller is responsible for shaping the
// `groups` array.
export default function AchievementsPanel({ groups }: { groups: GameGroup[] }) {
  if (!groups.length) {
    return (
      <p className="text-bone/40 text-xs">
        no achievements defined for any played game yet.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {groups.map((g) => {
        const meta = getGame(g.game);
        const accent = meta?.accentColor ?? "#8a4fff";
        const unlockedMap = new Map(g.unlocked.map((u) => [u.key, u]));
        const totalPoints = g.catalog.reduce((s, a) => s + (a.points ?? 10), 0);
        const earnedPoints = g.unlocked.reduce((s, u) => s + u.points, 0);

        return (
          <div key={g.game} className="panel p-4">
            <div className="flex items-baseline justify-between gap-3 mb-3 flex-wrap">
              <div>
                <div className="stamp" style={{ color: accent }}>
                  {meta?.title ?? g.game}
                </div>
                <h3 className="text-sm uppercase tracking-[0.22em] text-bone/80 mt-0.5">
                  achievements
                </h3>
              </div>
              <div className="text-[0.65rem] uppercase tracking-[0.22em] text-bone/55 font-mono tabular-nums">
                {g.unlocked.length} / {g.catalog.length}
                <span className="text-bone/30 mx-2">·</span>
                <span style={{ color: accent }}>{earnedPoints}</span>
                <span className="text-bone/30"> / {totalPoints} pts</span>
              </div>
            </div>

            {g.catalog.length === 0 ? (
              <p className="text-bone/40 text-xs">
                this game hasn&apos;t published an achievement catalog yet.
              </p>
            ) : (
              <ul className="grid sm:grid-cols-2 gap-2">
                {g.catalog.map((a) => {
                  const unlocked = unlockedMap.get(a.key);
                  const isLocked = !unlocked;
                  const hide = a.hidden && isLocked;
                  const rarityColor = RARITY_COLOR[a.rarity ?? "common"] ?? RARITY_COLOR.common;
                  const glow = glowColor(a.rarity, accent);
                  const isLegendary = a.rarity === "legendary";

                  return (
                    <li
                      key={a.key}
                      className={`ach-tile flex gap-3 items-start border border-eldritch-deep/40 p-2.5 bg-void-1/40 ${
                        isLocked
                          ? "opacity-55"
                          : `ach-tile-unlocked ${isLegendary ? "ach-tile-legendary" : ""}`
                      }`}
                      style={
                        !isLocked
                          ? ({ "--ach-glow": glow } as React.CSSProperties)
                          : undefined
                      }
                    >
                      <div
                        className={`flex-shrink-0 w-10 h-10 flex items-center justify-center font-mono text-xl border border-eldritch-deep/60 bg-void-0 ${
                          !isLocked ? "ach-icon-unlocked" : ""
                        }`}
                        style={
                          isLocked
                            ? { color: "#4a4560" }
                            : undefined
                        }
                      >
                        {a.icon ? (
                          /* eslint-disable-next-line @next/next/no-img-element */
                          <img
                            src={`/games/${g.game}/${a.icon}`}
                            alt=""
                            className="w-8 h-8 object-contain relative z-[1]"
                            style={{
                              filter: isLocked
                                ? "grayscale(1) brightness(0.4)"
                                : `drop-shadow(0 0 4px ${glow}aa)`,
                            }}
                          />
                        ) : (
                          <span className="relative z-[1]">{hide ? "?" : a.glyph ?? "★"}</span>
                        )}
                      </div>
                      <div className="min-w-0 flex-1 relative z-[1]">
                        <div className="flex items-baseline gap-2 flex-wrap">
                          <span
                            className="text-sm text-bone truncate"
                            style={!isLocked ? { textShadow: `0 0 6px ${glow}66` } : undefined}
                          >
                            {hide ? "??? hidden achievement" : a.title}
                          </span>
                          <span
                            className="text-[0.58rem] uppercase tracking-[0.18em]"
                            style={{
                              color: rarityColor,
                              textShadow: !isLocked
                                ? `0 0 6px ${rarityColor}55`
                                : undefined,
                            }}
                          >
                            {a.rarity ?? "common"}
                          </span>
                          <span className="text-[0.62rem] font-mono text-bone/45 tabular-nums ml-auto">
                            {a.points ?? 10} pts
                          </span>
                        </div>
                        <p className="text-[0.7rem] text-bone/55 mt-0.5 leading-snug">
                          {hide ? "complete to reveal" : a.description || ""}
                        </p>
                        {unlocked && (
                          <p
                            className="text-[0.58rem] uppercase tracking-[0.18em] mt-1 font-mono"
                            style={{ color: glow, textShadow: `0 0 6px ${glow}66` }}
                          >
                            ▸ unlocked {fmtDate(unlocked.unlockedAt)}
                          </p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
