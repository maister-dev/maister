import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { GlobalRole } from "@/lib/db/schema";

import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import pino from "pino";
import { z } from "zod";

import { authConfig } from "@/auth.config";
import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { verifyCredentialAccount } from "@/lib/users";

const log = pino({ name: "auth", level: process.env.LOG_LEVEL ?? "info" });

const { users, accounts, sessions, verificationTokens } = schema;

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// FIXME(any): getDb() returns a pg|sqlite drizzle union; narrow to pg for the
// Auth.js adapter and credential lookups. POC runs on Postgres.
function db(): NodePgDatabase<typeof schema> {
  return getDb() as unknown as NodePgDatabase<typeof schema>;
}

export const { handlers, auth, signIn, signOut } = NextAuth(() => ({
  ...authConfig,
  adapter: DrizzleAdapter(db(), {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  callbacks: {
    ...authConfig.callbacks,
    // Node-only JWT callback: re-read the live role + mustChangePassword from
    // the DB on every refresh so a demoted/disabled user loses authority and a
    // changed password clears the gate without waiting for the 30-day token to
    // expire. A vanished user invalidates the session (return null → sign-out).
    // This never runs on the edge (middleware uses authConfig's no-DB variant).
    jwt: async ({ token, user }) => {
      if (user) {
        const u = user as {
          id?: string;
          role?: GlobalRole;
          mustChangePassword?: boolean;
        };

        token.id = u.id;
        token.role = u.role ?? "member";
        token.mustChangePassword = u.mustChangePassword ?? false;

        return token;
      }

      if (typeof token.id === "string") {
        const rows = await db()
          .select({
            role: users.role,
            mustChangePassword: users.mustChangePassword,
            accountStatus: users.accountStatus,
          })
          .from(users)
          .where(eq(users.id, token.id));
        const row = rows[0];

        if (!row) {
          log.warn(
            { userId: token.id },
            "jwt: user gone — invalidating session",
          );

          return null;
        }

        token.role = row.role;
        token.mustChangePassword = row.mustChangePassword;
      }

      return token;
    },
  },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      authorize: async (raw) => {
        const parsed = credentialsSchema.safeParse(raw);

        if (!parsed.success) {
          log.warn("credentials shape invalid");

          return null;
        }

        const result = await verifyCredentialAccount({
          email: parsed.data.email,
          password: parsed.data.password,
        });

        if (!result.ok) {
          log.warn(
            { email: parsed.data.email.toLowerCase(), reason: result.reason },
            "sign-in failed",
          );

          return null;
        }

        log.info(
          { email: result.user.email, role: result.user.role },
          "sign-in ok",
        );

        return {
          id: result.user.id,
          email: result.user.email,
          name: result.user.name,
          image: result.user.image,
          role: result.user.role,
          mustChangePassword: result.user.mustChangePassword,
        };
      },
    }),
  ],
}));
