import "server-only";

/**
 * The cross-project activity feed (`ATN-09`, ADR-168).
 *
 * "What happened that I have not seen", as a list. The `updates` counter in
 * `lib/queries/updates.ts` counts the same populations; both read
 * `ATTENTION_EVENT_KINDS`, so the badge and the page cannot drift apart by
 * counting a fact one of them does not show.
 *
 * Three sources, unioned because no single table holds them:
 *
 * - `task_activity` — the 13 board facts (comments, mentions, relations,
 *   launches, triage, PR merges).
 * - `domain_events` restricted to `ATTENTION_EVENT_KINDS` — run terminal
 *   transitions and gate outcomes, which are NOT `task_activity` kinds
 *   (`run_finished` does not exist; adding one needs the `setRunStatus` choke
 *   point, out of scope).
 * - `webhook_deliveries` — delivery OUTCOMES. Never the payload, never the
 *   response body, never the target URL.
 *
 * `ATN-09` — every row is an explicit whitelist projection. No `payload`
 * column is ever selected: the two fields the feed needs out of one
 * (`gateId`, `hitlRequestId`, plus `run_launched`'s `runId`) are extracted as
 * scalars in SQL, so a worktree path or a diff hunk sitting in a payload has
 * no route into this process, let alone into the DTO.
 */

import type { ActorDTO } from "@/lib/social/actors";
import type { AttentionEventKind } from "@/lib/domain-events/taxonomy";
import type {
  GlobalRole,
  TaskActivityEventKind,
  WebhookErrorKind,
} from "@/lib/db/schema";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import pino from "pino";

import { ATTENTION_EVENT_KINDS } from "@/lib/domain-events/taxonomy";
import { TASK_ACTIVITY_EVENT_KINDS } from "@/lib/db/schema";
import { actorDTO, resolveActorLabels } from "@/lib/social/actors";
import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { getVisibleProjectIds } from "@/lib/queries/visible-projects";

const {
  domainEvents,
  projects,
  taskActivity,
  tasks,
  webhookDeliveries,
  webhookEvents,
  webhookSubscriptions,
} = schema;

const log = pino({
  name: "queries-activity-feed",
  level: process.env.LOG_LEVEL ?? "info",
});

export const ACTIVITY_FEED_DEFAULT_LIMIT = 100;
export const ACTIVITY_FEED_MAX_LIMIT = 200;

export const ACTIVITY_SOURCES = ["task", "event", "webhook"] as const;
export type ActivitySource = (typeof ACTIVITY_SOURCES)[number];

export const ACTIVITY_ACTOR_TYPES = ["user", "agent", "system"] as const;
export type ActivityActorType = (typeof ACTIVITY_ACTOR_TYPES)[number];

/**
 * A delivery is shown only once it has settled. `pending` is the drainer's
 * business, not the reader's.
 */
export const ACTIVITY_WEBHOOK_KINDS = [
  "webhook_delivered",
  "webhook_dead",
] as const;
export type ActivityWebhookKind = (typeof ACTIVITY_WEBHOOK_KINDS)[number];

export type ActivityFeedKind =
  | TaskActivityEventKind
  | AttentionEventKind
  | ActivityWebhookKind;

export const ACTIVITY_FEED_KINDS = [
  ...TASK_ACTIVITY_EVENT_KINDS,
  ...ATTENTION_EVENT_KINDS,
  ...ACTIVITY_WEBHOOK_KINDS,
] as const satisfies readonly ActivityFeedKind[];

export function isActivityFeedKind(value: string): value is ActivityFeedKind {
  return (ACTIVITY_FEED_KINDS as readonly string[]).includes(value);
}

export interface ActivityFeedWebhook {
  subscriptionName: string;
  attemptCount: number;
  httpStatus: number | null;
  errorKind: WebhookErrorKind | null;
}

export interface ActivityFeedRow {
  id: string;
  source: ActivitySource;
  kind: ActivityFeedKind;
  occurredAt: Date;
  projectId: string;
  projectSlug: string;
  projectName: string;
  actor: ActorDTO | null;
  taskId: string | null;
  taskKey: string | null;
  taskNumber: number | null;
  taskTitle: string | null;
  runId: string | null;
  gateId: string | null;
  hitlRequestId: string | null;
  webhook: ActivityFeedWebhook | null;
}

export interface ActivityFeedFilters {
  projectId?: string | null;
  actorType?: ActivityActorType | null;
  kind?: ActivityFeedKind | null;
  /**
   * Activity on tasks the reader SUBSCRIBES to — not activity the reader
   * caused. "What I did" is already reachable through `actorType`, and it is
   * the one slice nobody needs to catch up on.
   */
  mine?: boolean;
}

export interface ActivityFeedOptions extends ActivityFeedFilters {
  limit?: number;
}

export interface ActivityFeedResult {
  rows: ActivityFeedRow[];
  hasMore: boolean;
  projectCount: number;
}

export interface ActivityFeedUser {
  id: string;
  role: GlobalRole;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return ACTIVITY_FEED_DEFAULT_LIMIT;

