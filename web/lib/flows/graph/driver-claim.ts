import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { Run, ExecutionAssignment } from "@/lib/db/schema";

import { randomUUID } from "node:crypto";

import { and, eq, isNull, lte, or, sql } from "drizzle-orm";

import { compileManifest } from "./compile";
import { flowTraversalRequirements } from "./traversal-requirements";

import {
  runs,
  executionAssignments,
  flowRevisions,
  flows,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { projectionTransaction } from "@/lib/execution-host/events/projection-transaction";
import { parseExecutableStoredFlowManifest } from "@/lib/flows/manifest-parser";
import { manifestDigest } from "@/lib/flows/digest";

type PlacedFlowDriverScope = Readonly<{
  scope: "assignment";
  runId: string;
  assignmentId: string;
  assignmentEpoch: number;
}>;
type UnplacedSessionlessFlowDriverScope = Readonly<{
  scope: "unplaced_sessionless";
  runId: string;
  assignmentId: null;
  manifestDigest: string;
}>;
export type FlowDriverClaim = (
  PlacedFlowDriverScope | UnplacedSessionlessFlowDriverScope
) &
  Readonly<{
    token: string;
  }>;

/** NO KEY UPDATE serializes run transitions without blocking human-assignment event foreign keys. */
async function lockFlowDriverRun(
  tx: Db,
  runId: string,
): Promise<Pick<
  Run,
  | "id"
  | "runKind"
  | "status"
  | "executionAssignmentId"
  | "flowId"
  | "flowRevisionId"
> | null> {
  const [run] = await tx
    .select({
      id: runs.id,
      runKind: runs.runKind,
      status: runs.status,
      executionAssignmentId: runs.executionAssignmentId,
      flowId: runs.flowId,
      flowRevisionId: runs.flowRevisionId,
    })
    .from(runs)
    .where(eq(runs.id, runId))
    .for("no key update");

  return run?.runKind === "flow" &&
    ["Running", "NeedsInput"].includes(run.status)
    ? run
    : null;
}

async function currentPlacedAssignment(
  tx: Db,
  runId: string,
  assignmentId: string,
): Promise<ExecutionAssignment | null> {
  const [assignment] = await tx
    .select()
    .from(executionAssignments)
    .where(
      and(
        eq(executionAssignments.id, assignmentId),
        eq(executionAssignments.runId, runId),
      ),
    )
    .for("update");

  return assignment?.state === "active" ? assignment : null;
}

async function hasAssignmentHistory(tx: Db, runId: string): Promise<boolean> {
  const [assignment] = await tx
    .select({ id: executionAssignments.id })
    .from(executionAssignments)
    .where(eq(executionAssignments.runId, runId))
    .limit(1);

  return assignment !== undefined;
}

/** Read the stored graph, never a client-supplied no-host flag or an invented assignment. */
async function storedSessionlessManifestDigest(
  tx: Db,
  run: Pick<Run, "flowId" | "flowRevisionId">,
): Promise<string | null> {
  const [source] = run.flowRevisionId
    ? await tx
        .select({ manifest: flowRevisions.manifest })
        .from(flowRevisions)
        .where(eq(flowRevisions.id, run.flowRevisionId))
    : await tx
        .select({ manifest: flows.manifest })
        .from(flows)
        .where(eq(flows.id, run.flowId ?? ""));

  if (!source) return null;
  const manifest = parseExecutableStoredFlowManifest(source.manifest, {
    code: "CONFIG",
    surface: "unplaced-flow-driver",
    manifestLabel: "stored Flow traversal",
  });
  const requirements = flowTraversalRequirements(compileManifest(manifest));

  return requirements.ownedPrompts || requirements.cliActions
    ? null
    : manifestDigest(manifest);
}

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
  const run = await lockFlowDriverRun(tx, claim.runId);

  if (!run || run.executionAssignmentId !== claim.assignmentId)
    throw new FlowDriverClaimLost(claim);
  if (claim.scope === "assignment") {
    const assignment = await currentPlacedAssignment(
      tx,
      claim.runId,
      claim.assignmentId,
    );

    if (assignment?.epoch !== claim.assignmentEpoch)
      throw new FlowDriverClaimLost(claim);
  } else if (
    (await hasAssignmentHistory(tx, claim.runId)) ||
    (await storedSessionlessManifestDigest(tx, run)) !== claim.manifestDigest
  ) {
    throw new FlowDriverClaimLost(claim);
  }
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
        claim.scope === "assignment"
          ? eq(runs.executionAssignmentId, claim.assignmentId)
          : isNull(runs.executionAssignmentId),
        eq(runs.runKind, "flow"),
        eq(runs.flowDriverToken, claim.token),
        sql`${runs.flowDriverLeaseExpiresAt} > clock_timestamp()`,
      ),
    );

  if (!current) throw new FlowDriverClaimLost(claim);
  if (claim.scope === "unplaced_sessionless") {
    const [run] = await tx.select().from(runs).where(eq(runs.id, claim.runId));

    if (
      !run ||
      (await hasAssignmentHistory(tx, claim.runId)) ||
      (await storedSessionlessManifestDigest(tx, run)) !== claim.manifestDigest
    )
      throw new FlowDriverClaimLost(claim);
  }
}

