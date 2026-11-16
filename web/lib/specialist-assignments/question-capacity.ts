import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";

import { sql } from "drizzle-orm";

import { MaisterError } from "@/lib/errors";

/** Reserve answer lineage within the existing 0248 resolver's 32-receipt bound, under the caller's Run lock. */
export async function assertAssignmentQuestionCapacity(
  tx: SqlTransaction,
  runId: string,
  assignmentId: string,
): Promise<void> {
  const retained = await tx.execute(sql`
    SELECT id FROM hitl_requests
    WHERE run_id=${runId} AND specialist_assignment_id=${assignmentId}
      AND specialist_answer IS NOT NULL
    LIMIT 32
  `);

  if (retained.rows.length === 32)
    throw new MaisterError(
      "PRECONDITION",
      "The Run has reached its 32-answer clarification limit; retain this work and request an authorized continuation",
      { details: { reason: "assignment_question_limit" } },
    );
}
