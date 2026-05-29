"use server";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { AuthError } from "next-auth";
import pino from "pino";
import { z } from "zod";

import { signIn } from "@/auth";
import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { hashPassword } from "@/lib/password";

const log = pino({
  name: "action-auth",
  level: process.env.LOG_LEVEL ?? "info",
});

const { users } = schema;

// FIXME(any): getDb() returns a pg|sqlite drizzle union; narrow to pg. POC = Postgres.
function db(): NodePgDatabase<typeof schema> {
  return getDb() as unknown as NodePgDatabase<typeof schema>;
}

const registerSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  password: z.string().min(12),
});

export type RegisterError = "duplicate" | "weak" | "invalid";
export type RegisterResult = { ok: true } | { ok: false; error: RegisterError };

export async function register(input: {
  name: string;
  email: string;
  password: string;
}): Promise<RegisterResult> {
  const parsed = registerSchema.safeParse(input);

  if (!parsed.success) {
    const weak = parsed.error.issues.some((i) => i.path[0] === "password");

    log.warn({ weak }, "register validation failed");

    return { ok: false, error: weak ? "weak" : "invalid" };
  }

  const email = parsed.data.email.toLowerCase();
  const conn = db();
  const existing = await conn
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email));

  if (existing.length > 0) {
    log.warn({ email }, "register rejected: duplicate email");

    return { ok: false, error: "duplicate" };
  }

  // Public registration NEVER grants admin. The single bootstrap admin is
  // seeded by migration 0005 (or `pnpm db:seed`); promotions happen via an
  // existing admin. This closes the concurrent-first-user admin-minting race.
  const passwordHash = await hashPassword(parsed.data.password);

  await conn.insert(users).values({
    id: randomUUID(),
    name: parsed.data.name,
    email,
    passwordHash,
    role: "member",
  });

  log.info({ email, role: "member" }, "user registered");

  return { ok: true };
}

export type AuthState = { error: RegisterError | "generic" } | undefined;

export async function authenticate(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const redirectTo = (formData.get("redirectTo") as string) || "/";

  try {
    await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      redirectTo,
    });

    return undefined;
  } catch (error) {
    if (error instanceof AuthError) {
      log.warn({ type: error.type }, "authenticate failed");

      return {
        error: error.type === "CredentialsSignin" ? "invalid" : "generic",
      };
    }

    throw error;
  }
}
