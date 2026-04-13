import NextAuth, { type DefaultSession } from "next-auth";
import GitHub from "next-auth/providers/github";
import PostgresAdapter from "@auth/pg-adapter";
import { getPool, q } from "@/lib/db";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      handle?: string | null;
    } & DefaultSession["user"];
  }
}

type GhProfile = {
  id?: number;
  login?: string;
  name?: string | null;
  avatar_url?: string | null;
  bio?: string | null;
  location?: string | null;
  blog?: string | null;
  company?: string | null;
  twitter_username?: string | null;
  html_url?: string | null;
  public_repos?: number | null;
  followers?: number | null;
};

// Copy what we know from the GitHub OAuth profile into user_profiles so
// the portal has an up-to-date handle + avatar + bio without the user
// having to fill in a profile form.
async function syncGithubProfile(userId: number, profile: GhProfile): Promise<void> {
  try {
    await q(
      `INSERT INTO user_profiles (
         user_id, handle, avatar_url, github_login, github_id,
         bio, location, blog, company, twitter,
         public_repos, followers, github_html_url
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (user_id) DO UPDATE SET
         handle           = COALESCE(EXCLUDED.handle, user_profiles.handle),
         avatar_url       = COALESCE(EXCLUDED.avatar_url, user_profiles.avatar_url),
         github_login     = EXCLUDED.github_login,
         github_id        = EXCLUDED.github_id,
         bio              = EXCLUDED.bio,
         location         = EXCLUDED.location,
         blog             = EXCLUDED.blog,
         company          = EXCLUDED.company,
         twitter          = EXCLUDED.twitter,
         public_repos     = EXCLUDED.public_repos,
         followers        = EXCLUDED.followers,
         github_html_url  = EXCLUDED.github_html_url,
         last_seen_at     = now()`,
      [
        userId,
        profile.login ?? profile.name ?? `user-${userId}`,
        profile.avatar_url ?? null,
        profile.login ?? null,
        profile.id ?? null,
        profile.bio ?? null,
        profile.location ?? null,
        profile.blog ?? null,
        profile.company ?? null,
        profile.twitter_username ?? null,
        profile.public_repos ?? null,
        profile.followers ?? null,
        profile.html_url ?? null,
      ]
    );
  } catch (e) {
    // Don't block sign-in if the profile upsert fails (e.g. DB hiccup).
    console.error("syncGithubProfile:", e);
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth(() => {
  const pool = getPool();
  return {
    adapter: pool ? PostgresAdapter(pool) : undefined,
    session: { strategy: pool ? "database" : "jwt" },
    providers: [
      GitHub({
        clientId: process.env.AUTH_GITHUB_ID,
        clientSecret: process.env.AUTH_GITHUB_SECRET,
      }),
    ],
    pages: { signIn: "/signin" },
    callbacks: {
      session({ session, user, token }) {
        if (user) session.user.id = user.id;
        else if (token?.sub) session.user.id = token.sub;
        return session;
      },
    },
    events: {
      async signIn({ user, profile }) {
        if (!user?.id) return;
        const userId = Number(user.id);
        if (!Number.isFinite(userId)) return;
        await syncGithubProfile(userId, (profile ?? {}) as GhProfile);
      },
    },
    trustHost: true,
  };
});
