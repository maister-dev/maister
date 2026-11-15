import "server-only";

import type { SocialActor } from "@/lib/social/activity";

import { and, desc, eq, sql } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  insertTaskActivityOnce,
  recordTaskActivity,
} from "@/lib/social/activity";
import { fanoutToSubscribers } from "@/lib/social/inbox";
import { cancelClarificationsForCompletedTasks } from "@/lib/tasks/clarification-requests";
import {
  evaluateMergeCompletion,
  taskCompletionEvidence,
  type MergeCompletionDecision,
  type TaskCompletionRunEvidence,
} from "@/lib/tasks/completion-evidence";

// FIXME(any): dual drizzle-orm peer-dep variants (matches services/tasks.ts).
const { runs, tasks, workspaces } = schemaModule as unknown as Record<
  string,
  any
>;

// FIXME(any): narrow after the repository converges on one drizzle peer.
type Db = any;

const log = pino({
  name: "service-task-completion",
  level: process.env.LOG_LEVEL ?? "info",
});

export type CompleteTaskInput = {
  expectedRevision?: number;
  actor: SocialActor;
};

export type CompleteTaskResult = {
  taskId: string;
  status: "Done";
  revision: number;
  runId: string | null;
  alreadyDone: boolean;
};

async function lockTask(
  tx: Db,
  taskId: string,
  projectId?: string,
): Promise<{
  id: string;
  projectId: string;
  status: string;
  revision: number;
}> {
  const taskRows = await tx
    .select({
      id: tasks.id,
      projectId: tasks.projectId,
      status: tasks.status,
      revision: tasks.revision,
    })
    .from(tasks)
    .where(
      projectId
        ? and(eq(tasks.id, taskId), eq(tasks.projectId, projectId))
        : eq(tasks.id, taskId),
    )
    .for("update");
  const task = taskRows[0];

  if (!task) {
    throw new MaisterError("PRECONDITION", `task not found: ${taskId}`);
  }

  return task;
}

// Read only AFTER the task lock: a concurrent launch either committed first
// (and is the newest Run here) or is parked behind the lock.
async function loadNewestFlowRun(
  tx: Db,
  taskId: string,
  projectId: string,
): Promise<TaskCompletionRunEvidence | undefined> {
  const latestRows = await tx
    .select({
      id: runs.id,
      status: runs.status,
      deliveryPolicySnapshot: runs.deliveryPolicySnapshot,
      promotionMode: workspaces.promotionMode,
      promotionState: workspaces.promotionState,
      prState: workspaces.prState,
    })
    .from(runs)
    .leftJoin(workspaces, eq(workspaces.runId, runs.id))
    .where(
      and(
        eq(runs.taskId, taskId),
        eq(runs.projectId, projectId),
        eq(runs.runKind, "flow"),
      ),
    )
    .orderBy(desc(runs.startedAt), desc(runs.id))
    .limit(1);

  return latestRows[0];
}

async function markTaskDone(
  tx: Db,
  task: { id: string; projectId: string; status: string },
  actor: SocialActor,
  payload: Record<string, unknown>,
): Promise<number> {
  const [updated] = await tx
    .update(tasks)
    .set({
      status: "Done",
      revision: sql`${tasks.revision} + 1`,
      queuePaused: false,
      queueClaimedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(tasks.id, task.id),
        eq(tasks.projectId, task.projectId),
        eq(tasks.status, task.status),
      ),
    )
    .returning({ revision: tasks.revision });

  if (!updated) {
    throw new MaisterError(
      "CONFLICT",
      "task changed while it was being completed",
    );
  }

  await recordTaskActivity(tx, {
    taskId: task.id,
    projectId: task.projectId,
    actor,
    eventKind: "task_completed",
    payload,
  });
  await cancelClarificationsForCompletedTasks(tx, [task.id]);

  return updated.revision;
}

/**
 * Complete a task only after its newest flow run has terminal delivery evidence.
 *
 * A run reaching Done is not sufficient: result-only runs have no promoted
 * changes, while pull-request delivery is not complete until the provider has
 * observed the PR as merged. The task row is locked before evidence is read so
 * a concurrent launch either lands first (and becomes the newest run) or hits
 * the terminal-state fence in launchRunStaged.
 */
