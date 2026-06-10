import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { AccountStatus, GlobalRole, ProjectRole } from "@/lib/db/schema";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import { auth } from "@/auth";
import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const log = pino({ name: "authz", level: process.env.LOG_LEVEL ?? "info" });

const { projectMembers, users } = schema;

// FIXME(any): getDb() returns a pg|sqlite drizzle union; narrow to pg. POC = Postgres.
function db(): NodePgDatabase<typeof schema> {
  return getDb() as unknown as NodePgDatabase<typeof schema>;
}

export interface SessionUser {
  id: string;
  accountStatus: AccountStatus;
  role: GlobalRole;
  mustChangePassword: boolean;
  email?: string | null;
  name?: string | null;
}

const GLOBAL_ORDER: Record<GlobalRole, number> = {
  viewer: 0,
  member: 1,
  admin: 2,
};

const PROJECT_ORDER: Record<ProjectRole, number> = {
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

/** Minimum project role required per project-scoped action. */
export const PROJECT_ACTION_MIN = {
  readBoard: "viewer",
  readScratchRun: "viewer",
  readRepoFiles: "member",
  launchRun: "member",
  operateScratchRun: "member",
  promoteRun: "member",
  recoverRun: "member",
  createTask: "member",
  answerHitl: "member",
  manageSchedules: "member",
  editSettings: "admin",
  managePackages: "admin",
  manageCatalog: "admin",
  manageMembers: "admin",
} as const satisfies Record<string, ProjectRole>;

export type ProjectAction = keyof typeof PROJECT_ACTION_MIN;

async function loadUser(id: string) {
  const rows = await db()
    .select({
      id: users.id,
      role: users.role,
      accountStatus: users.accountStatus,
      email: users.email,
      name: users.name,
      mustChangePassword: users.mustChangePassword,
    })
    .from(users)
    .where(eq(users.id, id));

  return rows[0] ?? null;
}

/**
 * Resolve the current user. DB-authoritative: the JWT supplies only the user
 * id (server-issued); role, mustChangePassword, and existence are re-read from
 * the database so a demoted/deleted user loses authority immediately rather
 * than at JWT expiry. Returns null when unauthenticated OR the user is gone.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth();
  const id = session?.user?.id;

  if (!id) return null;

  const row = await loadUser(id);

  if (!row) {
    log.warn({ userId: id }, "session references a missing user — denying");

    return null;
  }

  return {
    id: row.id,
    role: row.role,
    accountStatus: row.accountStatus,
    mustChangePassword: row.mustChangePassword,
    email: row.email,
    name: row.name,
  };
}

export async function requireSession(): Promise<SessionUser> {
  const user = await getSessionUser();

  if (!user) {
    log.debug("denied: unauthenticated");
    throw new MaisterError("UNAUTHENTICATED", "Sign in required");
  }

  return user;
}

/**
 * Authenticated AND cleared for action. Every protected, role-gated API funnels
 * through here (via requireGlobalRole / requireProjectRole), so a user whose
 * account still requires a password change (seeded admin, admin-forced reset)
 * is rejected on ALL of them — the page-level redirect is not the only gate.
 * `requireSession` / `getSessionUser` stay permissive on purpose: the
 * change-password page + `changePassword` action need the session to clear it.
 */
export async function requireActiveSession(): Promise<SessionUser> {
  const user = await requireSession();

  if (user.accountStatus !== "active") {
    log.warn(
      { userId: user.id, status: user.accountStatus },
      "denied: inactive account",
    );
    throw new MaisterError(
      "ACCOUNT_INACTIVE",
      "Account is not active. Ask an admin to approve or re-enable it.",
    );
  }

  if (user.mustChangePassword) {
    log.warn({ userId: user.id }, "denied: password change required");
    throw new MaisterError(
      "PASSWORD_CHANGE_REQUIRED",
      "Password change required before any action",
    );
  }

  return user;
}

export async function requireGlobalRole(min: GlobalRole): Promise<SessionUser> {
  const user = await requireActiveSession();
  const granted = GLOBAL_ORDER[user.role] >= GLOBAL_ORDER[min];

  log.debug({ userId: user.id, role: user.role, min, granted }, "global role");

  if (!granted) {
    throw new MaisterError("UNAUTHORIZED", `Requires global role: ${min}`);
  }

  return user;
}

export async function getProjectRole(
  userId: string,
  projectId: string,
): Promise<ProjectRole | null> {
  const rows = await db()
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.userId, userId),
        eq(projectMembers.projectId, projectId),
      ),
    );

  return rows[0]?.role ?? null;
}

export interface ProjectAccess {
  user: SessionUser;
  role: ProjectRole;
}

/**
 * Authorize the current session against a project. `projectId` MUST be a
 * server-derived value (url-param resolved to a row, or server-state) — never
 * a raw body field. Global admins are implicit owners of every project.
 */
export async function requireProjectRole(
  projectId: string,
  min: ProjectRole,
): Promise<ProjectAccess> {
  const user = await requireActiveSession();

  if (user.role === "admin") {
    log.debug(
      { userId: user.id, projectId },
      "project access via global admin",
    );

    return { user, role: "owner" };
  }

  const role = await getProjectRole(user.id, projectId);
  const granted = role !== null && PROJECT_ORDER[role] >= PROJECT_ORDER[min];

  log.debug({ userId: user.id, projectId, role, min, granted }, "project role");

  if (!granted) {
    throw new MaisterError(
      "UNAUTHORIZED",
      `Requires project role ${min} for ${projectId}`,
    );
  }

  return { user, role: role as ProjectRole };
}

export function requireProjectAction(
  projectId: string,
  action: ProjectAction,
): Promise<ProjectAccess> {
  return requireProjectRole(projectId, PROJECT_ACTION_MIN[action]);
}

export function httpStatusForAuthz(code: string): number | null {
  if (code === "UNAUTHENTICATED") return 401;
  if (code === "UNAUTHORIZED") return 403;
  if (code === "PASSWORD_CHANGE_REQUIRED") return 403;
  if (code === "ACCOUNT_INACTIVE") return 403;

  return null;
}
