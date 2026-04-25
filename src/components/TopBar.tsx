import Link from "next/link";
import { auth, signIn, signOut } from "@/lib/auth";
import MuteButton from "./MuteButton";
import UserMenu from "./UserMenu";
import { q } from "@/lib/db";

export default async function TopBar() {
  const session = await auth();
  const user = session?.user;
  const profile = user?.id
    ? (await q<{ handle: string | null; avatar_url: string | null; github_login: string | null }>(
        "SELECT handle, avatar_url, github_login FROM user_profiles WHERE user_id=$1",
        [Number(user.id)]
      ))[0] ?? null
    : null;
  const displayHandle = profile?.handle ?? user?.name ?? user?.email ?? "operator";
  const avatarSrc = profile?.avatar_url ?? user?.image ?? null;

  async function doSignOut() {
    "use server";
    await signOut({ redirectTo: "/" });
  }
  return (
    <header className="sticky top-0 z-40 border-b border-eldritch-deep/60 bg-void-0/80 backdrop-blur">
      {/* Full-bleed bar — no max-w cap. Left cluster hugs the left edge,
          right cluster hugs the right edge, consistent padding on both
          sides regardless of viewport width. */}
      <div className="flex h-14 items-center justify-between gap-2 px-3 sm:px-4 md:px-6">
        {/* Left cluster — wordmark collapses on the smallest screens so
            the right-hand controls always have room for the avatar /
            sign-in button. */}
        <div className="flex items-center gap-3 sm:gap-5 min-w-0">
          <Link href="/" className="flex items-center gap-2 sm:gap-2.5 group min-w-0">
            <svg viewBox="0 0 32 32" className="h-6 w-6 shrink-0">
              <path d="M4 10 L16 4 L28 10 L28 22 L16 28 L4 22 Z" fill="none" stroke="#8a4fff" strokeWidth="1.5"/>
              <circle cx="16" cy="16" r="3" fill="#66e0ff"/>
              <path d="M16 16 L10 12 M16 16 L22 12 M16 16 L16 22" stroke="#8a4fff" strokeWidth="1"/>
            </svg>
            <span className="font-mono text-[0.7rem] sm:text-[0.78rem] tracking-[0.22em] sm:tracking-[0.32em] text-bone/90 group-hover:text-abyss-cyan glow-accent truncate">
              <span className="sm:hidden">GAMES<span className="text-eldritch-purple">::</span>BR</span>
              <span className="hidden sm:inline">GAMES<span className="text-eldritch-purple">::</span>BRASSEY</span>
            </span>
          </Link>
          <nav className="flex items-center gap-3 sm:gap-4 text-[0.62rem] sm:text-[0.68rem] tracking-[0.2em] sm:tracking-[0.25em] uppercase text-bone/50">
            <Link href="/" className="hover:text-abyss-cyan">Library</Link>
            <Link href="/leaderboard" className="hidden sm:inline hover:text-abyss-cyan">Ranks</Link>
            {user && <Link href="/stats" className="hidden sm:inline hover:text-abyss-cyan">Stats</Link>}
          </nav>
        </div>

        {/* Right cluster */}
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          <span className="hidden lg:inline text-[0.62rem] tracking-[0.28em] uppercase text-bone/40">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-matrix-green mr-2 shadow-[0_0_8px_#33ff66] animate-pulse align-middle" />
            uplink
          </span>
          <MuteButton />
          {user ? (
            <UserMenu
              handle={displayHandle}
              avatar={avatarSrc}
              githubLogin={profile?.github_login ?? null}
              signOut={doSignOut}
            />
          ) : (
            <form
              action={async () => {
                "use server";
                await signIn("github", { redirectTo: "/" });
              }}
            >
              <button className="btn cyan !py-1 !px-2.5 sm:!py-1.5 sm:!px-3 text-[0.6rem] sm:text-[0.7rem]" type="submit" title="Optional — sign in to save progress and chat">
                ▸ <span className="hidden sm:inline">Sign in</span><span className="sm:hidden">Sign in</span>
              </button>
            </form>
          )}
        </div>
      </div>
    </header>
  );
}
