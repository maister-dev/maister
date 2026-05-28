import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { GlobalRole, ProjectRole } from "@/lib/db/schema";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import { auth } from "@/auth";
import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const log = pino({ name: "authz", level: process.env.LOG_LEVEL ?? "info" });

const { projectMembers } = schema;

// FIXME(any): getDb() returns a pg|sqlite drizzle union; narrow to pg. POC = Postgres.
function db(): NodePgDatabase<typeof schema> {
  return getDb() as unknown as NodePgDatabase<typeof schema>;
}

export interface SessionUser {
  id: string;
  role: GlobalRole;
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
  launchRun: "member",
  createTask: "member",
  answerHitl: "member",
  editSettings: "admin",
} as const satisfies Record<string, ProjectRole>;

export type ProjectAction = keyof typeof PROJECT_ACTION_MIN;

export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth();

  if (!session?.user?.id) return null;

  return {
    id: session.user.id,
    role: session.user.role,
    email: session.user.email,
    name: session.user.name,
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

export async function requireGlobalRole(min: GlobalRole): Promise<SessionUser> {
  const user = await requireSession();
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
  const user = await requireSession();

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

  return null;
}
