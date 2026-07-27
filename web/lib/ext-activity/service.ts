import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type {
  ActivityPulseResponse,
  ActivityRunSnapshot,
  ActivityRunStatus,
  ActivitySalience,
  NeedsYouItem,
  RunActivityItem,
  RunActivitySourceMessage,
} from "@/lib/ext-activity/types";

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import {
  encodeRunActivityCursor,
  encodePulseCursor,
  encodeRunSinceId,
  type RunActivityCursor,
} from "@/lib/ext-activity/cursor";
import { mapDomainEventToPulseItem } from "@/lib/ext-activity/domain-events";
import { deriveActivityLiveness } from "@/lib/ext-activity/liveness";
import { listMentionCandidateAgents } from "@/lib/agents/summonability";
import { listProjectNeedsYou } from "@/lib/ext-activity/needs-you";
import { listProjectPromotable } from "@/lib/ext-activity/promotable";
import {
  buildSemanticRunActivityItems,
  pageRunActivityItems,
} from "@/lib/ext-activity/run-feed";
import { filterBySalience } from "@/lib/ext-activity/salience";
import {
  getWholeRunTranscriptMessages,
  projectRunTranscript,
} from "@/lib/runs/run-transcript-projector";

const { domainEvents, nodeAttempts, projects, runMessages, runs, tasks } =
  schema;

const PULSE_PAGE_SIZE = 100;
const ACTIVE_PULSE_RUN_STATUSES = [
  "Running",
  "NeedsInput",
  "NeedsInputIdle",
  "HumanWorking",
] as const;

type DbClient = NodePgDatabase<typeof schema>;

type RunRow = {
  runId: string;
  projectId: string;
  runKind: "flow" | "scratch" | "agent";
  status: ActivityRunStatus;
  currentStepId: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  taskId: string | null;
  taskKey: string | null;
  taskTitle: string | null;
};

function db(): DbClient {
  return getDb();
}

function toBigInt(value: bigint | number | string | null | undefined): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string" && value.length > 0) return BigInt(value);

  return 0n;
}

async function loadRunRow(
  projectId: string,
  runId: string,
  client: DbClient,
): Promise<RunRow | null> {
  const rows = await client
    .select({
      runId: runs.id,
      projectId: runs.projectId,
      runKind: runs.runKind,
      status: runs.status,
      currentStepId: runs.currentStepId,
      startedAt: runs.startedAt,
      endedAt: runs.endedAt,
      taskId: runs.taskId,
      taskTitle: tasks.title,
      projectTaskKey: projects.taskKey,
      taskNumber: tasks.number,
    })
    .from(runs)
    .innerJoin(projects, eq(projects.id, runs.projectId))
    .leftJoin(tasks, eq(tasks.id, runs.taskId))
    .where(and(eq(runs.id, runId), eq(runs.projectId, projectId)))
    .limit(1);

  const row = rows[0];

  if (!row) return null;

  return {
    runId: row.runId,
    projectId: row.projectId ?? projectId,
    runKind: row.runKind,
    status: row.status,
    currentStepId: row.currentStepId ?? null,
    startedAt: row.startedAt ?? null,
    endedAt: row.endedAt ?? null,
    taskId: row.taskId ?? null,
    taskKey:
      row.projectTaskKey && row.taskNumber !== null
        ? `${row.projectTaskKey}-${row.taskNumber}`
        : null,
    taskTitle: row.taskTitle ?? null,
  };
}

async function loadActiveRunRows(
  projectId: string,
  client: DbClient,
): Promise<RunRow[]> {
  const rows = await client
    .select({
      runId: runs.id,
      projectId: runs.projectId,
      runKind: runs.runKind,
      status: runs.status,
      currentStepId: runs.currentStepId,
      startedAt: runs.startedAt,
      endedAt: runs.endedAt,
      taskId: runs.taskId,
      taskTitle: tasks.title,
      projectTaskKey: projects.taskKey,
      taskNumber: tasks.number,
    })
    .from(runs)
    .innerJoin(projects, eq(projects.id, runs.projectId))
    .leftJoin(tasks, eq(tasks.id, runs.taskId))
    .where(
      and(
        eq(runs.projectId, projectId),
        inArray(runs.status, [...ACTIVE_PULSE_RUN_STATUSES]),
      ),
    )
    .orderBy(asc(runs.startedAt), asc(runs.id));

  return rows.map((row) => ({
    runId: row.runId,
    projectId: row.projectId ?? projectId,
    runKind: row.runKind,
    status: row.status as (typeof ACTIVE_PULSE_RUN_STATUSES)[number],
    currentStepId: row.currentStepId ?? null,
    startedAt: row.startedAt ?? null,
    endedAt: row.endedAt ?? null,
    taskId: row.taskId ?? null,
    taskKey:
      row.projectTaskKey && row.taskNumber !== null
        ? `${row.projectTaskKey}-${row.taskNumber}`
        : null,
    taskTitle: row.taskTitle ?? null,
  }));
}

