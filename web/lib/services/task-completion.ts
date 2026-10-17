import "server-only";

import type { SocialActor } from "@/lib/social/activity";

import { and, desc, eq, sql } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { recordTaskActivity } from "@/lib/social/activity";
import { cancelClarificationsForCompletedTasks } from "@/lib/tasks/clarification-requests";
import { taskCompletionEvidence } from "@/lib/tasks/completion-evidence";

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
  const taskRows = await tx
    .select({
      id: tasks.id,
      status: tasks.status,
      revision: tasks.revision,
    })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)))
    .for("update");
  const task = taskRows[0];

  if (!task) {
    throw new MaisterError("PRECONDITION", `task not found: ${taskId}`);
  }

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
  const latest = latestRows[0];

  const evidence = taskCompletionEvidence(latest);

  if (!evidence.ok) {
    throw new MaisterError("PRECONDITION", evidence.message, {
      details: {
        reason: evidence.reason,
        ...evidence.details,
      },
    });
  }

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
        eq(tasks.id, taskId),
        eq(tasks.projectId, projectId),
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
    taskId,
    projectId,
    actor: input.actor,
    eventKind: "task_completed",
    payload: { runId: evidence.runId },
  });
  await cancelClarificationsForCompletedTasks(tx, [taskId]);

  log.info(
    {
      taskId,
      projectId,
      runId: evidence.runId,
      revision: updated.revision,
      actorType: input.actor.type,
    },
    "task completed after delivery verification",
  );

  return {
    taskId,
    status: "Done",
    revision: updated.revision,
    runId: evidence.runId,
    alreadyDone: false,
  };
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
