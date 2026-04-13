import { signIn, auth } from "@/lib/auth";
import { redirect } from "next/navigation";

export default async function SignInPage() {
  const session = await auth();
  if (session?.user?.id) redirect("/");
  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="panel panel-glow w-[min(520px,92vw)] p-8">
        <div className="stamp mb-2">session :: auth</div>
        <h1 className="text-2xl tracking-[0.2em] uppercase text-bone mb-4">
          <span className="text-eldritch-purple">[</span> uplink handshake <span className="text-eldritch-purple">]</span>
        </h1>
        <p className="text-sm text-bone/70 leading-relaxed mb-6">
          The terminal requires a verified identity to grant save-state access,
          cross-device sync, and channel transmission rights. Authenticate via
          your GitHub account — no additional signup, no third-party broker.
        </p>
        <form
          action={async () => {
            "use server";
            await signIn("github", { redirectTo: "/" });
          }}
        >
          <button type="submit" className="btn cyan w-full justify-center text-base py-3">
            ▸ Authenticate via GitHub
          </button>
        </form>
        <p className="mt-5 text-[0.65rem] uppercase tracking-[0.25em] text-bone/40">
          we read only your public profile. saves are yours.
        </p>
      </div>
    </main>
  );
}
