import "server-only";

import type { AccountStatus, GlobalRole, User } from "@/lib/db/schema";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { randomUUID } from "node:crypto";

import { and, count, desc, eq, ilike, or } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { hashPassword, verifyPassword } from "@/lib/password";

const log = pino({ name: "users", level: process.env.LOG_LEVEL ?? "info" });
const { users } = schema;

// FIXME(any): getDb() returns a pg|sqlite drizzle union; narrow to pg. POC = Postgres.
function db(): NodePgDatabase<typeof schema> {
  return getDb() as unknown as NodePgDatabase<typeof schema>;
}

export type CredentialFailureReason = "invalid" | "pending" | "disabled";

export type CredentialAccountResult =
  | {
      ok: true;
      user: {
        id: string;
        email: string;
        image: string | null;
        mustChangePassword: boolean;
        name: string | null;
        role: GlobalRole;
      };
    }
  | { ok: false; reason: CredentialFailureReason };

export interface RegisteredPendingUser {
  email: string;
  id: string;
  status: "pending";
}

export interface AdminUserListItem {
  createdAt: Date;
  email: string;
  id: string;
  mustChangePassword: boolean;
  name: string | null;
  role: GlobalRole;
  status: AccountStatus;
  statusUpdatedAt: Date | null;
  statusUpdatedBy: string | null;
}

export interface RegisterPendingUserInput {
  email: string;
  name: string;
  password: string;
}

export interface VerifyCredentialAccountInput {
  email: string;
  password: string;
}

export interface ListAdminUsersInput {
  q?: string;
  status?: AccountStatus;
}

export interface SetUserStatusInput {
  adminUserId: string;
  status: "active" | "disabled";
  targetUserId: string;
}

export interface SetUserRoleInput {
  adminUserId: string;
  role: GlobalRole;
  targetUserId: string;
}

export interface ResetUserPasswordInput {
  adminUserId: string;
  mustChangePassword: boolean;
  password: string;
  targetUserId: string;
}

async function loadUserById(id: string): Promise<User> {
  const rows = await db().select().from(users).where(eq(users.id, id));
  const user = rows[0];

  if (!user) {
    throw new MaisterError("PRECONDITION", `User not found: ${id}`);
  }

  return user;
}

async function countActiveAdmins(): Promise<number> {
  const rows = await db()
    .select({ value: count() })
    .from(users)
    .where(and(eq(users.role, "admin"), eq(users.accountStatus, "active")));

  return Number(rows[0]?.value ?? 0);
}

async function assertAdminCanLoseAccess(target: User): Promise<void> {
  if (target.role !== "admin" || target.accountStatus !== "active") return;

  const activeAdmins = await countActiveAdmins();

  if (activeAdmins <= 1) {
    throw new MaisterError(
      "PRECONDITION",
      "Cannot remove access from the last active admin",
    );
  }
}

export async function registerPendingUser(
  input: RegisterPendingUserInput,
): Promise<RegisteredPendingUser> {
  const email = input.email.toLowerCase();
  const existing = await db()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email));

  if (existing.length > 0) {
    throw new MaisterError("CONFLICT", `User already exists: ${email}`);
  }

  const id = randomUUID();
  const passwordHash = await hashPassword(input.password);

  await db().insert(users).values({
    id,
    name: input.name,
    email,
    passwordHash,
    role: "member",
    accountStatus: "pending",
  });

  log.info({ email, userId: id }, "public user registration pending");

  return { id, email, status: "pending" };
}

export async function verifyCredentialAccount(
  input: VerifyCredentialAccountInput,
): Promise<CredentialAccountResult> {
  const email = input.email.toLowerCase();
  const rows = await db().select().from(users).where(eq(users.email, email));
  const user = rows[0];

  if (!user?.passwordHash) {
    log.warn({ email }, "credential verification failed: unknown user");

    return { ok: false, reason: "invalid" };
  }

  const passwordOk = await verifyPassword(input.password, user.passwordHash);

  if (!passwordOk) {
    log.warn({ email }, "credential verification failed: bad password");

    return { ok: false, reason: "invalid" };
  }

  if (user.accountStatus !== "active") {
    log.warn(
      { email, status: user.accountStatus },
      "credential verification failed: inactive account",
    );

    return {
      ok: false,
      reason: user.accountStatus === "disabled" ? "disabled" : "pending",
    };
  }

  return {
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      image: user.image,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
    },
  };
}

export async function listAdminUsers(
  input: ListAdminUsersInput = {},
): Promise<AdminUserListItem[]> {
  const filters = [
    input.status ? eq(users.accountStatus, input.status) : undefined,
    input.q
      ? or(
          ilike(users.email, `%${input.q}%`),
          ilike(users.name, `%${input.q}%`),
        )
      : undefined,
  ].filter((f): f is NonNullable<typeof f> => Boolean(f));

  const rows = await db()
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      status: users.accountStatus,
      mustChangePassword: users.mustChangePassword,
      statusUpdatedAt: users.accountStatusUpdatedAt,
      statusUpdatedBy: users.accountStatusUpdatedBy,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(users.createdAt));

  return rows;
}

export async function setUserStatus(input: SetUserStatusInput): Promise<void> {
  if (input.adminUserId === input.targetUserId && input.status === "disabled") {
    throw new MaisterError("PRECONDITION", "Admins cannot disable themselves");
  }

  const target = await loadUserById(input.targetUserId);

  if (input.status === "disabled") {
    await assertAdminCanLoseAccess(target);
  }

  await db()
    .update(users)
    .set({
      accountStatus: input.status,
      accountStatusUpdatedAt: new Date(),
      accountStatusUpdatedBy: input.adminUserId,
    })
    .where(eq(users.id, input.targetUserId));

  log.info(
    {
      adminUserId: input.adminUserId,
      targetUserId: input.targetUserId,
      status: input.status,
    },
    "admin changed user status",
  );
}

export async function setUserRole(input: SetUserRoleInput): Promise<void> {
  if (input.adminUserId === input.targetUserId && input.role !== "admin") {
    throw new MaisterError("PRECONDITION", "Admins cannot demote themselves");
  }

  const target = await loadUserById(input.targetUserId);

  if (input.role !== "admin") {
    await assertAdminCanLoseAccess(target);
  }

  await db()
    .update(users)
    .set({ role: input.role })
    .where(eq(users.id, input.targetUserId));

  log.info(
    {
      adminUserId: input.adminUserId,
      targetUserId: input.targetUserId,
      role: input.role,
    },
    "admin changed user role",
  );
}

export async function resetUserPassword(
  input: ResetUserPasswordInput,
): Promise<void> {
  await loadUserById(input.targetUserId);

  const passwordHash = await hashPassword(input.password);

  await db()
    .update(users)
    .set({
      passwordHash,
      mustChangePassword: input.mustChangePassword,
    })
    .where(eq(users.id, input.targetUserId));

  log.info(
    {
      adminUserId: input.adminUserId,
      targetUserId: input.targetUserId,
      mustChangePassword: input.mustChangePassword,
    },
    "admin reset user password",
  );
}
