import NextAuth, { type DefaultSession } from "next-auth";
import GitHub from "next-auth/providers/github";
import PostgresAdapter from "@auth/pg-adapter";
import { getPool } from "@/lib/db";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      handle?: string | null;
    } & DefaultSession["user"];
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
    trustHost: true,
  };
});
