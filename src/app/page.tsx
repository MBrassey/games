import TopBar from "@/components/TopBar";
import HeroBanner from "@/components/HeroBanner";
import GameGrid from "@/components/GameGrid";
import ChatDrawer from "@/components/ChatDrawer";
import BootSplash from "@/components/BootSplash";
import SystemFooter from "@/components/SystemFooter";
import { auth } from "@/lib/auth";

export default async function HomePage() {
  const session = await auth();
  return (
    <>
      <BootSplash />
      <TopBar />
      <ChatDrawer
        signedIn={!!session?.user?.id}
        meHandle={session?.user?.name ?? null}
      />
      <main className="pr-0 md:pr-[360px]">
        <HeroBanner />
        <div id="library">
          <GameGrid />
        </div>
        <SystemFooter />
      </main>
    </>
  );
}
