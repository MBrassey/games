// Landing-page footer. Three short columns of *actual* technical claims —
// the things this portal meaningfully does differently from an "I have a
// game, I need a button" shop. Deliberately terse so the visitor can scan
// them in <10 seconds and still come away with the mental model:
//   1) games are kept alive from upstream repos, not manually wrangled
//   2) the same save survives across devices with no game-side code
//   3) chat / playtime / achievements / leaderboard are all portal-level,
//      not per-game
//
// Keep updating these when the platform ships something non-obvious —
// the footer is the one place a casual visitor reads.

export default function SystemFooter() {
  return (
    <footer id="about" className="mx-auto max-w-7xl px-6 py-10 mt-8 border-t border-eldritch-deep/50">
      <div className="grid gap-6 md:grid-cols-3 text-xs text-bone/65 leading-relaxed">
        <div>
          <div className="stamp mb-2">build pipeline</div>
          <p>
            Upstream game repos cloned fresh from GitHub on every deploy.
            LuaJIT → Lua 5.1 scope-aware <code className="text-amber-signal">goto</code> patching,
            zero-dep <code className="text-amber-signal">.love</code> packer, compiled to WASM via love.js.
            New commits on any watched repo auto-redeploy within ~10 min.
          </p>
        </div>
        <div>
          <div className="stamp mb-2">runtime bridge</div>
          <p>
            Sandboxed iframe + postMessage contract. <code className="text-abyss-cyan">love.filesystem</code> writes
            cloud-sync to Postgres across devices with no game-side code. A magic-print protocol
            lets Lua unlock achievements in one line. Clean-exit signal (<code className="text-abyss-cyan">love.event.quit</code>)
            detected and handed back to the portal.
          </p>
        </div>
        <div>
          <div className="stamp mb-2">platform</div>
          <p>
            Portal-wide chat (SSE + KV with Postgres fallback), per-game + global leaderboards,
            playtime telemetry, GitHub-native auth, Steam-style live achievement toasts, synthesized audio.
            <br />
            <span className="text-abyss-cyan">brassey.io</span>
            <span className="text-bone/40"> · Next.js 15 · Neon · Upstash · Vercel · 2026</span>
          </p>
        </div>
      </div>
    </footer>
  );
}
