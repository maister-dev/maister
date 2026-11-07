import "server-only";

import type { SqlDatabase, SqlTransaction } from "@/lib/db/sql-types";
import type { ProjectAssignmentAdmission } from "./project-admission";

import { sql } from "drizzle-orm";

import {
  lockSpecialistAssignment,
  getSpecialistAssignmentInputInTransaction,
} from "./store";
import { authorizeAssignment } from "./access";

import { emitSpecialistAssignmentChange } from "@/lib/domain-events/outbox";
import { MaisterError } from "@/lib/errors";

export type ProjectAssignmentTask = Readonly<{
  taskId: string;
  admission: ProjectAssignmentAdmission;
}>;

/** Retain the initial existing-engine carrier once; later execution continuations keep this original identity. */
export async function reserveProjectAssignmentTask(
  db: SqlDatabase,
  projectId: string,
  reference: ProjectAssignmentAdmission,
  createTask: (tx: SqlTransaction) => Promise<string>,
): Promise<ProjectAssignmentTask> {
  return db.transaction(async (tx) => {
    const head = await lockSpecialistAssignment(
      tx,
      reference.assignmentId,
      reference.expectedRevision,
    );

    if (
      head.project_id !== projectId ||
      head.company_id !== null ||
      head.status !== "queued" ||
      head.input_revision !== reference.inputRevision
    )
      throw new MaisterError(
        "CONFLICT",
        "The original queued project assignment must own its carrier task",
      );
    const input = await getSpecialistAssignmentInputInTransaction(
      tx,
      reference.userId,
      reference.assignmentId,
      reference.inputRevision,
    );

    await authorizeAssignment(
      tx,
      reference.userId,
      { kind: "project", projectId },
      "assignments:update",
      input.snapshot.authoritySnapshot.executionPolicy,
    );
    if (input.snapshot.standingDefinition.schemaVersion !== 2)
      throw new MaisterError(
        "PRECONDITION",
        "Project coordinator admission requires its exact versioned Flow witness",
      );
    if (
      head.project_task_id !== null &&
      typeof head.project_task_id !== "string"
    )
      throw new MaisterError(
        "CONFIG",
        "Project assignment task linkage requires main migration 0239",
      );
    const taskId =
      typeof head.project_task_id === "string"
        ? head.project_task_id
        : await createTask(tx);
    const task = (
      await tx.execute(
        sql`SELECT id FROM tasks WHERE id=${taskId} AND project_id=${projectId} AND flow_id=${input.snapshot.standingDefinition.coordinatorFlow.flowId} FOR SHARE`,
      )
    ).rows[0];

    if (!task)
      throw new MaisterError(
        "CONFLICT",
        "The assignment's project task or declared Flow was retargeted",
        { details: { reason: "project_assignment_task_changed" } },
      );
    if (typeof head.project_task_id === "string")
      return { taskId, admission: reference };
    const changed = await tx.execute(sql`
      UPDATE specialist_assignments SET project_task_id=${taskId},revision=revision+1,updated_at=clock_timestamp()
      WHERE id=${reference.assignmentId} AND revision=${reference.expectedRevision} AND status='queued' AND project_task_id IS NULL
      RETURNING revision
    `);
    const revision = changed.rows[0]?.revision;

    if (typeof revision !== "number")
      throw new MaisterError(
        "CONFLICT",
        "Assignment changed before retaining its initial project task",
        { details: { reason: "assignment_revision_conflict" } },
      );
    await emitSpecialistAssignmentChange({
      db: tx,
      owner: { kind: "project", projectId },
      assignmentId: reference.assignmentId,
      revision,
      previousStatus: "queued",
      status: "queued",
      cause: "state",
      actor: { type: "user", id: reference.userId },
    });

    return { taskId, admission: { ...reference, expectedRevision: revision } };
  });
}
