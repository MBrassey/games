export default function SystemFooter() {
  return (
    <footer id="about" className="mx-auto max-w-7xl px-6 py-10 mt-8 border-t border-eldritch-deep/50">
      <div className="grid gap-6 md:grid-cols-3 text-xs text-bone/60">
        <div>
          <div className="stamp mb-2">manifest</div>
          <p>
            Hand-rolled LÖVE2D portal. Next.js on Vercel. Postgres for saves,
            KV for realtime chat. Zero vendored auth — OAuth is GitHub-direct.
          </p>
        </div>
        <div>
          <div className="stamp mb-2">aesthetic</div>
          <p>
            Palette lifted from <em className="text-eldritch-purple">Claude: Mythos</em>:
            void purples, matrix greens, deep-sea cyan, blood-red accents.
          </p>
        </div>
        <div>
          <div className="stamp mb-2">uplink</div>
          <p>
            games.brassey.io // main-branch auto-deploys to Vercel // DNS: Namecheap.
            <br />
            <span className="text-abyss-cyan">brassey.io</span> · <span className="text-bone/40">2026</span>
          </p>
        </div>
      </div>
    </footer>
  );
}
