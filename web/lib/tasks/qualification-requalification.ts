import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { and, eq } from "drizzle-orm";

import { lockTaskLaunchReservation } from "./launch-locks";
import { requireTaskRequalification } from "./qualification";

import { tasks } from "@/lib/db/schema";

export type TaskRequalificationWitness = Readonly<{
  projectId: string;
  taskId: string;
  qualificationId: string;
  inputRevision: number;
}>;

/** A delayed refusal cannot invalidate a newer assessment or repeatedly advance the same input. */
export async function requestTaskRequalificationIfCurrent(
  db: Db,
  witness: TaskRequalificationWitness,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockTaskLaunchReservation(tx, witness.taskId);
    const [current] = await tx
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.id, witness.taskId),
          eq(tasks.projectId, witness.projectId),
        ),
      )
      .for("update");

    if (
      !current ||
      current.currentQualificationId !== witness.qualificationId ||
      current.qualificationInputRevision !== witness.inputRevision
    )
      return false;
    await requireTaskRequalification(tx, witness.projectId, witness.taskId);

    return true;
  });
}
