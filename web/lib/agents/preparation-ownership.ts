import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { OperationalFailureDiagnostic } from "./operational-diagnostics";
import type { OperationalIntegrityBaseline } from "@/lib/run-results/operational-types";

import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";

import { and, eq, exists, inArray, isNull, sql, or, ne } from "drizzle-orm";
import pino from "pino";

import { agentPreparationOperations, runs } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { lockCurrentSessionAssignment } from "@/lib/execution-host/session-binding";

const log = pino({ name: "agent-preparation" });
const ACTIVE = [
  "claimed",
  "checkout_ready",
  "baseline_ready",
  "materialized",
] as const;

type Preparation = typeof agentPreparationOperations.$inferSelect;
type PreparationProgress = {
  phase: Preparation["phase"];
  resolvedCommit?: string;
  generation?: number;
  turnId?: string;
  failure?: OperationalFailureDiagnostic;
};

function activePreparation(operation: Preparation): ReturnType<typeof and> {
  return and(
    eq(agentPreparationOperations.id, operation.id),
    eq(agentPreparationOperations.runId, operation.runId),
    eq(agentPreparationOperations.assignmentId, operation.assignmentId),
    eq(agentPreparationOperations.assignmentEpoch, operation.assignmentEpoch),
    eq(agentPreparationOperations.resourceId, operation.resourceId),
    eq(agentPreparationOperations.incarnation, operation.incarnation),
    inArray(agentPreparationOperations.phase, [...ACTIVE]),
    sql`${agentPreparationOperations.leaseExpiresAt} > clock_timestamp()`,
  );
}

export function preparationFenced(runId: string): MaisterError {
  return new MaisterError(
    "CONFLICT",
    "Workspace preparation no longer owns this assignment",
    {
      details: { reason: "assignment_fenced", runId },
    },
  );
}

/** Called only while the physical preparation owner remains held through terminal commit. */
export async function assertAgentPreparationFailureOwner(
  tx: Db,
  operation: Pick<
    Preparation,
    | "id"
    | "runId"
    | "assignmentId"
    | "assignmentEpoch"
    | "resourceId"
    | "incarnation"
  >,
): Promise<void> {
  const assignment = await lockCurrentSessionAssignment(tx, operation);

  if (!assignment || assignment.epoch !== operation.assignmentEpoch)
    throw preparationFenced(operation.runId);
  const [current] = await tx
    .select({ id: agentPreparationOperations.id })
    .from(agentPreparationOperations)
    .where(
      and(
        eq(agentPreparationOperations.id, operation.id),
        eq(agentPreparationOperations.runId, operation.runId),
        eq(agentPreparationOperations.assignmentId, operation.assignmentId),
        eq(
          agentPreparationOperations.assignmentEpoch,
          operation.assignmentEpoch,
        ),
        eq(agentPreparationOperations.resourceId, operation.resourceId),
        eq(agentPreparationOperations.incarnation, operation.incarnation),
        or(
          eq(agentPreparationOperations.phase, "failed"),
          and(
            inArray(agentPreparationOperations.phase, [...ACTIVE]),
            sql`${agentPreparationOperations.leaseExpiresAt} > clock_timestamp()`,
          ),
        ),
      ),
    )
    .for("update");
  const [successor] = await tx
    .select({ id: agentPreparationOperations.id })
    .from(agentPreparationOperations)
    .where(
      and(
        eq(agentPreparationOperations.resourceId, operation.resourceId),
        ne(agentPreparationOperations.id, operation.id),
        inArray(agentPreparationOperations.phase, [...ACTIVE]),
      ),
    )
    .limit(1);

  if (!current || successor) throw preparationFenced(operation.runId);
}

export function assertPreparationCommit(
  expected: string | null,
  actual: string | null,
): void {
  if (expected !== null && actual !== expected)
    throw new MaisterError(
      "PRECONDITION",
      "The checkout no longer matches its frozen preparation commit; preserve it and launch a new attempt after diagnosis",
      {
        details: {
          reason: "operational_source_revision_changed",
          expectedCommit: expected,
          observedCommit: actual,
        },
      },
    );
}

/** The caller already holds physical exclusion, including retired Git-child proof. */
export async function claimAgentPreparation(
  db: Db,
  input: {
    runId: string;
    assignmentId: string;
    cwd: string;
    repoPath: string;
  },
): Promise<{
  operation: Preparation;
  previous: Preparation | null;
  run: typeof runs.$inferSelect;
}> {
  const canonicalRepo = await realpath(input.repoPath);
  const resourceId = createHash("sha256")
    .update(`${canonicalRepo}\0${path.resolve(input.cwd)}`)
    .digest("hex");

  return db.transaction(async (tx) => {
    const assignment = await lockCurrentSessionAssignment(tx, input);
    const [run] = await tx.select().from(runs).where(eq(runs.id, input.runId));

    if (
      !assignment ||
      !run ||
      run.status !== "Running" ||
      run.operationalCleanup?.removedAt
    )
      throw preparationFenced(input.runId);
    const [previous] = await tx
      .select()
      .from(agentPreparationOperations)
      .where(eq(agentPreparationOperations.resourceId, resourceId))
      .orderBy(sql`${agentPreparationOperations.createdAt} DESC`)
      .limit(1)
      .for("update");

    // Physical retirement, not lease age, permits fencing an abandoned publisher.
    await tx
      .update(agentPreparationOperations)
      .set({
        phase: "fenced",
        leaseExpiresAt: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(agentPreparationOperations.resourceId, resourceId),
          inArray(agentPreparationOperations.phase, [...ACTIVE]),
        ),
      );
    const id = randomUUID();
    const [operation] = await tx
      .insert(agentPreparationOperations)
      .values({
        id,
        runId: run.id,
        assignmentId: assignment.id,
        assignmentEpoch: assignment.epoch,
        resourceId,
        incarnation: previous?.incarnation ?? randomUUID(),
        phase: "claimed",
        resolvedCommit:
          previous?.runId === run.id ? previous.resolvedCommit : null,
        leaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
      })
      .returning();

    log.info(
      {
        runId: run.id,
        assignmentId: assignment.id,
        assignmentEpoch: assignment.epoch,
        preparationId: id,
        resourceId,
      },
      "agent-preparation-claimed",
    );

    return { operation, previous: previous ?? null, run };
  });
}

