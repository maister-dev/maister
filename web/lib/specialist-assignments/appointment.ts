import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";

import { sql } from "drizzle-orm";

import { unavailableKnowledgeReference } from "@/lib/brain/knowledge-restrictions";

/** Input sharing does not grant access to another assignment's live working material. */
export async function assertAssignmentAppointment(
  tx: SqlTransaction,
  runId: string,
  assignmentId: string,
): Promise<void> {
  const links = await tx.execute(sql`
    SELECT 1 FROM specialist_run_links WHERE run_id=${runId} AND assignment_id=${assignmentId}
      AND role IN ('specialist','coordinator','continuation') AND work_id IS NULL
  `);

  if (links.rows.length !== 1) throw unavailableKnowledgeReference();
}
