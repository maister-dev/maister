import "server-only";

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/services/tasks.ts).
const { inboxItems, projects, tasks } = schemaModule as unknown as Record<
  string,
  any
>;

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
// count by both badge scopes.
export async function getUnreadInboxCount(
  userId: string,
  projectId?: string,
): Promise<number> {
  const db = getDb() as unknown as { select: any };
  const conditions = [
    eq(inboxItems.recipientType, "user"),
    eq(inboxItems.recipientId, userId),
    isNull(inboxItems.readAt),
    ...(projectId ? [eq(inboxItems.projectId, projectId)] : []),
  ];

  const rows = (await db
    .select({ count: sql`count(*)::int` })
    .from(inboxItems)
    .where(and(...conditions))) as Array<{ count: number }>;

  return Number(rows[0]?.count ?? 0);
}

export async function getInboxItems(
  userId: string,
  opts?: { projectId?: string; limit?: number; includeRead?: boolean },
): Promise<InboxItemView[]> {
  const db = getDb() as unknown as { select: any };
  const limit = Math.min(Math.max(opts?.limit ?? 30, 1), 100);
  const conditions = [
    eq(inboxItems.recipientType, "user"),
    eq(inboxItems.recipientId, userId),
    ...(opts?.includeRead ? [] : [isNull(inboxItems.readAt)]),
    ...(opts?.projectId ? [eq(inboxItems.projectId, opts.projectId)] : []),
  ];

  const rows = (await db
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
    .innerJoin(tasks, eq(inboxItems.taskId, tasks.id))
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
  projectIds: string[],
): Promise<Map<string, number>> {
  if (projectIds.length === 0) return new Map();

  const db = getDb() as unknown as { select: any };
  const rows = (await db
    .select({
      projectId: inboxItems.projectId,
      count: sql`count(*)::int`,
    })
    .from(inboxItems)
    .where(
      and(
        eq(inboxItems.recipientType, "user"),
        eq(inboxItems.recipientId, userId),
        isNull(inboxItems.readAt),
        inArray(inboxItems.projectId, projectIds),
      ),
    )
    .groupBy(inboxItems.projectId)) as Array<{
    projectId: string;
    count: number;
  }>;

  return new Map(rows.map((r) => [r.projectId, Number(r.count)]));
}
