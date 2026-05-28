import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import pino from "pino";
import { z } from "zod";

import { authConfig } from "@/auth.config";
import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { verifyPassword } from "@/lib/password";

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

        const email = parsed.data.email.toLowerCase();
        const rows = await db()
          .select()
          .from(users)
          .where(eq(users.email, email));
        const user = rows[0];

        if (!user?.passwordHash) {
          log.warn({ email }, "sign-in failed: unknown user or no password");

          return null;
        }

        const ok = await verifyPassword(
          parsed.data.password,
          user.passwordHash,
        );

        if (!ok) {
          log.warn({ email }, "sign-in failed: bad password");

          return null;
        }

        log.info({ email, role: user.role }, "sign-in ok");

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
          role: user.role,
        };
      },
    }),
  ],
}));
