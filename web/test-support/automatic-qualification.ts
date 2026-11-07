import type { TaskAdmissionV1Snapshot } from "@/lib/tasks/qualification-types";
import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { eq } from "drizzle-orm";

import { taskQualifications, tasks } from "@/lib/db/schema";
import { seedAcceptedQualificationFixture } from "@/test-support/accepted-qualification";

/** Selector fixtures only: no repository or model assessment is claimed. Actual dispatch tests require real Git evidence. */
export async function seedAcceptedAutomaticQualification(
  database: StartedPostgresTestDb,
  projectId: string,
  taskId: string,
): Promise<void> {
  await seedAcceptedQualificationFixture(database.db, projectId, taskId, {
    target: "main",
    sha: "0123456789012345678901234567890123456789",
    identity: "automatic-selector-fixture",
    rationale:
      "Selector fixture only; no Git or model assessment was executed.",
    reference:
      "main@0123456789012345678901234567890123456789:selector-fixture-only",
  });
}

/** Only for injected selector launches/history rows; this receipt does not authorize a real dispatch. */
export async function automaticSelectorAdmissionSnapshot(
  database: StartedPostgresTestDb,
  taskId: string,
): Promise<TaskAdmissionV1Snapshot> {
  const [row] = await database.db
    .select({
      inputRevision: tasks.qualificationInputRevision,
      qualificationId: taskQualifications.id,
      qualificationRevision: taskQualifications.revision,
      evidenceTarget: taskQualifications.evidenceTarget,
      evidenceSha: taskQualifications.evidenceSha,
    })
    .from(tasks)
    .innerJoin(
      taskQualifications,
      eq(taskQualifications.id, tasks.currentQualificationId),
    )
    .where(eq(tasks.id, taskId));

  if (!row)
    throw new Error("Selector run requires its seeded current assessment");

  return {
    version: 1,
    policyVersion: 1,
    mode: "required",
    ...row,
    parent: null,
  };
}