export async function advanceAgentPreparation(
  db: Db,
  operation: Preparation,
  next: PreparationProgress,
): Promise<void> {
  await db.transaction(async (tx) => {
    const assignment = await lockCurrentSessionAssignment(tx, operation);
    const [run] = await tx
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, operation.runId));

    if (
      !assignment ||
      assignment.epoch !== operation.assignmentEpoch ||
      run?.status !== "Running"
    )
      throw preparationFenced(operation.runId);
    await writePreparationProgress(tx, operation, next);
  });
}

async function writePreparationProgress(
  tx: Db,
  operation: Preparation,
  next: PreparationProgress,
): Promise<void> {
  const active = ACTIVE.includes(next.phase as (typeof ACTIVE)[number]);
  const [written] = await tx
    .update(agentPreparationOperations)
    .set({
      ...next,
      updatedAt: sql`clock_timestamp()`,
      leaseExpiresAt: active
        ? sql`clock_timestamp() + interval '60 seconds'`
        : null,
    })
    .where(activePreparation(operation))
    .returning({ id: agentPreparationOperations.id });

  if (!written) throw preparationFenced(operation.runId);
  log.info(
    {
      runId: operation.runId,
      assignmentId: operation.assignmentId,
      assignmentEpoch: operation.assignmentEpoch,
      preparationId: operation.id,
      phase: next.phase,
      generation: next.generation,
    },
    "agent-preparation-advanced",
  );
}

/** Publish captured bytes and their ownership receipt in one fenced commit. */
async function publishPreparation(
  db: Db,
  operation: Preparation,
  baseline: OperationalIntegrityBaseline,
  expectedGeneration: number | null,
  phase: "baseline_ready" | "materialized",
): Promise<void> {
  await db.transaction(async (tx) => {
    const assignment = await lockCurrentSessionAssignment(tx, operation);

    if (!assignment || assignment.epoch !== operation.assignmentEpoch)
      throw preparationFenced(operation.runId);
    const [written] = await tx
      .update(runs)
      .set({ operationalIntegrityBaseline: baseline })
      .where(
        and(
          eq(runs.id, operation.runId),
          eq(runs.status, "Running"),
          eq(runs.executionAssignmentId, operation.assignmentId),
          expectedGeneration === null
            ? isNull(runs.operationalIntegrityBaseline)
            : sql`${runs.operationalIntegrityBaseline}->>'generation' = ${String(expectedGeneration)}`,
          exists(
            tx
              .select({ id: agentPreparationOperations.id })
              .from(agentPreparationOperations)
              .where(activePreparation(operation)),
          ),
        ),
      )
      .returning({ id: runs.id });

    if (!written) throw preparationFenced(operation.runId);
    // Recheck DB time after the write; expiry rolls both publications back.
    await writePreparationProgress(tx, operation, {
      phase,
      generation: baseline.generation,
    });
  });
}

export function publishAgentPreparationBaseline(
  db: Db,
  operation: Preparation,
  baseline: OperationalIntegrityBaseline,
): Promise<void> {
  return publishPreparation(db, operation, baseline, null, "baseline_ready");
}

export function publishAgentPreparationGeneration(
  db: Db,
  operation: Preparation,
  baseline: OperationalIntegrityBaseline,
  previousGeneration: number,
): Promise<void> {
  return publishPreparation(
    db,
    operation,
    baseline,
    previousGeneration,
    "materialized",
  );
}

export async function renewAgentPreparation(
  db: Db,
  operation: Preparation,
): Promise<void> {
  await db.transaction(async (tx) => {
    const assignment = await lockCurrentSessionAssignment(tx, operation);

    if (!assignment || assignment.epoch !== operation.assignmentEpoch)
      throw preparationFenced(operation.runId);
    const [written] = await tx
      .update(agentPreparationOperations)
      .set({
        leaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(agentPreparationOperations.id, operation.id),
          inArray(agentPreparationOperations.phase, [...ACTIVE]),
          sql`${agentPreparationOperations.leaseExpiresAt} > clock_timestamp()`,
        ),
      )
      .returning({ id: agentPreparationOperations.id });

    if (!written) throw preparationFenced(operation.runId);
  });
}
