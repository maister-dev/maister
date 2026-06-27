import "server-only";

import type { ActorDTO } from "@/lib/social/actors";
import type { ExecutionPolicy } from "@/lib/runs/execution-policy";

import { and, desc, eq, ne } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import {
  activeSessionCapabilityAgent,
  activeSessionRunnerId,
  activeSessionRunnerSnapshot,
} from "@/lib/runs/active-run-session";
import { reconcileManyRunCostRollups } from "@/lib/runs/cost-rollups";
import { actorDTO, resolveActorLabels } from "@/lib/social/actors";
import {
  getOpenRelationBlockers,
  getTaskRelations,
  type TaskRelationView,
} from "@/lib/social/relations";
import { resolveProjectTaskByNumber } from "@/lib/social/task-lookup";

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/services/tasks.ts).
const {
  flows,
  runCostRollups,
  runs,
  taskActivity,
  taskComments,
  taskSubscribers,
  workspaces,
} = schemaModule as unknown as Record<string, any>;

export type TimelineItem =
  | {
      kind: "comment";
      id: string;
      body: string;
      actor: ActorDTO;
      createdAt: Date;
    }
  | {
      kind: "activity";
      id: string;
      eventKind: string;
      payload: Record<string, unknown>;
      actor: ActorDTO;
      createdAt: Date;
    };

// Merge comments and activity ascending by (createdAt, id). `comment_added`
// activity rows are SKIPPED — the comment itself renders in their place; the
// duplicate row exists for the Log page and analytics, not the timeline.
export function interleaveTimeline(
  comments: Array<{
    id: string;
    body: string;
    actor: ActorDTO;
    createdAt: Date;
  }>,
  activity: Array<{
    id: string;
    eventKind: string;
    payload: Record<string, unknown>;
    actor: ActorDTO;
    createdAt: Date;
  }>,
): TimelineItem[] {
  const items: TimelineItem[] = [
    ...comments.map((c) => ({ kind: "comment" as const, ...c })),
    ...activity
      .filter((a) => a.eventKind !== "comment_added")
      .map((a) => ({ kind: "activity" as const, ...a })),
  ];

  return items.sort((a, b) => {
    const delta = a.createdAt.getTime() - b.createdAt.getTime();

    return delta !== 0 ? delta : a.id.localeCompare(b.id);
  });
}

export type TaskRunRow = {
  id: string;
  status: string;
  flowRef: string | null;
  flowVersion: string | null;
  runnerModel: string | null;
  deliveryStatus: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  durationMs: number | null;
  tokenTotal: number;
};

export type TaskRunTotals = {
  runCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  tokenTotal: number;
};

export type TaskRelationCandidate = {
  taskId: string;
  key: string;
  number: number;
  title: string;
  prompt: string;
  status: string;
};

export type TaskDetailData = {
  project: { id: string; slug: string; name: string; taskKey: string };
  task: {
    id: string;
    number: number;
    title: string;
    prompt: string;
    flowId: string | null;
    runnerId: string | null;
    baseBranch: string | null;
    targetBranch: string | null;
    promotionMode: "local_merge" | "pull_request" | null;
    executionPolicy: ExecutionPolicy | null;
    status: string;
    // M34: the triager's verdict mark (nullable 'triaged').
    triageStatus: "triaged" | "flagged" | null;
  };
  keyRef: string;
  relations: TaskRelationView[];
  relationCandidates: TaskRelationCandidate[];
  openBlockers: Array<{ key: string; number: number }>;
  timeline: TimelineItem[];
  isFollowing: boolean;
  runs: TaskRunRow[];
  totals: TaskRunTotals;
  latestFlowRun: {
    id: string;
    status: string;
    currentStepId: string | null;
  } | null;
};

function tokenTotal(row: {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
}): number {
  return (
    (row.inputTokens ?? 0) +
    (row.outputTokens ?? 0) +
    (row.cacheReadTokens ?? 0) +
    (row.cacheCreationTokens ?? 0)
  );
}

function durationMs(row: {
  startedAt: Date | null;
  endedAt: Date | null;
}): number | null {
  if (!row.startedAt || !row.endedAt) return null;

  return Math.max(0, row.endedAt.getTime() - row.startedAt.getTime());
}

function runnerModelLabel(row: {
  runnerId: string | null;
  capabilityAgent: string | null;
  runnerSnapshot: unknown | null;
}): string | null {
  const snapshot =
    row.runnerSnapshot !== null &&
    typeof row.runnerSnapshot === "object" &&
    !Array.isArray(row.runnerSnapshot)
      ? (row.runnerSnapshot as Record<string, unknown>)
      : {};
  const model = typeof snapshot.model === "string" ? snapshot.model : null;
  const runner = row.runnerId ?? row.capabilityAgent;

  if (runner && model) return `${runner} · ${model}`;
  if (runner) return runner;

  return model;
}

