import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { OperationalFailureDiagnostic } from "./operational-diagnostics";

import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";

import { and, eq, inArray, sql } from "drizzle-orm";
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

export function preparationFenced(runId: string): MaisterError {
  return new MaisterError(
    "CONFLICT",
    "Workspace preparation no longer owns this assignment",
    {
      details: { reason: "assignment_fenced", runId },
    },
  );
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
        resolvedCommit: previous?.resolvedCommit ?? null,
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
  next: {
    phase: Preparation["phase"];
    resolvedCommit?: string;
    generation?: number;
    turnId?: string;
    failure?: OperationalFailureDiagnostic;
  },
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
      .where(
        and(
          eq(agentPreparationOperations.id, operation.id),
          inArray(agentPreparationOperations.phase, [...ACTIVE]),
          sql`${agentPreparationOperations.leaseExpiresAt} > clock_timestamp()`,
        ),
      )
      .returning({ id: agentPreparationOperations.id });

    if (!written) throw preparationFenced(operation.runId);
    log.info(
      {
        runId: operation.runId,
        assignmentId: operation.assignmentId,
        assignmentEpoch: operation.assignmentEpoch,
        preparationId: operation.id,
        phase: next.phase,
      },
      "agent-preparation-advanced",
    );
  });
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
