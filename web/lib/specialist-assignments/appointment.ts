import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";

import { sql } from "drizzle-orm";

import { unavailableKnowledgeReference } from "@/lib/brain/knowledge-restrictions";

const nativeAppointment = sql`(
  (link.role IN ('specialist','coordinator','continuation') AND link.work_id IS NULL)
  OR (link.role IN ('child','continuation') AND EXISTS (
    SELECT 1 FROM specialist_work work
    JOIN specialist_assignments assignment ON assignment.id=work.assignment_id
    WHERE work.id=link.work_id AND work.work_revision=link.work_revision
      AND work.assignment_id=link.assignment_id AND work.child_run_id=link.run_id
      AND work.decision_state='open'
      AND specialist_run_has_input(link.run_id,work.assignment_id,work.input_revision,work.input_sha256)
      AND specialist_work_target_exists(work.definition->'target',assignment.company_id,assignment.project_id)
  ))
)`;

/** Resolve assignment-scoped routing before parsing requests. The operation still reauthorizes it. */
export async function hasProjectCooperationAppointment(
  tx: SqlTransaction,
  runId: string,
  projectId: string,
): Promise<boolean> {
  const { rows } = await tx.execute(sql`
    SELECT 1 FROM specialist_run_links link
    JOIN runs execution ON execution.id=link.run_id AND execution.project_id=${projectId}
    JOIN specialist_assignments subject ON subject.id=link.assignment_id AND subject.project_id=${projectId}
    WHERE execution.id=${runId} AND execution.knowledge_access->>'state'='complete'
      AND subject.status NOT IN ('completed','failed','cancelled') AND ${nativeAppointment}
  `);

  return rows.length === 1;
}

/** Input sharing does not grant access to another assignment's live working material. */
export async function assertAssignmentAppointment(
  tx: SqlTransaction,
  runId: string,
  assignmentId: string,
): Promise<void> {
  const links = await tx.execute(sql`
    SELECT 1 FROM specialist_run_links link
    WHERE link.run_id=${runId} AND link.assignment_id=${assignmentId} AND ${nativeAppointment}
  `);

  if (links.rows.length !== 1) throw unavailableKnowledgeReference();
}