/** One lease policy; each public claim constructor supplies its separate, locked authority proof. */
async function acquireFlowDriverLease(
  tx: Db,
  runId: string,
): Promise<string | null> {
  const token = randomUUID();
  const [claimed] = await tx
    .update(runs)
    .set({
      flowDriverToken: token,
      flowDriverLeaseExpiresAt: sql`clock_timestamp() + interval '30 seconds'`,
    })
    .where(
      and(
        eq(runs.id, runId),
        eq(runs.runKind, "flow"),
        or(eq(runs.status, "Running"), eq(runs.status, "NeedsInput")),
        or(
          isNull(runs.flowDriverToken),
          lte(runs.flowDriverLeaseExpiresAt, sql`clock_timestamp()`),
        ),
      ),
    )
    .returning({ id: runs.id });

  return claimed ? token : null;
}

export async function claimFlowDriver(
  db: Db,
  input: { runId: string; assignmentId: string },
): Promise<FlowDriverClaim | null> {
  return projectionTransaction(db, async (tx) => {
    const run = await lockFlowDriverRun(tx, input.runId);

    if (!run || run.executionAssignmentId !== input.assignmentId) return null;
    const assignment = await currentPlacedAssignment(
      tx,
      input.runId,
      input.assignmentId,
    );

    if (!assignment) return null;
    const token = await acquireFlowDriverLease(tx, input.runId);

    return token
      ? {
          ...input,
          scope: "assignment",
          assignmentEpoch: assignment.epoch,
          token,
        }
      : null;
  });
}

/** Compatibility only for stored no-host graphs that have never had a placement. */
export async function claimUnplacedSessionlessFlowDriver(
  db: Db,
  runId: string,
): Promise<FlowDriverClaim | null> {
  return projectionTransaction(db, async (tx) => {
    const run = await lockFlowDriverRun(tx, runId);

    if (!run || run.executionAssignmentId !== null) return null;
    if (await hasAssignmentHistory(tx, runId))
      throw new MaisterError(
        "PRECONDITION",
        "The Flow has placement history; recover its assignment before continuing",
        { details: { reason: "assignment_missing", runId } },
      );
    const digest = await storedSessionlessManifestDigest(tx, run);

    if (digest === null)
      throw new MaisterError(
        "PRECONDITION",
        "An unplaced Flow with host or CLI work requires its normal placement",
        { details: { reason: "assignment_missing", runId } },
      );
    const token = await acquireFlowDriverLease(tx, runId);

    return token
      ? {
          scope: "unplaced_sessionless",
          runId,
          assignmentId: null,
          manifestDigest: digest,
          token,
        }
      : null;
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
