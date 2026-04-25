import { notFound } from "next/navigation";
import { getGame, runtimePath } from "@/lib/games";
import { auth } from "@/lib/auth";
import TopBar from "@/components/TopBar";
import ChatDrawer from "@/components/ChatDrawer";
import GameRunner from "@/components/GameRunner";

export default async function GamePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const game = getGame(slug);
  if (!game) notFound();
  const session = await auth();

  return (
    <>
      <TopBar />
      <ChatDrawer
        signedIn={!!session?.user?.id}
        meHandle={session?.user?.name ?? null}
        gameSlug={slug}
      />
      <main className="pr-0 md:pr-[380px]">
        {/* Game page uses the full width of the main column (no max-w cap)
            so the love.js canvas can render at its native 1280×720 or
            bigger without fractional CSS downscale blurring the text. */}
        <div className="px-2 sm:px-4 md:px-6 py-2 sm:py-3">
          {/* Condensed title bar so more vertical goes to the game frame.
              On mobile we drop to a single compact row and hide the
              version/multiplayer/category meta to claim every pixel. */}
          <div className="flex flex-wrap items-baseline justify-between gap-2 sm:gap-3 mb-2">
            <div className="flex items-baseline gap-2 sm:gap-3 min-w-0">
              <div className="stamp shrink-0" style={{ color: game.accentColor }}>▸ {game.codename}</div>
              <h1 className="text-xs sm:text-sm tracking-[0.18em] sm:tracking-[0.25em] uppercase text-bone truncate">{game.title}</h1>
            </div>
            <div className="hidden sm:flex items-center gap-3 text-[0.62rem] uppercase tracking-[0.25em] text-bone/50">
              <span>v{game.version}</span>
              <span>· {game.multiplayer}</span>
              <span>· {game.category}</span>
            </div>
          </div>
          <GameRunner slug={game.slug} runtimePath={runtimePath(game.slug)} signedIn={!!session?.user?.id} />
        </div>
      </main>
    </>
  );
}
