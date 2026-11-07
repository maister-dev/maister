import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { SpecialistIntakeReceipt } from "./intake-types";

import { sql } from "drizzle-orm";

import { MaisterError } from "@/lib/errors";
import { promoteNextPending } from "@/lib/scheduler";

/** Re-signal existing admission after a durable reservation; never allocate or replay an execution. */
export async function wakePendingSpecialistAssignment(
  db: Db,
  receipt: SpecialistIntakeReceipt,
): Promise<void> {
  if (receipt.assignment.status !== "active") return;
  const row = (
    await db.execute(sql`
      SELECT execution.run_kind,execution.status
      FROM specialist_run_links link JOIN runs execution ON execution.id=link.run_id
      WHERE link.assignment_id=${receipt.assignment.id} AND link.input_revision=${receipt.inputRevision}
        AND link.role IN ('coordinator','specialist')
      ORDER BY link.linked_at,link.run_id LIMIT 1
    `)
  ).rows[0];

  if (!row || (row.run_kind !== "agent" && row.run_kind !== "flow"))
    throw new MaisterError(
      "CONFIG",
      "The reserved specialist assignment has no valid initial execution",
    );
  if (row.status === "Pending")
    await promoteNextPending({
      db,
      pool: row.run_kind === "agent" ? "agent" : "flow",
    });
}
