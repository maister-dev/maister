import type { NextAuthConfig } from "next-auth";
import type { GlobalRole } from "@/lib/db/schema";

const THIRTY_DAYS_SECONDS = 60 * 60 * 24 * 30;

/**
 * Edge-safe Auth.js config shared by the Node `auth.ts` (which adds the
 * Drizzle adapter + Credentials provider) and the edge `middleware.ts`.
 * Contains no DB/bcrypt imports so it can run in the middleware runtime.
 */
export const authConfig = {
  trustHost: true,
  pages: {
    signIn: "/login",
  },
  session: {
    strategy: "jwt",
    maxAge: THIRTY_DAYS_SECONDS,
  },
  providers: [],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = (user as { role?: GlobalRole }).role ?? "member";
      }

      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = (token.id as string) ?? session.user.id;
        session.user.role = (token.role as GlobalRole) ?? "member";
      }

      return session;
    },
  },
} satisfies NextAuthConfig;

export default authConfig;
