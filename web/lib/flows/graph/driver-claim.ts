import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";

import { and, eq, isNull, lte, or, sql } from "drizzle-orm";

import { runs } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { projectionTransaction } from "@/lib/execution-host/events/projection-transaction";
import { lockCurrentSessionAssignment } from "@/lib/execution-host/session-binding";

export type FlowDriverClaim = Readonly<{
  runId: string;
  assignmentId: string;
  token: string;
}>;

export class FlowDriverClaimLost extends MaisterError {
  constructor(claim: FlowDriverClaim) {
    super("CONFLICT", "Flow traversal no longer owns its continuation", {
      details: {
        reason: "flow_driver_claim_lost",
        runId: claim.runId,
        assignmentId: claim.assignmentId,
      },
    });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isFlowDriverClaimLost(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current = error;

  while (current instanceof Error && !visited.has(current)) {
    if (current instanceof FlowDriverClaimLost) return true;
    visited.add(current);
    current = current.cause;
  }

  return false;
}

/** Serialize with run/assignment transitions before checking the traversal
 * token. Call again immediately before commit to reject an expired lease even
 * when this transaction prevented a successor from taking the run lock.
 */
export async function assertFlowDriverClaim(
  tx: Db,
  claim: FlowDriverClaim,
): Promise<void> {
  if (!(await lockCurrentSessionAssignment(tx, claim)))
    throw new FlowDriverClaimLost(claim);
  await assertFlowDriverCommit(tx, claim);
}

/** The caller already holds the run/assignment locks. Its own terminal
 * transition may release the assignment; the pointer, token and lease must
 * still match when that transition commits.
 */
export async function assertFlowDriverCommit(
  tx: Db,
  claim: FlowDriverClaim,
): Promise<void> {
  const [current] = await tx
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.id, claim.runId),
        eq(runs.executionAssignmentId, claim.assignmentId),
        eq(runs.runKind, "flow"),
        eq(runs.flowDriverToken, claim.token),
        sql`${runs.flowDriverLeaseExpiresAt} > clock_timestamp()`,
      ),
    );

  if (!current) throw new FlowDriverClaimLost(claim);
}

export async function claimFlowDriver(
  db: Db,
  input: { runId: string; assignmentId: string },
): Promise<FlowDriverClaim | null> {
  return projectionTransaction(db, async (tx) => {
    if (!(await lockCurrentSessionAssignment(tx, input))) return null;
    const token = randomUUID();
    const [claimed] = await tx
      .update(runs)
      .set({
        flowDriverToken: token,
        flowDriverLeaseExpiresAt: sql`clock_timestamp() + interval '30 seconds'`,
      })
      .where(
        and(
          eq(runs.id, input.runId),
          eq(runs.runKind, "flow"),
          or(eq(runs.status, "Running"), eq(runs.status, "NeedsInput")),
          or(
            isNull(runs.flowDriverToken),
            lte(runs.flowDriverLeaseExpiresAt, sql`clock_timestamp()`),
          ),
        ),
      )
      .returning({ id: runs.id });

    return claimed ? { ...input, token } : null;
  });
}

export async function renewFlowDriverClaim(
  db: Db,
  claim: FlowDriverClaim,
): Promise<void> {
  await projectionTransaction(db, async (tx) => {
    await assertFlowDriverClaim(tx, claim);
    await tx
      .update(runs)
      .set({
        flowDriverLeaseExpiresAt: sql`clock_timestamp() + interval '30 seconds'`,
      })
      .where(
        and(eq(runs.id, claim.runId), eq(runs.flowDriverToken, claim.token)),
      );
  });
}

export async function releaseFlowDriverClaim(
  db: Db,
  claim: FlowDriverClaim,
): Promise<void> {
  await projectionTransaction(db, async (tx) => {
    // Cleanup owns only its token and must also work after a terminal status or
    // released assignment. It never clears a successor's live traversal.
    await tx
      .update(runs)
      .set({ flowDriverToken: null, flowDriverLeaseExpiresAt: null })
      .where(
        and(eq(runs.id, claim.runId), eq(runs.flowDriverToken, claim.token)),
      );
  });
}
