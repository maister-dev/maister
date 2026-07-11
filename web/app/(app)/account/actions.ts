"use server";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { eq } from "drizzle-orm";
import pino from "pino";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { signOut } from "@/auth";
import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { hashPassword } from "@/lib/password";

const log = pino({
  name: "action-account",
  level: process.env.LOG_LEVEL ?? "info",
});

const { users } = schema;

function db(): NodePgDatabase<typeof schema> {
  return getDb();
}

const profileSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

const passwordSchema = z.object({
  password: z.string().min(12),
  confirm: z.string().min(12),
});

export type AccountProfileState =
  | { status: "saved" }
  | { status: "error"; error: "invalid" | "generic" }
  | undefined;

export type AccountPasswordState =
  | { status: "saved" }
  | { status: "error"; error: "weak" | "mismatch" | "generic" }
  | undefined;

export async function updateProfile(
  _prev: AccountProfileState,
  formData: FormData,
): Promise<AccountProfileState> {
  const user = await requireActiveSession();
  const parsed = profileSchema.safeParse({
    name: formData.get("name"),
  });

  if (!parsed.success) {
    return { status: "error", error: "invalid" };
  }

  await db()
    .update(users)
    .set({ name: parsed.data.name })
    .where(eq(users.id, user.id));

  log.info({ userId: user.id }, "profile updated");
  revalidatePath("/account");
  revalidatePath("/");

  return { status: "saved" };
}

export async function updateAccountPassword(
  _prev: AccountPasswordState,
  formData: FormData,
): Promise<AccountPasswordState> {
  const user = await requireActiveSession();
  const parsed = passwordSchema.safeParse({
    password: formData.get("password"),
    confirm: formData.get("confirm"),
  });

  if (!parsed.success) {
    return { status: "error", error: "weak" };
  }

  if (parsed.data.password !== parsed.data.confirm) {
    return { status: "error", error: "mismatch" };
  }

  const passwordHash = await hashPassword(parsed.data.password);

  await db()
    .update(users)
    .set({ passwordHash, mustChangePassword: false })
    .where(eq(users.id, user.id));

  log.info({ userId: user.id }, "account password updated");

  return { status: "saved" };
}

export async function signOutUser(): Promise<void> {
  await signOut({ redirectTo: "/login" });
}