function deliveryStatusLabel(row: {
  promotionMode: string | null;
  prUrl: string | null;
  prNumber: number | null;
  deliveryPolicySnapshot: unknown | null;
}): string | null {
  const snapshot =
    row.deliveryPolicySnapshot !== null &&
    typeof row.deliveryPolicySnapshot === "object" &&
    !Array.isArray(row.deliveryPolicySnapshot)
      ? (row.deliveryPolicySnapshot as Record<string, unknown>)
      : null;
  const strategy =
    typeof snapshot?.strategy === "string"
      ? snapshot.strategy
      : row.promotionMode;

  if (row.prNumber !== null) return `PR #${row.prNumber}`;
  if (row.prUrl) return "pull_request";

  return strategy;
}

export async function getTaskDetail(
  slug: string,
  number: number,
  userId: string,
): Promise<TaskDetailData | null> {
  const db = getDb() as unknown as { select: any };
  const resolved = await resolveProjectTaskByNumber(slug, number);

  if (!resolved) return null;

  const taskId = resolved.task.id;

  const [projectRow] = (await db
    .select({ name: schemaModule.projects.name })
    .from(schemaModule.projects)
    .where(eq(schemaModule.projects.id, resolved.project.id))) as Array<{
    name: string;
  }>;

  const commentRows = (await db
    .select()
    .from(taskComments)
    .where(eq(taskComments.taskId, taskId))
    .orderBy(taskComments.createdAt, taskComments.id)) as Array<{
    id: string;
    body: string;
    actorType: string;
    actorId: string | null;
    createdAt: Date;
  }>;
  const activityRows = (await db
    .select()
    .from(taskActivity)
    .where(eq(taskActivity.taskId, taskId))
    .orderBy(taskActivity.createdAt, taskActivity.id)) as Array<{
    id: string;
    eventKind: string;
    payload: Record<string, unknown>;
    actorType: string;
    actorId: string | null;
    createdAt: Date;
  }>;

  const labels = await resolveActorLabels([...commentRows, ...activityRows]);

  const timeline = interleaveTimeline(
    commentRows.map((c) => ({
      id: c.id,
      body: c.body,
      actor: actorDTO(c, labels),
      createdAt: c.createdAt,
    })),
    activityRows.map((a) => ({
      id: a.id,
      eventKind: a.eventKind,
      payload: a.payload,
      actor: actorDTO(a, labels),
      createdAt: a.createdAt,
    })),
  );

  const relations = await getTaskRelations(taskId);
  const relationCandidates = await relationCandidatesOf(
    db,
    resolved.project.id,
    taskId,
    resolved.project.taskKey,
  );
  const openBlockers =
    (await getOpenRelationBlockers([taskId], db)).get(taskId) ?? [];

  const following = (await db
    .select({ id: taskSubscribers.id })
    .from(taskSubscribers)
    .where(
      and(
        eq(taskSubscribers.taskId, taskId),
        eq(taskSubscribers.subscriberType, "user"),
        eq(taskSubscribers.subscriberId, userId),
      ),
    )) as Array<{ id: string }>;

  const taskRunIdRows = (await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.taskId, taskId), eq(runs.runKind, "flow")))) as Array<{
    id: string;
  }>;

  await reconcileManyRunCostRollups(taskRunIdRows.map((run) => run.id));

  const runRows = (await db
    .select({
      id: runs.id,
      status: runs.status,
      flowRef: flows.flowRefId,
      flowVersion: runs.flowVersion,
      runnerId: activeSessionRunnerId(runs.id),
      capabilityAgent: activeSessionCapabilityAgent(runs.id),
      runnerSnapshot: activeSessionRunnerSnapshot(runs.id),
      promotionMode: workspaces.promotionMode,
      prUrl: workspaces.prUrl,
      prNumber: workspaces.prNumber,
      deliveryPolicySnapshot: runs.deliveryPolicySnapshot,
      startedAt: runs.startedAt,
      endedAt: runs.endedAt,
      currentStepId: runs.currentStepId,
      inputTokens: runCostRollups.inputTokens,
      outputTokens: runCostRollups.outputTokens,
      cacheReadTokens: runCostRollups.cacheReadTokens,
      cacheCreationTokens: runCostRollups.cacheCreationTokens,
    })
    .from(runs)
    .leftJoin(flows, eq(flows.id, runs.flowId))
    .leftJoin(workspaces, eq(workspaces.runId, runs.id))
    .leftJoin(runCostRollups, eq(runCostRollups.runId, runs.id))
    .where(and(eq(runs.taskId, taskId), eq(runs.runKind, "flow")))
    .orderBy(desc(runs.startedAt))) as Array<{
    id: string;
    status: string;
    flowRef: string | null;
    flowVersion: string | null;
    runnerId: string | null;
    capabilityAgent: string | null;
    runnerSnapshot: unknown | null;
    promotionMode: string | null;
    prUrl: string | null;
    prNumber: number | null;
    deliveryPolicySnapshot: unknown | null;
    startedAt: Date | null;
    endedAt: Date | null;
    currentStepId: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheCreationTokens: number | null;
  }>;

  const latest = runRows[0] ?? null;
  const totals = runRows.reduce<TaskRunTotals>(
    (acc, row) => {
      const inputTokens = row.inputTokens ?? 0;
      const outputTokens = row.outputTokens ?? 0;
      const cacheReadTokens = row.cacheReadTokens ?? 0;
      const cacheCreationTokens = row.cacheCreationTokens ?? 0;

      return {
        runCount: acc.runCount + 1,
        inputTokens: acc.inputTokens + inputTokens,
        outputTokens: acc.outputTokens + outputTokens,
        cacheReadTokens: acc.cacheReadTokens + cacheReadTokens,
        cacheCreationTokens: acc.cacheCreationTokens + cacheCreationTokens,
        tokenTotal:
          acc.tokenTotal +
          inputTokens +
          outputTokens +
          cacheReadTokens +
          cacheCreationTokens,
      };
    },
    {
      runCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      tokenTotal: 0,
    },
  );

  return {
    project: {
      id: resolved.project.id,
      slug: resolved.project.slug,
      name: projectRow?.name ?? resolved.project.slug,
      taskKey: resolved.project.taskKey,
    },
    task: {
      id: taskId,
      number: resolved.task.number,
      title: resolved.task.title,
      ...(await taskExtrasOf(db, taskId)),
      status: resolved.task.status,
    },
    keyRef: `${resolved.project.taskKey}-${resolved.task.number}`,
    relations,
    relationCandidates,
    openBlockers,
    timeline,
    isFollowing: following.length > 0,
    totals,
    runs: runRows.map(({ currentStepId: _omit, ...row }) => ({
      id: row.id,
      status: row.status,
      flowRef: row.flowRef,
      flowVersion: row.flowVersion,
      runnerModel: runnerModelLabel(row),
      deliveryStatus: deliveryStatusLabel(row),
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      durationMs: durationMs(row),
      tokenTotal: tokenTotal(row),
    })),
    latestFlowRun: latest
      ? {
          id: latest.id,
          status: latest.status,
          currentStepId: latest.currentStepId,
        }
      : null,
  };
}

