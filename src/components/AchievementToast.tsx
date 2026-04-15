"use client";

import { useEffect, useState } from "react";
import type { AchievementDef } from "@/lib/achievements";

export type ToastItem = {
  id: string;
  game: string;         // slug, used to resolve the icon URL
  def: AchievementDef;
  points: number;
  fresh: boolean;       // true = first unlock (show); false = replay (skip)
};

// Per-rarity color. Matches the AchievementsPanel grid so the toast
// color-matches the card that will glow on the /stats page right after.
const RARITY_COLOR: Record<string, string> = {
  common: "#8a8a9e",
  uncommon: "#33ff66",
  rare: "#66e0ff",
  legendary: "#ffd54a",
};

function glowFor(def: AchievementDef, fallback: string): string {
  const r = def.rarity ?? "common";
  return r === "common" ? fallback : (RARITY_COLOR[r] ?? fallback);
}

// Single toast: slides in, auto-dismisses after DWELL_MS, slides out.
// onDone fires once per toast when its exit transition completes, so the
// parent can drop it from the queue.
function Toast({
  item,
  accent,
  onDone,
}: {
  item: ToastItem;
  accent: string;
  onDone: (id: string) => void;
}) {
  const DWELL_MS = 5200;
  const EXIT_MS = 420;

  const [phase, setPhase] = useState<"enter" | "idle" | "exit">("enter");

  useEffect(() => {
    // Two RAFs so the initial "enter" state paints before we transition
    // to "idle" — prevents the slide-in getting skipped when the browser
    // coalesces initial layout.
    let r1: number | null = null;
    let r2: number | null = null;
    r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(() => setPhase("idle"));
    });
    const dwell = window.setTimeout(() => setPhase("exit"), DWELL_MS);
    const done = window.setTimeout(() => onDone(item.id), DWELL_MS + EXIT_MS);
    return () => {
      if (r1) cancelAnimationFrame(r1);
      if (r2) cancelAnimationFrame(r2);
      clearTimeout(dwell);
      clearTimeout(done);
    };
  }, [item.id, onDone]);

  const glow = glowFor(item.def, accent);
  const rarity = item.def.rarity ?? "common";
  const isLegendary = rarity === "legendary";

  const translate =
    phase === "enter" ? "translate-x-[120%] opacity-0"
    : phase === "exit" ? "translate-x-[120%] opacity-0"
    : "translate-x-0 opacity-100";

  return (
    <div
      className={`ach-toast ${isLegendary ? "ach-toast-legendary" : ""} pointer-events-auto flex gap-3 items-center p-3 pr-5 border backdrop-blur-md transition-all duration-[420ms] ease-[cubic-bezier(0.22,1,0.36,1)] ${translate}`}
      style={
        {
          "--ach-glow": glow,
          minWidth: "320px",
          maxWidth: "420px",
        } as React.CSSProperties
      }
      role="status"
      aria-live="polite"
      onClick={() => setPhase("exit")}
    >
      {/* Icon */}
      <div className="ach-toast-icon flex-shrink-0 w-12 h-12 flex items-center justify-center font-mono text-2xl border border-eldritch-deep/60 bg-void-0 relative z-[1]">
        {item.def.icon ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={`/games/${item.game}/${item.def.icon}`}
            alt=""
            className="w-9 h-9 object-contain"
            style={{ filter: `drop-shadow(0 0 6px ${glow}cc)` }}
          />
        ) : (
          <span>{item.def.glyph ?? "★"}</span>
        )}
      </div>

      {/* Text */}
      <div className="min-w-0 flex-1 relative z-[1]">
        <div
          className="text-[0.6rem] uppercase tracking-[0.28em] font-mono"
          style={{ color: glow, textShadow: `0 0 6px ${glow}66` }}
        >
          ▸ achievement unlocked
        </div>
        <div
          className="text-sm text-bone truncate mt-0.5"
          style={{ textShadow: `0 0 6px ${glow}55` }}
        >
          {item.def.title}
        </div>
        {item.def.description && (
          <div className="text-[0.68rem] text-bone/60 mt-0.5 leading-snug line-clamp-2">
            {item.def.description}
          </div>
        )}
      </div>

      {/* Rarity + points, right-side column */}
      <div className="flex-shrink-0 flex flex-col items-end gap-0.5 relative z-[1]">
        <span
          className="text-[0.56rem] uppercase tracking-[0.2em] font-mono"
          style={{
            color: RARITY_COLOR[rarity] ?? RARITY_COLOR.common,
            textShadow: `0 0 6px ${(RARITY_COLOR[rarity] ?? RARITY_COLOR.common)}55`,
          }}
        >
          {rarity}
        </span>
        <span
          className="text-sm font-mono tabular-nums"
          style={{ color: glow, textShadow: `0 0 6px ${glow}88` }}
        >
          +{item.points} pts
        </span>
      </div>
    </div>
  );
}

export default function AchievementToast({
  queue,
  accent,
  onDismiss,
}: {
  queue: ToastItem[];
  accent: string;
  onDismiss: (id: string) => void;
}) {
  if (queue.length === 0) return null;
  // Stack up to 3 simultaneously; additional toasts stay in the queue
  // and will render when earlier ones exit.
  const visible = queue.slice(0, 3);
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-[200] flex flex-col gap-2 items-end">
      {visible.map((t) => (
        <Toast key={t.id} item={t} accent={accent} onDone={onDismiss} />
      ))}
    </div>
  );
}
