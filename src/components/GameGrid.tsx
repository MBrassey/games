import { GAMES } from "@/lib/games";
import GameCard from "./GameCard";

export default function GameGrid() {
  return (
    <section className="mx-auto max-w-7xl px-4 sm:px-6 py-6 sm:py-8">
      <div className="flex items-end justify-between mb-4 sm:mb-6 gap-3">
        <div className="min-w-0">
          <div className="stamp truncate">library :: {GAMES.length.toString().padStart(2, "0")} titles</div>
          <h2 className="text-xl sm:text-2xl tracking-[0.22em] sm:tracking-[0.3em] uppercase text-bone mt-1">
            <span className="text-eldritch-purple">[</span> catalog <span className="text-eldritch-purple">]</span>
          </h2>
        </div>
        <div className="text-[0.6rem] sm:text-[0.65rem] uppercase tracking-[0.2em] sm:tracking-[0.25em] text-bone/50 shrink-0">
          sorted :: newest ▾
        </div>
      </div>
      <hr className="hr-dither mb-4 sm:mb-6" />
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 sm:gap-5">
        {GAMES.map((g) => (
          <GameCard key={g.slug} game={g} />
        ))}
        {/* "coming soon" placeholder slots */}
        {Array.from({ length: Math.max(0, 3 - GAMES.length) }).map((_, i) => (
          <div key={`ph-${i}`} className="border border-dashed border-eldritch-deep/40 p-6 sm:p-8 text-center text-[0.65rem] sm:text-[0.7rem] uppercase tracking-[0.25em] sm:tracking-[0.3em] text-bone/30">
            awaiting upload
          </div>
        ))}
      </div>
    </section>
  );
}
