import "server-only";

import type { Owner } from "@/lib/company/types";
import type { SqlTransaction } from "@/lib/db/sql-types";
import type { AssignmentDestination } from "./types";

import { sql } from "drizzle-orm";

import { MaisterError } from "@/lib/errors";

function unavailableDestination(): MaisterError {
  return new MaisterError(
    "PRECONDITION",
    "Assignment delivery destination is unavailable",
    { details: { reason: "assignment_destination_unavailable" } },
  );
}

/** Lock the actual configured destination; a retained selector never grants another recipient access. */
export async function validateAssignmentDestination(
  tx: SqlTransaction,
  requesterId: string,
  owner: Owner,
  destination: AssignmentDestination,
): Promise<void> {
  if (destination.kind === "inbox") {
    if (destination.userId !== requesterId) throw unavailableDestination();

    return;
  }
  if (destination.kind === "task_comment") {
    if (owner.kind !== "project" || owner.projectId !== destination.projectId)
      throw unavailableDestination();
    const task = await tx.execute(sql`
      SELECT target.id FROM tasks target
      JOIN projects project ON project.id=target.project_id
      WHERE target.id=${destination.taskId} AND target.project_id=${owner.projectId}
        AND project.archived_at IS NULL
      FOR SHARE OF target,project
    `);

    if (task.rows.length !== 1) throw unavailableDestination();
    if (destination.threadCommentId !== null) {
      const thread = await tx.execute(sql`
        SELECT id FROM task_comments WHERE id=${destination.threadCommentId}
          AND task_id=${destination.taskId} AND project_id=${owner.projectId}
        FOR SHARE
      `);

      if (thread.rows.length !== 1) throw unavailableDestination();
    }

    return;
  }
  const subscription = await tx.execute(sql`
    SELECT id FROM webhook_subscriptions
    WHERE id=${destination.subscriptionId} AND project_id IS NULL
      AND owner_user_id=${requesterId} AND enabled=true
      AND (event_types ? '*' OR event_types ? 'assignment.result_available')
    FOR SHARE
  `);

  if (subscription.rows.length !== 1) throw unavailableDestination();
}