  return Math.min(Math.max(Math.trunc(limit), 1), ACTIVITY_FEED_MAX_LIMIT);
}

export async function getCrossProjectActivityFeed(
  user: ActivityFeedUser,
  options: ActivityFeedOptions = {},
): Promise<ActivityFeedResult> {
  const client = getDb() as NodePgDatabase<typeof schema>;
  const visibleIds = await getVisibleProjectIds(user.id, user.role, client);
  // A filter naming a project the reader cannot see intersects to nothing —
  // dropped, never refused, so a shared deep link degrades to an empty feed
  // instead of leaking that the project exists.
  const projectIds = options.projectId
    ? visibleIds.filter((id) => id === options.projectId)
    : visibleIds;

  if (projectIds.length === 0) {
    return { rows: [], hasMore: false, projectCount: visibleIds.length };
  }

  const limit = clampLimit(options.limit);
  // One extra row per source answers "is there more" without a second COUNT.
  const take = limit + 1;
  const kind = options.kind ?? null;
  const wantTask =
    kind === null ||
    (TASK_ACTIVITY_EVENT_KINDS as readonly string[]).includes(kind);
  const wantEvent =
    kind === null ||
    (ATTENTION_EVENT_KINDS as readonly string[]).includes(kind);
  // A delivery has no task and no actor, so both `mine` and an actor filter
  // exclude the whole source rather than filtering inside it.
  const wantWebhook =
    (kind === null ||
      (ACTIVITY_WEBHOOK_KINDS as readonly string[]).includes(kind)) &&
    options.mine !== true &&
    !options.actorType;

  const subscribed = (taskIdColumn: unknown) =>
    sql`exists (select 1 from task_subscribers ts
                where ts.task_id = ${taskIdColumn}
                  and ts.subscriber_type = 'user'
                  and ts.subscriber_id = ${user.id})`;

  const [taskRows, eventRows, webhookRows, projectRows] = await Promise.all([
    wantTask
      ? client
          .select({
            id: taskActivity.id,
            kind: taskActivity.eventKind,
            occurredAt: taskActivity.createdAt,
            projectId: taskActivity.projectId,
            actorType: taskActivity.actorType,
            actorId: taskActivity.actorId,
            taskId: taskActivity.taskId,
            taskNumber: tasks.number,
            taskTitle: tasks.title,
            runId: sql<string | null>`${taskActivity.payload}->>'runId'`,
          })
          .from(taskActivity)
          .innerJoin(tasks, eq(tasks.id, taskActivity.taskId))
          .where(
            and(
              inArray(taskActivity.projectId, projectIds),
              ...(kind
                ? [eq(taskActivity.eventKind, kind as TaskActivityEventKind)]
                : []),
              ...(options.actorType
                ? [eq(taskActivity.actorType, options.actorType)]
                : []),
              ...(options.mine ? [subscribed(taskActivity.taskId)] : []),
            ),
          )
          .orderBy(desc(taskActivity.createdAt), desc(taskActivity.id))
          .limit(take)
      : [],
    wantEvent
      ? client
          .select({
            id: domainEvents.id,
            kind: domainEvents.kind,
            occurredAt: domainEvents.occurredAt,
            projectId: domainEvents.projectId,
            actorType: domainEvents.actorType,
            actorId: domainEvents.actorId,
            taskId: domainEvents.taskId,
            taskNumber: tasks.number,
            taskTitle: tasks.title,
            runId: domainEvents.runId,
            gateId: sql<string | null>`${domainEvents.payload}->>'gateId'`,
            hitlRequestId: sql<
              string | null
            >`${domainEvents.payload}->>'hitlRequestId'`,
          })
          .from(domainEvents)
          .leftJoin(tasks, eq(tasks.id, domainEvents.taskId))
          .where(
            and(
              inArray(domainEvents.projectId, projectIds),
              inArray(
                domainEvents.kind,
                kind
                  ? [kind as AttentionEventKind]
                  : [...ATTENTION_EVENT_KINDS],
              ),
              ...(options.actorType
                ? [eq(domainEvents.actorType, options.actorType)]
                : []),
              // A run event with no task cannot be "mine" by subscription.
              ...(options.mine ? [subscribed(domainEvents.taskId)] : []),
            ),
          )
          .orderBy(desc(domainEvents.occurredAt), desc(domainEvents.id))
          .limit(take)
      : [],
    wantWebhook
      ? client
          .select({
            id: webhookDeliveries.id,
            status: webhookDeliveries.status,
            occurredAt: webhookDeliveries.updatedAt,
            attemptCount: webhookDeliveries.attemptCount,
            httpStatus: webhookDeliveries.lastHttpStatus,
            errorKind: webhookDeliveries.lastErrorKind,
            projectId: webhookEvents.projectId,
            runId: webhookEvents.runId,
            subscriptionName: webhookSubscriptions.name,
          })
          .from(webhookDeliveries)
          .innerJoin(
            webhookEvents,
            eq(webhookEvents.id, webhookDeliveries.eventId),
          )
          .innerJoin(
            webhookSubscriptions,
            eq(webhookSubscriptions.id, webhookDeliveries.subscriptionId),
          )
          .where(
            and(
              inArray(webhookEvents.projectId, projectIds),
              inArray(
                webhookDeliveries.status,
                kind === "webhook_delivered"
                  ? ["delivered"]
                  : kind === "webhook_dead"
                    ? ["dead"]
                    : ["delivered", "dead"],
              ),
            ),
          )
          .orderBy(
            desc(webhookDeliveries.updatedAt),
            desc(webhookDeliveries.id),
          )
          .limit(take)
      : [],
    client
      .select({
        id: projects.id,
        slug: projects.slug,
        name: projects.name,
        taskKey: projects.taskKey,
      })
      .from(projects)
      .where(inArray(projects.id, projectIds)),
  ]);

  const projectById = new Map(projectRows.map((row) => [row.id, row]));
  const labels = await resolveActorLabels(
    [...taskRows, ...eventRows].flatMap((row) =>
      row.actorType ? [{ actorType: row.actorType, actorId: row.actorId }] : [],
    ),
    client,
  );

  const keyRef = (
    projectId: string,
    taskNumber: number | null,
  ): string | null => {
    const project = projectById.get(projectId);

    return project && taskNumber !== null
      ? `${project.taskKey}-${taskNumber}`
      : null;
  };
  const projected: ActivityFeedRow[] = [];

  for (const row of taskRows) {
    const project = projectById.get(row.projectId);

    if (!project) continue;
    projected.push({
      id: `task:${row.id}`,
      source: "task",
      kind: row.kind,
      occurredAt: row.occurredAt,
      projectId: project.id,
      projectSlug: project.slug,
      projectName: project.name,
      actor: actorDTO(row, labels),
      taskId: row.taskId,
      taskKey: keyRef(row.projectId, row.taskNumber),
      taskNumber: row.taskNumber,
      taskTitle: row.taskTitle,
      runId: row.runId,
      gateId: null,
      hitlRequestId: null,
      webhook: null,
    });
  }

  for (const row of eventRows) {
    const project = projectById.get(row.projectId);

    if (!project) continue;
    projected.push({
      id: `event:${row.id}`,
      source: "event",
      // The WHERE clause is `inArray(kind, ATTENTION_EVENT_KINDS)`; drizzle
      // types the column by its CHECK, which is the wider taxonomy.
      kind: row.kind as AttentionEventKind,
      occurredAt: row.occurredAt,
      projectId: project.id,
      projectSlug: project.slug,
      projectName: project.name,
      // `domain_events.actor_type` is nullable — a fact the system recorded
      // with no actor at all is not the same as the `system` actor.
      actor: row.actorType
        ? actorDTO({ actorType: row.actorType, actorId: row.actorId }, labels)
        : null,
      taskId: row.taskId,
      taskKey: keyRef(row.projectId, row.taskNumber),
      taskNumber: row.taskNumber,
      taskTitle: row.taskTitle,
      runId: row.runId,
      gateId: row.gateId,
      hitlRequestId: row.hitlRequestId,
      webhook: null,
    });
  }

  for (const row of webhookRows) {
    // ADR-172 D2 reader: `webhook_events.project_id` is nullable since the ADR-172 widening,
    // and a NULL one is a USER-scoped `attention.*` delivery. It is deliberately
    // absent from this feed — the cross-project activity log answers "what
    // happened in the projects I can see", and somebody's personal notification
    // is not project activity. The WHERE clause already drops it (`IN` never
    // matches NULL); this is the type-level half of the same decision.
    const project = row.projectId ? projectById.get(row.projectId) : undefined;

    if (!project) continue;
    projected.push({
      id: `webhook:${row.id}`,
      source: "webhook",
      kind: row.status === "delivered" ? "webhook_delivered" : "webhook_dead",
      occurredAt: row.occurredAt,
      projectId: project.id,
      projectSlug: project.slug,
      projectName: project.name,
      actor: null,
      taskId: null,
      taskKey: null,
      taskNumber: null,
      taskTitle: null,
      runId: row.runId,
      gateId: null,
      hitlRequestId: null,
      webhook: {
        subscriptionName: row.subscriptionName,
        attemptCount: row.attemptCount,
        httpStatus: row.httpStatus,
        errorKind: row.errorKind,
      },
    });
  }

  // Each source is already ordered and capped, so the merge is a sort over at
  // most `3 * (limit + 1)` rows. The id tie-break is what makes two rows
  // written in the same transaction render in a stable order.
  projected.sort(
    (a, b) =>
      b.occurredAt.getTime() - a.occurredAt.getTime() ||
      (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );

  const rows = projected.slice(0, limit);

  log.debug(
    {
      userId: user.id,
      projectCount: projectIds.length,
      task: taskRows.length,
      events: eventRows.length,
      webhooks: webhookRows.length,
      returned: rows.length,
    },
    "cross-project activity feed",
  );

  return {
    rows,
    hasMore: projected.length > rows.length,
    projectCount: visibleIds.length,
  };
}
