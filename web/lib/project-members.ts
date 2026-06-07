import "server-only";

import type { ProjectRole } from "@/lib/db/schema";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { randomUUID } from "node:crypto";

import { and, asc, eq, ilike, notInArray, or } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "project-members",
  level: process.env.LOG_LEVEL ?? "info",
});

const { projectMembers, users } = schema;

// FIXME(any): getDb() returns a pg|sqlite drizzle union; narrow to pg.
function db(): NodePgDatabase<typeof schema> {
  return getDb() as unknown as NodePgDatabase<typeof schema>;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "23505"
  );
}

export interface ProjectMemberRow {
  memberId: string;
  userId: string;
  name: string | null;
  email: string;
  role: ProjectRole;
  createdAt: Date;
  addedBy: string | null;
}

export interface MemberCandidate {
  id: string;
  name: string | null;
  email: string;
}

export interface AddProjectMemberInput {
  projectId: string;
  userId: string;
  role: ProjectRole;
  actorId: string;
}

export interface ChangeProjectMemberRoleInput {
  projectId: string;
  memberId: string;
  role: ProjectRole;
  expectedRole: ProjectRole;
  actorId: string;
}

export interface RemoveProjectMemberInput {
  projectId: string;
  memberId: string;
  expectedRole: ProjectRole;
  actorId: string;
}

export async function listProjectMembers(
  projectId: string,
): Promise<ProjectMemberRow[]> {
  const rows = await db()
    .select({
      memberId: projectMembers.id,
      userId: projectMembers.userId,
      name: users.name,
      email: users.email,
      role: projectMembers.role,
      createdAt: projectMembers.createdAt,
      addedBy: projectMembers.addedBy,
    })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, projectId))
    .orderBy(asc(projectMembers.createdAt));

  return rows;
}

export async function searchMemberCandidates(
  projectId: string,
  q: string,
  limit = 10,
): Promise<MemberCandidate[]> {
  const existingMemberRows = await db()
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(eq(projectMembers.projectId, projectId));

  const existingUserIds = existingMemberRows.map((r) => r.userId);

  const pattern = `%${q}%`;

  let query = db()
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(
      and(
        existingUserIds.length > 0
          ? notInArray(users.id, existingUserIds)
          : undefined,
        or(ilike(users.email, pattern), ilike(users.name, pattern)),
      ),
    )
    .limit(limit)
    .$dynamic();

  return query;
}

export async function addProjectMember(
  input: AddProjectMemberInput,
): Promise<{ memberId: string }> {
  const { projectId, userId, role, actorId } = input;

  const existing = await db()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId));

  if (existing.length === 0) {
    throw new MaisterError("PRECONDITION", "User not found");
  }

  const memberId = randomUUID();

  try {
    await db().insert(projectMembers).values({
      id: memberId,
      projectId,
      userId,
      role,
      addedBy: actorId,
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new MaisterError("CONFLICT", "User is already a member");
    }

    throw err;
  }

  log.info(
    { projectId, userId, actorId, action: "addProjectMember" },
    "member added",
  );

  return { memberId };
}

export async function changeProjectMemberRole(
  input: ChangeProjectMemberRoleInput,
): Promise<void> {
  const { projectId, memberId, role, expectedRole, actorId } = input;

  // Optimistic CAS: the update only lands when the row still holds the role the
  // caller observed in the roster. A concurrent role-change (or remove) shifts
  // the row off `expectedRole`, so this matches 0 rows and surfaces as CONFLICT
  // instead of silently clobbering the other admin's write.
  const updated = await db()
    .update(projectMembers)
    .set({ role, updatedBy: actorId, updatedAt: new Date() })
    .where(
      and(
        eq(projectMembers.id, memberId),
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.role, expectedRole),
      ),
    )
    .returning({ id: projectMembers.id });

  if (updated.length === 0) {
    throw new MaisterError(
      "CONFLICT",
      "Member not found or changed concurrently",
    );
  }

  log.info(
    { projectId, memberId, actorId, action: "changeProjectMemberRole", role },
    "member role changed",
  );
}

export async function removeProjectMember(
  input: RemoveProjectMemberInput,
): Promise<void> {
  const { projectId, memberId, expectedRole, actorId } = input;

  // Optimistic CAS: only delete the row the caller observed. If another admin
  // re-roled or removed it first, the role predicate matches 0 rows and we
  // surface CONFLICT rather than silently dropping a row that changed underneath.
  const removed = await db()
    .delete(projectMembers)
    .where(
      and(
        eq(projectMembers.id, memberId),
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.role, expectedRole),
      ),
    )
    .returning({ id: projectMembers.id });

  if (removed.length === 0) {
    throw new MaisterError(
      "CONFLICT",
      "Member not found or changed concurrently",
    );
  }

  log.info(
    { projectId, memberId, actorId, action: "removeProjectMember" },
    "member removed",
  );
}
