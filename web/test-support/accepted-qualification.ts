import type { Db } from "@/lib/execution-host/db";

import { createHash, randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";

import { taskQualifications, tasks } from "@/lib/db/schema";
import { loadTaskQualificationInput } from "@/lib/tasks/qualification";
import { qualificationFixture } from "@/test-support/task-qualification";

/** Test data publication uses the real revision and pointer guards; it grants no runtime caller authority. */
export async function seedAcceptedQualificationFixture(
  db: Db,
  projectId: string,
  taskId: string,
  evidence: Readonly<{
    sha: string;
    target: string;
    identity: string;
    rationale: string;
    reference: string;
  }>,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .for("update");

    if (
      !before ||
      before.projectId !== projectId ||
      before.qualificationMode === "execution_child"
    )
      throw new Error(
        "Qualification fixture requires its ordinary project task",
      );
    await tx
      .update(tasks)
      .set({
        qualificationMode: "required",
        triageStatus: null,
        triageFlagOrigin: null,
        launchMode: null,
        launchArmedAt: null,
      })
      .where(eq(tasks.id, taskId));
    const input = await loadTaskQualificationInput(tx, projectId, taskId);

    if (input.target !== evidence.target)
      throw new Error("Qualification fixture evidence target changed");
    const [allocation] = await tx
      .update(tasks)
      .set({
        qualificationRevisionCounter: sql`${tasks.qualificationRevisionCounter}+1`,
      })
      .where(eq(tasks.id, taskId))
      .returning({ revision: tasks.qualificationRevisionCounter });
    const id = randomUUID();
    const fixture = qualificationFixture();
    const value = {
      ...fixture,
      checks: fixture.checks.map((check) => ({
        ...check,
        rationale: evidence.rationale,
      })),
      evidenceRefs: [
        {
          id: "repo",
          kind: "repository" as const,
          reference: evidence.reference,
        },
      ],
    };

    await tx.insert(taskQualifications).values({
      id,
      projectId,
      taskId,
      revision: allocation.revision,
      inputRevision: input.inputRevision,
      inputDigest: input.inputDigest,
      requestKey: randomUUID(),
      payloadDigest: createHash("sha256")
        .update(JSON.stringify(value))
        .digest("hex"),
      authorKind: "project_token",
      authorIdentity: evidence.identity,
      evidenceTarget: evidence.target,
      evidenceSha: evidence.sha,
      value,
      routing: {
        flowId: null,
        runnerId: null,
        baseBranch: null,
        enqueue: false,
      },
      publicationState: "accepted",
      publishedAt: new Date(),
    });
    await tx
      .update(tasks)
      .set({
        currentQualificationId: id,
        currentQualificationRevision: allocation.revision,
        triageStatus: before.triageStatus,
        triageFlagOrigin: before.triageFlagOrigin,
        launchMode: before.launchMode,
        launchArmedAt: before.launchArmedAt,
      })
      .where(eq(tasks.id, taskId));
  });
}