async function loadCurrentAttemptNumber(
  runId: string,
  currentStepId: string | null,
  client: DbClient,
): Promise<number | null> {
  if (!currentStepId) return null;
  const rows = await client
    .select({ attempt: nodeAttempts.attempt })
    .from(nodeAttempts)
    .where(
      and(
        eq(nodeAttempts.runId, runId),
        eq(nodeAttempts.nodeId, currentStepId),
      ),
    )
    .orderBy(desc(nodeAttempts.attempt))
    .limit(1);

  return rows[0]?.attempt ?? null;
}

async function loadRunActivitySources(
  run: RunRow,
  client: DbClient,
): Promise<{
  messages: RunActivitySourceMessage[];
  lastObservedAt: Date | null;
}> {
  if (run.runKind === "flow") {
    await projectRunTranscript(run.runId, { client });
  }

  const rows = await client
    .select({
      id: runMessages.id,
      role: runMessages.role,
      content: runMessages.content,
      supervisorEventId: runMessages.supervisorEventId,
      createdAt: runMessages.createdAt,
      nodeId: nodeAttempts.nodeId,
    })
    .from(runMessages)
    .leftJoin(nodeAttempts, eq(nodeAttempts.id, runMessages.nodeAttemptId))
    .where(eq(runMessages.runId, run.runId))
    .orderBy(
      sql`coalesce(${runMessages.supervisorEventId}, '0')::bigint asc`,
      asc(runMessages.sequence),
    );

  if (rows.length > 0) {
    return {
      messages: rows.map((row) => ({
        id: row.id,
        runId: run.runId,
        nodeId: row.nodeId ?? null,
        role: row.role,
        content: row.content,
        lastMutationId: toBigInt(row.supervisorEventId),
        ts: row.createdAt ?? null,
      })),
      lastObservedAt: rows[rows.length - 1].createdAt ?? null,
    };
  }

  const wholeRun = await getWholeRunTranscriptMessages(run.runId, { client });

  return {
    messages: wholeRun.messages.map((message) => ({
      id: message.id,
      runId: run.runId,
      nodeId: null,
      role: message.role,
      content: message.content,
      lastMutationId: toBigInt(message.supervisorEventId),
      ts: null,
    })),
    lastObservedAt: wholeRun.lastEventAt,
  };
}

function lastActionFromItems(
  items: readonly RunActivityItem[],
): ActivityRunSnapshot["lastAction"] {
  const item = items[items.length - 1];

  if (!item) return null;

  return {
    summary: item.summary,
    at: item.ts,
    salience: item.salience,
    nodeId: item.nodeId,
    lastMutationId: item.lastMutationId,
  };
}

function firstNeedsYouForRun(
  needsYou: readonly NeedsYouItem[],
  runId: string,
): NeedsYouItem | null {
  return needsYou.find((item) => item.runId === runId) ?? null;
}