export async function completeTaskInTransaction(
  taskId: string,
  projectId: string,
  input: CompleteTaskInput,
  tx: Db,
): Promise<CompleteTaskResult> {
  const task = await lockTask(tx, taskId, projectId);

  // Idempotent retries succeed even when they carry the pre-completion
  // revision. This matters for chat/API clients retrying after a lost response.
  if (task.status === "Done") {
    return {
      taskId,
      status: "Done",
      revision: task.revision,
      runId: null,
      alreadyDone: true,
    };
  }

  if (task.status === "Abandoned") {
    throw new MaisterError(
      "PRECONDITION",
      "an abandoned task cannot be completed",
    );
  }

  if (
    input.expectedRevision !== undefined &&
    input.expectedRevision !== task.revision
  ) {
    throw new MaisterError(
      "CONFLICT",
      "task has changed; reload before completing",
      {
        details: {
          reason: "stale_revision",
          actualRevision: task.revision,
        },
      },
    );
  }

  const evidence = taskCompletionEvidence(
    await loadNewestFlowRun(tx, taskId, projectId),
  );

  if (!evidence.ok) {
    throw new MaisterError("PRECONDITION", evidence.message, {
      details: {
        reason: evidence.reason,
        ...evidence.details,
      },
    });
  }

  const revision = await markTaskDone(tx, task, input.actor, {
    runId: evidence.runId,
  });

  log.info(
    {
      taskId,
      projectId,
      runId: evidence.runId,
      revision,
      actorType: input.actor.type,
    },
    "task completed after delivery verification",
  );

  return {
    taskId,
    status: "Done",
    revision,
    runId: evidence.runId,
    alreadyDone: false,
  };
}

/**
 * ADR-207: platform-owned completion from a confirmed PR merge (`run.pr_merged`
 * or the finalize's `run.done`). Never throws for an ineligible task: a skip
 * writes nothing, a refusal writes one deduplicated activity (and inbox items),
 * so one ineligible task can never stall the dispatcher.
 */
export async function completeTaskFromConfirmedMerge(
  taskId: string,
  runId: string,
  tx: Db,
): Promise<MergeCompletionDecision> {
  const task = await lockTask(tx, taskId);
  const [mergedRun] = await tx
    .select({
      id: runs.id,
      runKind: runs.runKind,
      prState: workspaces.prState,
      prNumber: workspaces.prNumber,
    })
    .from(runs)
    .leftJoin(workspaces, eq(workspaces.runId, runs.id))
    .where(and(eq(runs.id, runId), eq(runs.taskId, taskId)));
  const decision = evaluateMergeCompletion({
    taskStatus: task.status,
    mergedRun: mergedRun ?? null,
    newest: (await loadNewestFlowRun(tx, taskId, task.projectId)) ?? null,
  });
  const system: SocialActor = { type: "system", id: null };

  if (decision.kind === "apply") {
    const revision = await markTaskDone(tx, task, system, {
      runId,
      cause: "pr_merged",
      prNumber: mergedRun?.prNumber ?? null,
    });

    log.info(
      { taskId, runId, revision },
      "[taskCompletion] completed after confirmed merge",
    );
  } else if (decision.kind === "refuse") {
    const activityId = await insertTaskActivityOnce(tx, {
      taskId,
      projectId: task.projectId,
      actor: system,
      eventKind: "delivery_completion_not_applied",
      payload: { runId, reason: decision.reason },
    });

    if (activityId) {
      await fanoutToSubscribers(tx, {
        taskId,
        projectId: task.projectId,
        eventKind: "delivery_completion_not_applied",
        sourceRef: { kind: "delivery_refusal", taskId, runId, activityId },
        excludeActor: system,
      });
    }
    log.warn(
      { taskId, runId, reason: decision.reason },
      "[taskCompletion] automatic completion refused",
    );
  } else {
    log.debug(
      { taskId, runId, reason: decision.reason },
      "[taskCompletion] skipped",
    );
  }

  return decision;
}

export async function completeTask(
  taskId: string,
  projectId: string,
  input: CompleteTaskInput,
  db?: Db,
): Promise<CompleteTaskResult> {
  const database = db ?? getDb();

  return database.transaction((tx: Db) =>
    completeTaskInTransaction(taskId, projectId, input, tx),
  );
}
