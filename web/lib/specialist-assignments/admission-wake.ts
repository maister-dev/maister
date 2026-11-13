import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { SpecialistIntakeReceipt } from "./intake-types";

import { sql } from "drizzle-orm";

import { MaisterError } from "@/lib/errors";
import { promoteNextPending } from "@/lib/scheduler";

/** Re-signal the current root after intake replay, including a retained replacement. */
export async function wakePendingSpecialistAssignment(
  db: Db,
  receipt: SpecialistIntakeReceipt,
): Promise<void> {
  if (receipt.assignment.status !== "active") return;
  const row = (
    await db.execute(sql`
      SELECT execution.run_kind,execution.status
      FROM specialist_assignments subject
      JOIN runs execution ON execution.id=specialist_current_root_id(subject.id,subject.input_revision)
      WHERE subject.id=${receipt.assignment.id} AND subject.status='active'
    `)
  ).rows[0];

  if (!row) return;
  if (row.run_kind !== "agent" && row.run_kind !== "flow")
    throw new MaisterError(
      "CONFIG",
      "The reserved specialist assignment has no valid current execution",
    );
  if (row.status === "Pending")
    await promoteNextPending({
      db,
      pool: row.run_kind === "agent" ? "agent" : "flow",
    });
}
