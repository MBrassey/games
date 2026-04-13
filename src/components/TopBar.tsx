import Link from "next/link";
import { auth, signIn, signOut } from "@/lib/auth";

export default async function TopBar() {
  const session = await auth();
  const user = session?.user;
  return (
    <header className="sticky top-0 z-40 border-b border-eldritch-deep/60 bg-void-0/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-6">
        <div className="flex items-center gap-6">
          <Link href="/" className="flex items-center gap-3 group">
            <svg viewBox="0 0 32 32" className="h-6 w-6">
              <path d="M4 10 L16 4 L28 10 L28 22 L16 28 L4 22 Z" fill="none" stroke="#8a4fff" strokeWidth="1.5"/>
              <circle cx="16" cy="16" r="3" fill="#66e0ff"/>
              <path d="M16 16 L10 12 M16 16 L22 12 M16 16 L16 22" stroke="#8a4fff" strokeWidth="1"/>
            </svg>
            <span className="font-mono text-sm tracking-[0.35em] text-bone/90 group-hover:text-abyss-cyan glow-accent">
              GAMES<span className="text-eldritch-purple">::</span>BRASSEY
            </span>
          </Link>
          <nav className="hidden md:flex items-center gap-5 text-[0.7rem] tracking-[0.25em] uppercase text-bone/50">
            <Link href="/" className="hover:text-abyss-cyan">Library</Link>
            <Link href="/#chat" className="hover:text-abyss-cyan">Chat</Link>
            <Link href="/#about" className="hover:text-abyss-cyan">System</Link>
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden md:inline text-[0.65rem] tracking-[0.25em] uppercase text-bone/40">
            <span className="inline-block h-2 w-2 rounded-full bg-matrix-green mr-2 shadow-[0_0_8px_#33ff66] animate-pulse" />
            uplink active
          </span>
          {user ? (
            <>
              <div className="hidden sm:flex items-center gap-2 text-[0.7rem] tracking-[0.2em] uppercase">
                <span className="text-bone/40">user</span>
                <span className="text-abyss-cyan glow-cyan">{user.name ?? user.email}</span>
              </div>
              <form
                action={async () => {
                  "use server";
                  await signOut({ redirectTo: "/" });
                }}
              >
                <button className="btn red" type="submit">Logout</button>
              </form>
            </>
          ) : (
            <form
              action={async () => {
                "use server";
                await signIn("github", { redirectTo: "/" });
              }}
            >
              <button className="btn cyan" type="submit">▸ Authenticate</button>
            </form>
          )}
        </div>
      </div>
    </header>
  );
}