async function buildRunSnapshot(
  run: RunRow,
  needsYou: readonly NeedsYouItem[],
  salience: ActivitySalience,
  now: Date,
  client: DbClient,
): Promise<{ snapshot: ActivityRunSnapshot; items: RunActivityItem[] }> {
  const source = await loadRunActivitySources(run, client);
  const allItems = buildSemanticRunActivityItems(source.messages);
  const visibleItems = filterBySalience(allItems, salience);
  const humanNeed = firstNeedsYouForRun(needsYou, run.runId);
  const lastVisibleAction = lastActionFromItems(visibleItems);
  const lastMeaningfulItem = allItems[allItems.length - 1] ?? null;
  const waitingOnToolSince =
    lastMeaningfulItem &&
    (lastMeaningfulItem.action.outcome === "pending" ||
      lastMeaningfulItem.action.outcome === "in_progress")
      ? (lastMeaningfulItem.ts ?? source.lastObservedAt)
      : null;
  const waitingOnHumanSince =
    humanNeed?.requestedAt ??
    (run.status === "NeedsInput" ||
    run.status === "NeedsInputIdle" ||
    run.status === "HumanWorking" ||
    run.status === "Review"
      ? (source.lastObservedAt ?? run.endedAt ?? run.startedAt ?? now)
      : null);
  const lastMeaningfulAt =
    lastMeaningfulItem?.ts ??
    source.lastObservedAt ??
    run.endedAt ??
    run.startedAt ??
    null;
  const currentAttemptNumber = await loadCurrentAttemptNumber(
    run.runId,
    run.currentStepId,
    client,
  );

  return {
    snapshot: {
      runId: run.runId,
      taskId: run.taskId,
      taskKey: run.taskKey,
      taskTitle: run.taskTitle,
      runKind: run.runKind,
      status: run.status,
      currentStepId: run.currentStepId,
      currentAttemptNumber,
      startedAt: run.startedAt,
      lastAction: lastVisibleAction,
      liveness: deriveActivityLiveness({
        runStatus: run.status,
        now,
        lastMeaningfulAt,
        waitingOnHumanSince,
        waitingOnToolSince,
        endedAt: run.endedAt,
      }),
    },
    items: allItems,
  };
}

export async function getActivityPulse(
  projectId: string,
  input: {
    since: bigint | null;
    salience: ActivitySalience;
    now?: Date;
    client?: DbClient;
  },
): Promise<ActivityPulseResponse> {
  const client = input.client ?? db();
  const now = input.now ?? new Date();
  // `needsYou` is a required input to buildRunSnapshot below, so it cannot move
  // past the snapshot loop — but it has no dependency on `promotable`, so the
  // two synthesized blocks are fetched as one wave rather than in series.
  const [needsYou, promotable, mentionCandidates] = await Promise.all([
    listProjectNeedsYou(projectId, { db: client }),
    listProjectPromotable(projectId, { db: client }),
    listMentionCandidateAgents(client, projectId),
  ]);
  const committedHorizon = sql`${domainEvents.txId} < pg_snapshot_xmin(pg_current_snapshot())`;
  const maxIdRows = await client
    .select({ id: domainEvents.id })
    .from(domainEvents)
    .where(and(eq(domainEvents.projectId, projectId), committedHorizon))
    .orderBy(desc(domainEvents.id))
    .limit(1);
  const currentTail = toBigInt(maxIdRows[0]?.id ?? 0);

  const happenedRows =
    input.since === null
      ? []
      : await client
          .select({
            id: domainEvents.id,
            kind: domainEvents.kind,
            occurredAt: domainEvents.occurredAt,
            runId: domainEvents.runId,
            taskId: domainEvents.taskId,
            payload: domainEvents.payload,
          })
          .from(domainEvents)
          .where(
            and(
              eq(domainEvents.projectId, projectId),
              sql`${domainEvents.id} > ${input.since.toString()}::bigint`,
              committedHorizon,
            ),
          )
          .orderBy(asc(domainEvents.id))
          .limit(PULSE_PAGE_SIZE + 1);
  const happenedHasMore = happenedRows.length > PULSE_PAGE_SIZE;
  const happenedMapped = happenedRows.slice(0, PULSE_PAGE_SIZE).map((row) =>
    mapDomainEventToPulseItem({
      id: BigInt(row.id),
      kind: row.kind,
      occurredAt: row.occurredAt,
      runId: row.runId ?? null,
      taskId: row.taskId ?? null,
      taskKey:
        (typeof row.payload?.taskKey === "string"
          ? row.payload.taskKey
          : null) ?? null,
      payload: row.payload,
    }),
  );
  const happenedItems = filterBySalience(happenedMapped, input.salience);
  const nextCursor =
    input.since === null
      ? currentTail
      : happenedMapped.length > 0
        ? BigInt(happenedMapped[happenedMapped.length - 1].id)
        : input.since;
  const activeRuns = await loadActiveRunRows(projectId, client);
  const snapshots = await Promise.all(
    activeRuns.map((run) =>
      buildRunSnapshot(run, needsYou, input.salience, now, client).then(
        (result) => result.snapshot,
      ),
    ),
  );

  return {
    happened: {
      items: happenedItems,
      nextCursor,
      hasMore: happenedHasMore,
    },
    now: {
      generatedAt: now,
      runs: snapshots,
    },
    needsYou: {
      generatedAt: now,
      items: needsYou,
      promotable,
    },
    agents: {
      generatedAt: now,
      // Every attached agent, non-summonable ones INCLUDED with their reason —
      // an assistant that cannot see a blocked agent cannot explain the block.
      items: mentionCandidates.map((agent) => ({
        agentId: agent.id,
        stem: agent.stem,
        displayName: agent.name,
        enabled: agent.linkEnabled,
        summonable: agent.summonable,
        summonBlockedReason: agent.blockedReason,
      })),
    },
  };
}

