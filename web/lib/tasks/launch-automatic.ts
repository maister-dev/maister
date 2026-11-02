import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type {
  TaskLaunchBasis,
  TaskLaunchSettingsSnapshot,
} from "./launch-types";

import { and, eq } from "drizzle-orm";

import { loadTaskQualificationInput } from "./qualification";
import { launchRefusal } from "./launch-resolution";

import { taskQualifications, tasks } from "@/lib/db/schema";

/** Every automated root, including legacy tasks, needs this exact current positive assessment. */
export async function automaticTaskLaunchBasis(
  db: Db,
  task: typeof tasks.$inferSelect,
  settings: TaskLaunchSettingsSnapshot,
): Promise<Extract<TaskLaunchBasis, { kind: "automatic" }>> {
  const input = await loadTaskQualificationInput(db, task.projectId, task.id);

  if (input.mode === "execution_child")
    throw launchRefusal("launch_execution_parent_required", "PRECONDITION");
  if (!input.currentQualificationId)
    throw launchRefusal("qualification_required", "PRECONDITION");
  const [assessment] = await db
    .select()
    .from(taskQualifications)
    .where(
      and(
        eq(taskQualifications.id, input.currentQualificationId),
        eq(taskQualifications.taskId, task.id),
        eq(taskQualifications.projectId, task.projectId),
      ),
    );

  if (
    !assessment ||
    assessment.publicationState !== "accepted" ||
    assessment.value.decision !== "ready" ||
    assessment.revision !== input.currentQualificationRevision ||
    assessment.inputRevision !== input.inputRevision ||
    assessment.inputDigest !== input.inputDigest ||
    assessment.evidenceTarget !== input.target ||
    !assessment.evidenceSha
  )
    throw launchRefusal("qualification_stale", "PRECONDITION");
  if (
    assessment.evidenceSha !== settings.baseCommit ||
    assessment.evidenceTarget !== settings.baseBranch
  )
    throw launchRefusal("qualification_evidence_stale", "PRECONDITION");

  return {
    kind: "automatic",
    qualificationId: assessment.id,
    qualificationRevision: assessment.revision,
    qualificationInputDigest: assessment.inputDigest,
    evidenceTarget: assessment.evidenceTarget,
    evidenceSha: assessment.evidenceSha,
  };
}
