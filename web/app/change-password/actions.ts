"use server";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import pino from "pino";
import { z } from "zod";

import { getSessionUser } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { hashPassword } from "@/lib/password";

const log = pino({
  name: "action-change-password",
  level: process.env.LOG_LEVEL ?? "info",
});

const { users } = schema;

// FIXME(any): getDb() returns a pg|sqlite drizzle union; narrow to pg. POC = Postgres.
function db(): NodePgDatabase<typeof schema> {
  return getDb() as unknown as NodePgDatabase<typeof schema>;
}

const passwordSchema = z.string().min(12);

export type ChangePasswordState =
  | { error: "weak" | "mismatch" | "unauthenticated" | "generic" }
  | undefined;

export async function changePassword(
  _prev: ChangePasswordState,
  formData: FormData,
): Promise<ChangePasswordState> {
  const user = await getSessionUser();

  if (!user) {
    return { error: "unauthenticated" };
  }

  if (user.accountStatus !== "active") {
    return { error: "unauthenticated" };
  }

  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (password !== confirm) {
    return { error: "mismatch" };
  }

  if (!passwordSchema.safeParse(password).success) {
    return { error: "weak" };
  }

  const passwordHash = await hashPassword(password);

  await db()
    .update(users)
    .set({ passwordHash, mustChangePassword: false })
    .where(eq(users.id, user.id));

  log.info({ userId: user.id }, "password changed; must_change cleared");

  // (app) layout re-reads must_change_password from the DB (authoritative),
  // so the redirect lands the user in the app without waiting for JWT refresh.
  redirect("/");
}
