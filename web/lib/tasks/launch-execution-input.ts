import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { Run } from "@/lib/db/schema";
import type { TaskLaunchInputV2Snapshot } from "./launch-types";
import type { TaskClarificationContext } from "./clarifications";

import { and, eq } from "drizzle-orm";

import { taskLaunchEffectivePrompt } from "./launch-input";
import { launchRefusal } from "./launch-resolution";

import { taskLaunchIntents, runs } from "@/lib/db/schema";
import { retryDigest } from "@/lib/agents/retry-guards";
import { getTaskClarificationProjection } from "@/lib/queries/task-clarifications";

type ExecutionInputRun = Pick<
  Run,
  "id" | "taskId" | "projectId" | "taskLaunchIntentId"
>;

/** A v2 execution never reconstructs missing accepted input from today's task. */
export async function taskLaunchInputForRun(
  db: Db,
  run: ExecutionInputRun,
): Promise<TaskLaunchInputV2Snapshot | null> {
  if (!run.projectId) {
    if (run.taskLaunchIntentId)
      throw launchRefusal("launch_input_snapshot_incomplete", "PRECONDITION");

    return null;
  }
  if (!run.taskLaunchIntentId) {
    const [stored] = await db
      .select()
      .from(runs)
      .where(and(eq(runs.id, run.id), eq(runs.projectId, run.projectId)));
    const child = stored?.taskAdmissionSnapshot;

    if (child?.version === 1 && child.carrier) {
      const witness = child.carrier;

      if (
        witness.inputSnapshot.version !== 2 ||
        witness.inputSnapshot.projectId !== run.projectId ||
        witness.inputSnapshot.taskId !== run.taskId ||
        retryDigest(witness.inputSnapshot) !== witness.inputDigest
      )
        throw launchRefusal("launch_input_snapshot_incomplete", "PRECONDITION");

      return witness.inputSnapshot;
    }
    if (child?.version !== 3) return null;
    if (
      stored.taskId !== run.taskId ||
      child.parent.parentTaskId !== run.taskId ||
      stored.parentRunId !== child.parent.parentRunId
    )
      throw launchRefusal("launch_input_snapshot_incomplete", "PRECONDITION");
    const [parent] = await db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.id, child.parent.parentRunId),
          eq(runs.projectId, run.projectId),
        ),
      );

    if (
      !parent ||
      parent.id === run.id ||
      parent.taskAdmissionSnapshot?.version === 3
    )
      throw launchRefusal("launch_input_snapshot_incomplete", "PRECONDITION");
    const inherited = await taskLaunchInputForRun(db, parent);

    if (!inherited)
      throw launchRefusal("launch_input_snapshot_incomplete", "PRECONDITION");

    return inherited;
  }
  const [intent] = await db
    .select()
    .from(taskLaunchIntents)
    .where(
      and(
        eq(taskLaunchIntents.id, run.taskLaunchIntentId),
        eq(taskLaunchIntents.originalRunId, run.id),
      ),
    );

  if (
    !intent ||
    intent.taskId !== run.taskId ||
    intent.projectId !== run.projectId ||
    intent.inputSnapshot.version !== 2 ||
    retryDigest(intent.inputSnapshot) !== intent.inputDigest
  )
    throw launchRefusal("launch_input_snapshot_incomplete", "PRECONDITION");

  return intent.inputSnapshot;
}

export async function taskLaunchClarificationsForRun(
  db: Db,
  run: ExecutionInputRun & { taskId: string },
  legacyPrompt: string,
): Promise<{
  effectivePrompt: string;
  clarifications: TaskClarificationContext[];
}> {
  const snapshot = await taskLaunchInputForRun(db, run);

  if (!snapshot)
    return getTaskClarificationProjection(db, run.taskId, legacyPrompt);

  return {
    effectivePrompt: taskLaunchEffectivePrompt(snapshot),
    clarifications: snapshot.clarifications.map(
      ({ id, seq, question, answer }) => ({ id, seq, question, answer }),
    ),
  };
}
