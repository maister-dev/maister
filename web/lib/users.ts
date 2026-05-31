import "server-only";

import type { AccountStatus, GlobalRole, ProjectRole } from "@/lib/db/schema";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { randomUUID } from "node:crypto";

import { and, count, desc, eq, ilike, inArray, or } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { hashPassword, verifyPassword } from "@/lib/password";

const log = pino({ name: "users", level: process.env.LOG_LEVEL ?? "info" });
const { projectMembers, projects, users } = schema;

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

export interface AdminUserProject {
  id: string;
  name: string;
  role: ProjectRole;
  slug: string;
}

export interface AdminUserListItem {
  createdAt: Date;
  email: string;
  id: string;
  lastLoginAt: Date | null;
  mustChangePassword: boolean;
  name: string | null;
  projects: AdminUserProject[];
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
  projectId?: string;
  q?: string;
  role?: GlobalRole;
  status?: AccountStatus;
}

export interface UpdateAdminUserInput {
  adminUserId: string;
  mustChangePassword?: boolean;
  password?: string;
  role?: GlobalRole;
  status?: "active" | "disabled";
  targetUserId: string;
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

  await db()
    .update(users)
    .set({ lastLoginAt: new Date() })
    .where(eq(users.id, user.id));

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
  const client = db();

  // Project filter answers "who is an EXPLICIT member of this project". Global
  // admins are implicit owners of every project (see lib/authz) but are
  // intentionally excluded here — the admin manages explicit memberships.
  let memberIds: string[] | null = null;

  if (input.projectId) {
    const memberRows = await client
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(eq(projectMembers.projectId, input.projectId));

    memberIds = memberRows.map((r) => r.userId);

    if (memberIds.length === 0) return [];
  }

  const filters = [
    input.status ? eq(users.accountStatus, input.status) : undefined,
    input.role ? eq(users.role, input.role) : undefined,
    input.q
      ? or(
          ilike(users.email, `%${input.q}%`),
          ilike(users.name, `%${input.q}%`),
        )
      : undefined,
    memberIds ? inArray(users.id, memberIds) : undefined,
  ].filter((f): f is NonNullable<typeof f> => Boolean(f));

  const rows = await client
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      status: users.accountStatus,
      mustChangePassword: users.mustChangePassword,
      lastLoginAt: users.lastLoginAt,
      statusUpdatedAt: users.accountStatusUpdatedAt,
      statusUpdatedBy: users.accountStatusUpdatedBy,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(users.createdAt));

  if (rows.length === 0) return [];

  const membershipRows = await client
    .select({
      userId: projectMembers.userId,
      role: projectMembers.role,
      id: projects.id,
      name: projects.name,
      slug: projects.slug,
    })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(
      inArray(
        projectMembers.userId,
        rows.map((r) => r.id),
      ),
    );

  const byUser = new Map<string, AdminUserProject[]>();

  for (const m of membershipRows) {
    const list = byUser.get(m.userId) ?? [];

    list.push({ id: m.id, name: m.name, slug: m.slug, role: m.role });
    byUser.set(m.userId, list);
  }

  return rows.map((row) => ({ ...row, projects: byUser.get(row.id) ?? [] }));
}

/**
 * Apply a partial admin edit (role / status / password) to one user in a single
 * transaction. Replaces the former per-field routes so the edit popup makes ONE
 * call. Self-protection + last-active-admin guards run inside the transaction so
 * the admin-count check and the write cannot race.
 */
export async function updateAdminUser(
  input: UpdateAdminUserInput,
): Promise<void> {
  const { adminUserId, targetUserId } = input;
  const isSelf = adminUserId === targetUserId;

  if (isSelf && input.status === "disabled") {
    throw new MaisterError("PRECONDITION", "Admins cannot disable themselves");
  }

  if (isSelf && input.role !== undefined && input.role !== "admin") {
    throw new MaisterError("PRECONDITION", "Admins cannot demote themselves");
  }

  const passwordHash =
    input.password !== undefined
      ? await hashPassword(input.password)
      : undefined;

  await db().transaction(async (tx) => {
    const rows = await tx
      .select({ role: users.role, accountStatus: users.accountStatus })
      .from(users)
      .where(eq(users.id, targetUserId));
    const target = rows[0];

    if (!target) {
      throw new MaisterError("PRECONDITION", `User not found: ${targetUserId}`);
    }

    const isActiveAdmin =
      target.role === "admin" && target.accountStatus === "active";
    const losesAdmin =
      isActiveAdmin &&
      (input.status === "disabled" ||
        (input.role !== undefined && input.role !== "admin"));

    if (losesAdmin) {
      const adminRows = await tx
        .select({ value: count() })
        .from(users)
        .where(and(eq(users.role, "admin"), eq(users.accountStatus, "active")));

      if (Number(adminRows[0]?.value ?? 0) <= 1) {
        throw new MaisterError(
          "PRECONDITION",
          "Cannot remove access from the last active admin",
        );
      }
    }

    const patch: Partial<typeof users.$inferInsert> = {};

    if (input.role !== undefined) patch.role = input.role;

    if (input.status !== undefined) {
      patch.accountStatus = input.status;
      patch.accountStatusUpdatedAt = new Date();
      patch.accountStatusUpdatedBy = adminUserId;
    }

    if (passwordHash !== undefined) {
      patch.passwordHash = passwordHash;
      patch.mustChangePassword = input.mustChangePassword ?? false;
    } else if (input.mustChangePassword !== undefined) {
      patch.mustChangePassword = input.mustChangePassword;
    }

    if (Object.keys(patch).length === 0) return;

    await tx.update(users).set(patch).where(eq(users.id, targetUserId));
  });

  log.info(
    {
      adminUserId,
      targetUserId,
      role: input.role,
      status: input.status,
      passwordReset: input.password !== undefined,
    },
    "admin updated user",
  );
}
