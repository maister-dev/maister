import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import pino from "pino";

import { lockTaskLaunchReservation } from "./launch-locks";
import { loadTaskSemanticInput } from "./launch-input";
import { taskLaunchSelectedConfiguration } from "./launch-resolution";
import { emitTaskLaunchChanged } from "./launch-events";

import { runs, taskLaunchIntents, projects } from "@/lib/db/schema";
import { retryDigest } from "@/lib/agents/retry-guards";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "task-launch-edit",
  level: process.env.LOG_LEVEL ?? "info",
});

export type LockedTaskLaunches = Readonly<{
  intents: ReadonlyArray<typeof taskLaunchIntents.$inferSelect>;
  queuedEditable: boolean;
}>;

/** Acquire before the task row. Same-task acceptance and dispatch take the same reservation lock. */
export async function lockTaskLaunchesForEdit(
  db: Db,
  projectId: string,
  taskId: string,
): Promise<LockedTaskLaunches> {
  await lockTaskLaunchReservation(db, taskId);
  const scope = and(
    eq(taskLaunchIntents.projectId, projectId),
    eq(taskLaunchIntents.taskId, taskId),
    inArray(taskLaunchIntents.state, [
      "queued",
      "preparing",
      "run_bound",
      "held",
    ]),
  );
  const candidates = await db
    .select({ runId: taskLaunchIntents.runId })
    .from(taskLaunchIntents)
    .where(scope);
  const runIds = candidates.flatMap((row) => (row.runId ? [row.runId] : []));
  const boundRuns = runIds.length
    ? await db
        .select()
        .from(runs)
        .where(inArray(runs.id, runIds))
        .orderBy(asc(runs.id))
        .for("update")
    : [];
  const intents = await db
    .select()
    .from(taskLaunchIntents)
    .where(scope)
    .orderBy(asc(taskLaunchIntents.id))
    .for("update");

  return {
    intents,
    queuedEditable: intents.some(
      (intent) =>
        intent.dispatchCommittedAt === null &&
        (intent.runId === null ||
          boundRuns.some(
            (run) => run.id === intent.runId && run.status === "Pending",
          )),
    ),
  };
}

/** Caller owns reservation/run/intent/task locks. Historical and dispatched requests remain frozen. */
export async function holdChangedTaskLaunches(
  db: Db,
  projectId: string,
  taskId: string,
  locked: LockedTaskLaunches,
): Promise<void> {
  if (
    !locked.intents.some(
      (intent) => !intent.dispatchCommittedAt && intent.state !== "held",
    )
  )
    return;
  const { task, snapshot } = await loadTaskSemanticInput(db, projectId, taskId);
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId));

  if (!project)
    throw new MaisterError("PRECONDITION", "Launch project is missing", {
      details: { reason: "launch_task_missing" },
    });
  const settingsDigest = retryDigest(taskLaunchSelectedConfiguration(task));

  for (const intent of locked.intents) {
    if (intent.dispatchCommittedAt || intent.state === "held") continue;
    const inputDigest = retryDigest({
      ...snapshot,
      target: intent.inputSnapshot.target,
      deliveryTarget: intent.inputSnapshot.deliveryTarget,
    });
    const reason = task.queuePaused
      ? "queue_paused"
      : intent.inputDigest !== inputDigest
        ? "launch_input_changed"
        : intent.settingsSnapshot.taskSettingsDigest !== settingsDigest
          ? "launch_settings_changed"
          : null;

    if (!reason) continue;
    const [held] = await db
      .update(taskLaunchIntents)
      .set({
        state: "held",
        reason,
        stateVersion: intent.stateVersion + 1,
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(taskLaunchIntents.id, intent.id),
          eq(taskLaunchIntents.stateVersion, intent.stateVersion),
          isNull(taskLaunchIntents.dispatchCommittedAt),
        ),
      )
      .returning();

    if (!held)
      throw new MaisterError("CONFLICT", "Launch changed during task editing", {
        details: { reason: "launch_state_changed" },
      });
    await emitTaskLaunchChanged(db, held, { type: "system", id: null });
    log.info(
      { intentId: held.id, taskId, reason, stateVersion: held.stateVersion },
      "task-launch-held-on-edit",
    );
  }
}
