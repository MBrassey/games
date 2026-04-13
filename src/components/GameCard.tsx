import Link from "next/link";
import type { GameEntry } from "@/lib/games";

export default function GameCard({ game }: { game: GameEntry }) {
  const disabled = game.status !== "live";
  return (
    <Link
      href={disabled ? "#" : `/games/${game.slug}`}
      className={`group relative block overflow-hidden border border-eldritch-deep/60 bg-void-1/70 p-5 transition-all hover:border-eldritch-purple hover:panel-glow ${disabled ? "is-disabled" : ""}`}
      style={{ boxShadow: `inset 0 0 0 1px rgba(138,79,255,0.08)` }}
    >
      {/* corner brackets */}
      <span className="pointer-events-none absolute left-0 top-0 h-3 w-3 border-l border-t" style={{ borderColor: game.accentColor }} />
      <span className="pointer-events-none absolute right-0 top-0 h-3 w-3 border-r border-t" style={{ borderColor: game.accentColor }} />
      <span className="pointer-events-none absolute left-0 bottom-0 h-3 w-3 border-l border-b" style={{ borderColor: game.accentColor }} />
      <span className="pointer-events-none absolute right-0 bottom-0 h-3 w-3 border-r border-b" style={{ borderColor: game.accentColor }} />

      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="stamp flex items-center gap-2" style={{ color: game.accentColor }}>
            <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: game.accentColor, boxShadow: `0 0 8px ${game.accentColor}` }} />
            {game.codename}
          </div>
          <h3 className="mt-2 text-lg tracking-wider text-bone" style={{ textShadow: `0 0 8px ${game.accentColor}55` }}>
            {game.title}
          </h3>
          <p className="mt-1 text-xs text-bone/60 leading-relaxed">{game.tagline}</p>
        </div>
        <StatusPill status={game.status} />
      </div>

      <div className="mt-4 flex flex-wrap gap-1.5">
        {game.tags.map((t) => (
          <span key={t} className="border border-eldritch-deep/60 bg-void-2/60 px-1.5 py-0.5 text-[0.6rem] uppercase tracking-[0.2em] text-bone/60">
            {t}
          </span>
        ))}
      </div>

      <div className="mt-5 flex items-center justify-between border-t border-eldritch-deep/40 pt-3 text-[0.65rem] uppercase tracking-[0.2em] text-bone/50">
        <span>v{game.version}</span>
        <span>{game.multiplayer}</span>
        <span className="text-abyss-cyan group-hover:glow-cyan">▸ launch</span>
      </div>
    </Link>
  );
}

function StatusPill({ status }: { status: GameEntry["status"] }) {
  const map = {
    live: { label: "LIVE", color: "#33ff66" },
    beta: { label: "BETA", color: "#ffb347" },
    soon: { label: "SOON", color: "#6b5f82" },
  } as const;
  const s = map[status];
  return (
    <span
      className="border px-2 py-0.5 text-[0.6rem] uppercase tracking-[0.25em]"
      style={{ color: s.color, borderColor: `${s.color}66`, boxShadow: `0 0 10px ${s.color}22` }}
    >
      {s.label}
    </span>
  );
}
