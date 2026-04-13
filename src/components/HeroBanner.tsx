import { GAMES } from "@/lib/games";

export default function HeroBanner() {
  const feat = GAMES[0];
  return (
    <section className="relative overflow-hidden border-b border-eldritch-deep/50">
      <div className="absolute inset-0 bg-grid opacity-60" />
      <div className="scan-sweep" />
      <div className="relative mx-auto max-w-7xl px-6 py-16 md:py-24">
        <div className="max-w-3xl">
          <div className="stamp text-eldritch-purple">games :: brassey :: io</div>
          <h1 className="mt-3 text-4xl md:text-6xl tracking-[0.08em] leading-[1.05] text-bone">
            a terminal for
            <br />
            <span className="text-abyss-cyan glow-cyan">LÖVE2D</span>
            <span className="text-bone/40"> // </span>
            <span className="text-eldritch-purple glow-accent">web native</span>.
          </h1>
          <p className="mt-5 max-w-xl text-sm md:text-base text-bone/70 leading-relaxed">
            Launch hand-built LÖVE2D games straight from the browser. Saves sync
            across every device you sign in on. A ship-wide chat runs over the
            top so every player is in the same room — no matter which game
            they&apos;re running.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <a href="#library" className="btn cyan">▸ enter catalog</a>
            <a href={`/games/${feat.slug}`} className="btn">
              ▸ boot {feat.codename.toLowerCase()}
            </a>
            <span className="ml-3 text-[0.7rem] tracking-[0.25em] uppercase text-bone/40">
              v{feat.version} // {feat.year}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
