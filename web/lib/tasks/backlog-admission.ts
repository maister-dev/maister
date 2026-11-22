import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { assertTaskLaunchUserAuthority } from "./launch-authority";
import {
  incomingWorkPredicate,
  manualBacklogAdmissionPredicate,
} from "./qualification-predicates";

import { tasks } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { recordTaskActivityOnce } from "@/lib/social/activity";

export const backlogAdmissionRequest = z
  .object({
    expectedInputRevision: z.int().positive(),
    expectedQualificationRevision: z.int().positive().nullable(),
  })
  .strict();

export async function admitTaskToBacklog(
  db: Db,
  access: { projectId: string; taskId: string; userId: string },
  request: z.infer<typeof backlogAdmissionRequest>,
): Promise<void> {
  await db.transaction(async (tx) => {
    await assertTaskLaunchUserAuthority(tx, access.projectId, access.userId, [
      "editTask",
    ]);
    const {
      rows: [task],
    } = await tx.execute<{
      inputRevision: number;
      qualificationRevision: number | null;
      incoming: boolean;
      admitted: boolean;
    }>(sql`SELECT ${tasks.qualificationInputRevision} AS "inputRevision",
            ${tasks.currentQualificationRevision} AS "qualificationRevision",
            ${incomingWorkPredicate()} AS incoming,
            ${manualBacklogAdmissionPredicate()} AS admitted
       FROM ${tasks} WHERE ${tasks.id}=${access.taskId} AND ${tasks.projectId}=${access.projectId}
       FOR UPDATE OF tasks`);

    if (!task)
      throw new MaisterError(
        "PRECONDITION",
        "Task is unavailable in this project",
        {
          details: { reason: "qualification_not_found" },
        },
      );
    if (
      task.inputRevision !== request.expectedInputRevision ||
      task.qualificationRevision !== request.expectedQualificationRevision ||
      (!task.incoming && !task.admitted)
    )
      throw new MaisterError(
        "CONFLICT",
        "Refresh the task before admitting it to the backlog",
        {
          details: { reason: "backlog_admission_changed" },
        },
      );
    await recordTaskActivityOnce(tx, {
      projectId: access.projectId,
      taskId: access.taskId,
      actor: { type: "user", id: access.userId },
      eventKind: "backlog_admitted",
      payload: {
        inputRevision: task.inputRevision,
        qualificationRevision: task.qualificationRevision,
      },
    });
  });
}
