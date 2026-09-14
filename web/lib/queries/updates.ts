import "server-only";

/**
 * The `updates` counter (ADR-169 D1, D2, D3, D4).
 *
 * "What happened that I have not seen." Nothing here waits on anyone — that is
 * what keeps it off the attention tone and out of `decisions`.
 *
 * ```
 * updates = unread inbox_items
 *         + activity newer than the reader's cursor
 *           MINUS rows already represented by an unread inbox_item
 * ```
 *
 * The MINUS is load-bearing and it has a key: `source_ref->>'activityId'`.
 * A single mention writes BOTH a `task_activity` row and an `inbox_items` row
 * for its recipient, so summing the two populations double-counts the most
 * common event in the system. That is why this is a join and not two cheap
 * counts.
 *
 * The same trap exists one table over: three `domain_events` kinds are emitted
 * in the SAME transaction as a `task_activity` row carrying the same fact, so
 * the event side reads `ATTENTION_EVENT_KINDS` — the complement — and the
 * activity feed renders exactly that population.
 */

import type { GlobalRole } from "@/lib/db/schema";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import pino from "pino";

import { ATTENTION_EVENT_KINDS } from "@/lib/domain-events/taxonomy";
import { getActivityCursor } from "@/lib/queries/activity-cursor";
import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { getVisibleProjectIds } from "@/lib/queries/visible-projects";
import { getOpenRelationBlockers } from "@/lib/social/relations";

const { domainEvents, inboxItems, taskActivity } = schema;

const log = pino({
  name: "queries-updates",
  level: process.env.LOG_LEVEL ?? "info",
});

/**
 * ADR-169 D3. An absent cursor row means "never looked", NOT "has seen nothing
 * ever" — counting all history would render a four-digit badge on a first visit
 * and train the reader to dismiss it permanently. Matches the digest's fallback.
 */
export const UPDATES_NO_CURSOR_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function getUpdatesCount(
  userId: string,
  globalRole: GlobalRole,
  now: Date = new Date(),
): Promise<number> {
  const client = getDb() as NodePgDatabase<typeof schema>;
  // ADR-169 D4: activity is filtered by CURRENT visibility and the cursor is
  // never rewound, so a new member sees a project from joining forward and a
  // removed one stops seeing it immediately.
  const projectIds = await getVisibleProjectIds(userId, globalRole, client);

  if (projectIds.length === 0) return 0;

  const cursor = await getActivityCursor(userId, client);
  const since = cursor ?? new Date(now.getTime() - UPDATES_NO_CURSOR_WINDOW_MS);

  const [unreadRows, activityRows, eventRows] = await Promise.all([
    client
      .select({
        id: inboxItems.id,
        taskId: inboxItems.taskId,
        activityId: sql<string | null>`${inboxItems.sourceRef}->>'activityId'`,
      })
      .from(inboxItems)
      .where(
        and(
          eq(inboxItems.recipientType, "user"),
          eq(inboxItems.recipientId, userId),
          isNull(inboxItems.readAt),
          inArray(inboxItems.projectId, projectIds),
        ),
      ),
    client
      .select({ id: taskActivity.id, taskId: taskActivity.taskId })
      .from(taskActivity)
      .where(
        and(
          inArray(taskActivity.projectId, projectIds),
          gt(taskActivity.createdAt, since),
        ),
      ),
    client
      .select({ id: domainEvents.id, taskId: domainEvents.taskId })
      .from(domainEvents)
      .where(
        and(
          inArray(domainEvents.projectId, projectIds),
          inArray(domainEvents.kind, [...ATTENTION_EVENT_KINDS]),
          gt(domainEvents.occurredAt, since),
        ),
      ),
  ]);

  // ADR-169 D5 / ATN-04: a relation-blocked task counts in NEITHER counter.
  const taskIds = [
    ...new Set(
      [...unreadRows, ...activityRows, ...eventRows].flatMap((row) =>
        row.taskId ? [row.taskId] : [],
      ),
    ),
  ];
  const blockersByTask = await getOpenRelationBlockers(taskIds, client);
  const unblocked = <T extends { taskId: string | null }>(row: T): boolean =>
    row.taskId === null || (blockersByTask.get(row.taskId)?.length ?? 0) === 0;

  const unread = unreadRows.filter(unblocked);
  const representedActivityIds = new Set(
    unread.flatMap((row) => (row.activityId ? [row.activityId] : [])),
  );
  const unrepresentedActivity = activityRows
    .filter(unblocked)
    .filter((row) => !representedActivityIds.has(row.id));
  const events = eventRows.filter(unblocked);
  const count = unread.length + unrepresentedActivity.length + events.length;

  log.debug(
    {
      userId,
      projectCount: projectIds.length,
      hasCursor: cursor !== null,
      unread: unread.length,
      activity: activityRows.length,
      overlap: activityRows.length - unrepresentedActivity.length,
      events: events.length,
      count,
    },
    "updates counter",
  );

  return count;
}
