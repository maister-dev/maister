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
    // Edge-safe JWT callback (no DB). Seeds claims from `user` at sign-in.
    // The Node `auth.ts` overrides this with a DB-refreshing variant so role
    // and mustChangePassword stay authoritative on every server request.
    jwt({ token, user }) {
      if (user) {
        const u = user as {
          id?: string;
          role?: GlobalRole;
          mustChangePassword?: boolean;
        };

        token.id = u.id;
        token.role = u.role ?? "member";
        token.mustChangePassword = u.mustChangePassword ?? false;
      }

      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = (token.id as string) ?? session.user.id;
        session.user.role = (token.role as GlobalRole) ?? "member";
        session.user.mustChangePassword = Boolean(token.mustChangePassword);
      }

      return session;
    },
  },
} satisfies NextAuthConfig;

export default authConfig;
