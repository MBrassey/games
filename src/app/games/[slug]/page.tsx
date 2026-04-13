import { notFound } from "next/navigation";
import { getGame } from "@/lib/games";
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
      <main className="pr-0 md:pr-[360px]">
        <div className="mx-auto max-w-7xl px-6 py-6">
          <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
            <div>
              <div className="stamp" style={{ color: game.accentColor }}>now running :: {game.codename}</div>
              <h1 className="text-2xl tracking-[0.2em] uppercase text-bone mt-1">{game.title}</h1>
              <p className="text-sm text-bone/60 mt-1 max-w-2xl">{game.description}</p>
            </div>
            <div className="flex items-center gap-3 text-[0.65rem] uppercase tracking-[0.25em] text-bone/50">
              <span>v{game.version}</span>
              <span>· {game.multiplayer}</span>
              <span>· {game.category}</span>
            </div>
          </div>
          <hr className="hr-dither mb-4" />
          <GameRunner slug={game.slug} runtimePath={game.runtimePath} signedIn={!!session?.user?.id} />
        </div>
      </main>
    </>
  );
}
