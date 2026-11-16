import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";
import type { KnowledgePrincipalIdentity } from "@/lib/brain/knowledge-access";

import { sql } from "drizzle-orm";

import { projectAssignmentInitiatorPolicy } from "./project-initiator-policy";

import { assignmentInputReadPolicy } from "@/lib/brain/knowledge-assignment-policy";
import { MaisterError } from "@/lib/errors";

/** Resolve the initiating human from the original admitted project appointment, including governed children. */
export async function requireProjectAssignmentInitiator(
  tx: SqlTransaction,
  identity: Extract<KnowledgePrincipalIdentity, { kind: "agent" }>,
): Promise<string> {
  const run = (
    await tx.execute(
      sql`SELECT original.actor->>'id' AS initiating_user_id
      FROM runs execution JOIN specialist_run_links appointment ON appointment.run_id=execution.id
      JOIN specialist_assignments requested ON requested.id=appointment.assignment_id
      JOIN specialist_input_revisions original ON original.assignment_id=appointment.assignment_id AND original.revision=appointment.input_revision
      WHERE execution.id=${identity.actor.runId} AND execution.project_id=${identity.projectId} AND execution.company_id IS NULL
        AND requested.project_id=execution.project_id AND requested.company_id IS NULL
        AND original.actor->>'kind'='user'
        AND ((appointment.work_id IS NULL AND (${projectAssignmentInitiatorPolicy(
          {
            runId: sql`execution.id`,
            createdByUserId: sql`execution.created_by_user_id`,
            projectId: sql`execution.project_id`,
            taskId: sql`execution.task_id`,
            userId: sql`original.actor->>'id'`,
            assignmentId: sql`original.assignment_id`,
            inputRevision: sql`original.revision`,
            inputSha256: sql`original.digest`,
          },
        )})) OR (appointment.work_id IS NOT NULL AND (${assignmentInputReadPolicy(
          identity,
          sql`original.assignment_id`,
          sql`original.revision`,
          sql`original.digest`,
        )})))
      FOR SHARE OF execution,appointment,requested,original`,
    )
  ).rows[0];

  if (typeof run?.initiating_user_id !== "string")
    throw new MaisterError(
      "UNAUTHORIZED",
      "The current initiating project principal is unavailable",
    );

  return run.initiating_user_id;
}