async function relationCandidatesOf(
  db: { select: any },
  projectId: string,
  currentTaskId: string,
  taskKey: string,
): Promise<TaskRelationCandidate[]> {
  const rows = (await db
    .select({
      taskId: schemaModule.tasks.id,
      number: schemaModule.tasks.number,
      title: schemaModule.tasks.title,
      prompt: schemaModule.tasks.prompt,
      status: schemaModule.tasks.status,
      createdAt: schemaModule.tasks.createdAt,
    })
    .from(schemaModule.tasks)
    .where(
      and(
        eq(schemaModule.tasks.projectId, projectId),
        ne(schemaModule.tasks.id, currentTaskId),
      ),
    )
    .orderBy(desc(schemaModule.tasks.createdAt))) as Array<{
    taskId: string;
    number: number;
    title: string;
    prompt: string;
    status: string;
  }>;

  return rows.map((row) => ({
    taskId: row.taskId,
    key: taskKey,
    number: row.number,
    title: row.title,
    prompt: row.prompt,
    status: row.status,
  }));
}

async function taskExtrasOf(
  db: { select: any },
  taskId: string,
): Promise<{
  prompt: string;
  flowId: string | null;
  runnerId: string | null;
  baseBranch: string | null;
  targetBranch: string | null;
  promotionMode: "local_merge" | "pull_request" | null;
  executionPolicy: ExecutionPolicy | null;
  triageStatus: "triaged" | "flagged" | null;
}> {
  const rows = (await db
    .select({
      prompt: schemaModule.tasks.prompt,
      flowId: schemaModule.tasks.flowId,
      runnerId: schemaModule.tasks.runnerId,
      baseBranch: schemaModule.tasks.baseBranch,
      targetBranch: schemaModule.tasks.targetBranch,
      promotionMode: schemaModule.tasks.promotionMode,
      executionPolicy: schemaModule.tasks.executionPolicy,
      triageStatus: schemaModule.tasks.triageStatus,
    })
    .from(schemaModule.tasks)
    .where(eq(schemaModule.tasks.id, taskId))) as Array<{
    prompt: string;
    flowId: string | null;
    runnerId: string | null;
    baseBranch: string | null;
    targetBranch: string | null;
    promotionMode: "local_merge" | "pull_request" | null;
    executionPolicy: ExecutionPolicy | null;
    triageStatus: "triaged" | "flagged" | null;
  }>;

  return {
    prompt: rows[0]?.prompt ?? "",
    flowId: rows[0]?.flowId ?? null,
    runnerId: rows[0]?.runnerId ?? null,
    baseBranch: rows[0]?.baseBranch ?? null,
    targetBranch: rows[0]?.targetBranch ?? null,
    promotionMode: rows[0]?.promotionMode ?? null,
    executionPolicy: rows[0]?.executionPolicy ?? null,
    triageStatus: rows[0]?.triageStatus ?? null,
  };
}
