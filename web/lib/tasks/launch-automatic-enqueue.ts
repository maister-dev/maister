import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { TaskLaunchReceipt } from "./launch-types";

import { and, eq, inArray } from "drizzle-orm";

import { acceptAutomaticTaskLaunch } from "./launch-intent";
import { taskLaunchSettingsToken } from "./launch-resolution";
import { taskLaunchReceipt } from "./launch-receipt";
import { lockTaskLaunchReservation } from "./launch-locks";
import { requireTaskRequalification } from "./qualification";

import { tasks, taskLaunchIntents, taskQualifications } from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";

/** Persists automatic intent after qualification commits; capacity is acquired by the common scheduler. */
export async function enqueueQualifiedAutomaticTaskLaunch(
  db: Db,
  taskId: string,
): Promise<TaskLaunchReceipt | null> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));

  if (
    !task ||
    task.qualificationMode !== "required" ||
    !task.currentQualificationId ||
    task.launchMode !== "auto" ||
    task.triageStatus !== "triaged" ||
    (task.launchIntent !== null && task.launchIntent !== "triage_then_launch")
  )
    return null;
  const [qualification] = await db
    .select()
    .from(taskQualifications)
    .where(
      and(
        eq(taskQualifications.id, task.currentQualificationId),
        eq(taskQualifications.taskId, task.id),
      ),
    );

  if (
    !qualification ||
    qualification.publicationState !== "accepted" ||
    qualification.value.decision !== "ready"
  )
    return null;
  const [existing] = await db
    .select()
    .from(taskLaunchIntents)
    .where(
      and(
        eq(taskLaunchIntents.taskId, task.id),
        inArray(taskLaunchIntents.state, [
          "queued",
          "preparing",
          "run_bound",
          "held",
        ]),
      ),
    );

  if (existing) return taskLaunchReceipt(existing);

  try {
    return await acceptAutomaticTaskLaunch(
      db,
      {
        taskId: task.id,
        expectedTaskRevision: task.revision,
        expectedSettingsToken: await taskLaunchSettingsToken(db, task.id),
      },
      `qualification:${qualification.id}:attempt:${task.attemptNumber}`,
    );
  } catch (error) {
    if (
      isMaisterError(error) &&
      error.details?.reason === "qualification_evidence_stale"
    ) {
      await db.transaction(async (tx) => {
        await lockTaskLaunchReservation(tx, task.id);
        const [current] = await tx
          .select()
          .from(tasks)
          .where(eq(tasks.id, task.id))
          .for("update");

        if (
          current?.currentQualificationId === qualification.id &&
          current.qualificationInputRevision === qualification.inputRevision
        )
          await requireTaskRequalification(tx, task.projectId, task.id);
      });
    }
    throw error;
  }
}