export async function getRunActivityResponse(
  projectId: string,
  runId: string,
  input: {
    sinceId: RunActivityCursor | null;
    limit: number;
    salience: ActivitySalience;
    now?: Date;
    client?: DbClient;
  },
): Promise<{
  items: RunActivityItem[];
  nextSinceId: RunActivityCursor;
  hasMore: boolean;
  now: ActivityRunSnapshot;
} | null> {
  const client = input.client ?? db();
  const run = await loadRunRow(projectId, runId, client);

  if (!run) return null;

  const now = input.now ?? new Date();
  const needsYou = await listProjectNeedsYou(projectId, { db: client });
  const { snapshot, items } = await buildRunSnapshot(
    run,
    needsYou,
    input.salience,
    now,
    client,
  );
  const page = pageRunActivityItems(items, {
    sinceId: input.sinceId,
    limit: input.limit,
    salience: input.salience,
  });

  return {
    items: page.items,
    nextSinceId: page.nextSinceId,
    hasMore: page.hasMore,
    now: snapshot,
  };
}

export function serializePulseResponse(response: ActivityPulseResponse) {
  return {
    happened: {
      items: response.happened.items.map((item) => ({
        ...item,
        ts: item.ts.toISOString(),
      })),
      nextCursor: encodePulseCursor(response.happened.nextCursor),
      hasMore: response.happened.hasMore,
    },
    now: {
      generatedAt: response.now.generatedAt.toISOString(),
      runs: response.now.runs.map((run) => ({
        ...run,
        startedAt: run.startedAt?.toISOString() ?? null,
        lastAction: run.lastAction
          ? {
              ...run.lastAction,
              at: run.lastAction.at?.toISOString() ?? null,
              lastMutationId:
                run.lastAction.lastMutationId !== null
                  ? encodeRunSinceId(run.lastAction.lastMutationId)
                  : null,
            }
          : null,
        liveness: {
          ...run.liveness,
          since: run.liveness.since?.toISOString() ?? null,
        },
      })),
    },
    needsYou: {
      generatedAt: response.needsYou.generatedAt.toISOString(),
      items: response.needsYou.items.map((item) => ({
        ...item,
        requestedAt: item.requestedAt.toISOString(),
      })),
      promotable: response.needsYou.promotable.map((item) => ({
        ...item,
        inReviewSince: item.inReviewSince?.toISOString() ?? null,
      })),
    },
    agents: {
      generatedAt: response.agents.generatedAt.toISOString(),
      items: response.agents.items,
    },
  };
}

export function serializeRunActivityResponse(response: {
  items: RunActivityItem[];
  nextSinceId: RunActivityCursor;
  hasMore: boolean;
  now: ActivityRunSnapshot;
}) {
  return {
    items: response.items.map((item) => ({
      ...item,
      ts: item.ts?.toISOString() ?? null,
      lastMutationId: encodeRunSinceId(item.lastMutationId),
    })),
    nextSinceId: encodeRunActivityCursor(response.nextSinceId),
    hasMore: response.hasMore,
    now: {
      ...response.now,
      startedAt: response.now.startedAt?.toISOString() ?? null,
      lastAction: response.now.lastAction
        ? {
            ...response.now.lastAction,
            at: response.now.lastAction.at?.toISOString() ?? null,
            lastMutationId:
              response.now.lastAction.lastMutationId !== null
                ? encodeRunSinceId(response.now.lastAction.lastMutationId)
                : null,
          }
        : null,
      liveness: {
        ...response.now.liveness,
        since: response.now.liveness.since?.toISOString() ?? null,
      },
    },
  };
}
