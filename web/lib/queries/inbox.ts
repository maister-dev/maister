import "server-only";

import type { GlobalRole } from "@/lib/db/schema";

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/services/tasks.ts).
const { inboxItems, projectMembers, projects, tasks } =
  schemaModule as unknown as Record<string, any>;

export type InboxItemView = {
  id: string;
  projectSlug: string;
  projectName: string;
  taskNumber: number;
  taskTitle: string;
  keyRef: string;
  eventKind: string;
  read: boolean;
  createdAt: Date;
};

// "Needs you (N)" (ADR-078 D11) — unread inbox count; project-scoped when
// `projectId` is given, cross-project otherwise. Added to the pending-HITL
// count by both badge scopes. Visibility mirrors getCrossProjectHitlInbox:
// non-admin recipients see only projects they are currently a member of and
// archived projects are excluded — fanout rows outlive membership, so stale
// items from revoked projects must not leak titles/keys.
export async function getUnreadInboxCount(
  userId: string,
  globalRole: GlobalRole,
  projectId?: string,
): Promise<number> {
  const db = getDb() as unknown as { select: any };
  const conditions = [
    eq(inboxItems.recipientType, "user"),
    eq(inboxItems.recipientId, userId),
    isNull(inboxItems.readAt),
    isNull(projects.archivedAt),
    ...(projectId ? [eq(inboxItems.projectId, projectId)] : []),
  ];

  let query = db
    .select({ count: sql`count(*)::int` })
    .from(inboxItems)
    .innerJoin(projects, eq(inboxItems.projectId, projects.id));

  if (globalRole !== "admin") {
    query = query.innerJoin(
      projectMembers,
      and(
        eq(projectMembers.projectId, inboxItems.projectId),
        eq(projectMembers.userId, userId),
      ),
    );
  }

  const rows = (await query.where(and(...conditions))) as Array<{
    count: number;
  }>;

  return Number(rows[0]?.count ?? 0);
}

export async function getInboxItems(
  userId: string,
  globalRole: GlobalRole,
  opts?: { projectId?: string; limit?: number; includeRead?: boolean },
): Promise<InboxItemView[]> {
  const db = getDb() as unknown as { select: any };
  const limit = Math.min(Math.max(opts?.limit ?? 30, 1), 100);
  const conditions = [
    eq(inboxItems.recipientType, "user"),
    eq(inboxItems.recipientId, userId),
    isNull(projects.archivedAt),
    ...(opts?.includeRead ? [] : [isNull(inboxItems.readAt)]),
    ...(opts?.projectId ? [eq(inboxItems.projectId, opts.projectId)] : []),
  ];

  let query = db
    .select({
      id: inboxItems.id,
      eventKind: inboxItems.eventKind,
      readAt: inboxItems.readAt,
      createdAt: inboxItems.createdAt,
      projectSlug: projects.slug,
      projectName: projects.name,
      taskKey: projects.taskKey,
      taskNumber: tasks.number,
      taskTitle: tasks.title,
    })
    .from(inboxItems)
    .innerJoin(projects, eq(inboxItems.projectId, projects.id))
    .innerJoin(tasks, eq(inboxItems.taskId, tasks.id));

  if (globalRole !== "admin") {
    query = query.innerJoin(
      projectMembers,
      and(
        eq(projectMembers.projectId, inboxItems.projectId),
        eq(projectMembers.userId, userId),
      ),
    );
  }

  const rows = (await query
    .where(and(...conditions))
    .orderBy(desc(inboxItems.createdAt))
    .limit(limit)) as Array<{
    id: string;
    eventKind: string;
    readAt: Date | null;
    createdAt: Date;
    projectSlug: string;
    projectName: string;
    taskKey: string;
    taskNumber: number;
    taskTitle: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    projectSlug: row.projectSlug,
    projectName: row.projectName,
    taskNumber: row.taskNumber,
    taskTitle: row.taskTitle,
    keyRef: `${row.taskKey}-${row.taskNumber}`,
    eventKind: row.eventKind,
    read: row.readAt !== null,
    createdAt: row.createdAt,
  }));
}

export async function getUnreadInboxCountsByProject(
  userId: string,
  globalRole: GlobalRole,
  projectIds: string[],
): Promise<Map<string, number>> {
  if (projectIds.length === 0) return new Map();

  const db = getDb() as unknown as { select: any };

  let query = db
    .select({
      projectId: inboxItems.projectId,
      count: sql`count(*)::int`,
    })
    .from(inboxItems)
    .innerJoin(projects, eq(inboxItems.projectId, projects.id));

  if (globalRole !== "admin") {
    query = query.innerJoin(
      projectMembers,
      and(
        eq(projectMembers.projectId, inboxItems.projectId),
        eq(projectMembers.userId, userId),
      ),
    );
  }

  const rows = (await query
    .where(
      and(
        eq(inboxItems.recipientType, "user"),
        eq(inboxItems.recipientId, userId),
        isNull(inboxItems.readAt),
        isNull(projects.archivedAt),
        inArray(inboxItems.projectId, projectIds),
      ),
    )
    .groupBy(inboxItems.projectId)) as Array<{
    projectId: string;
    count: number;
  }>;

  return new Map(rows.map((r) => [r.projectId, Number(r.count)]));
}
