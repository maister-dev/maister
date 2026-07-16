import "server-only";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import pino from "pino";

import { appendEvaluationEvent } from "./events";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { contentDigest } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";
import { resolveEffectiveProfile } from "@/lib/evaluations/resolution";

// FIXME(any): schema-module bridge (matches lib/evaluations/config.ts).
const { evaluationExecutions, evaluationMethodRevisions, evaluationStudies } =
  schemaModule as unknown as Record<string, any>;

// FIXME(any): narrow this injected database seam to its operations.
type Db = any;

const log = pino({
  name: "evaluations-dispatch-start",
  level: process.env.LOG_LEVEL ?? "info",
});

// The evidence-protocol digest keyed by the shared M46 capture protocol (diff +
// ground-truth). A method may declare an `evidenceProtocol` override; all M46
// methods share the default, so a sealed snapshot is reusable across compatible
// methods over the same participant set (D5). NOT the method definition digest.
export function deriveEvidenceProtocolDigest(
  methodDef: Record<string, unknown>,
): string {
  const protocol = (methodDef.evidenceProtocol ??
    "diff+ground_truth@1") as unknown;

  return contentDigest({ evidenceProtocol: protocol });
}

interface MethodDefinition {
  objectiveChecks?: Array<{
    id: string;
    provider: string;
    policy: string;
    criterionId?: string;
    hostCheckProfile?: string;
  }>;
  aggregation?: { algorithm: string };
}

async function loadMethodDefinition(
  methodRevisionId: string,
  d: Db,
): Promise<MethodDefinition> {
  const [rev] = await d
    .select({
      normalizedDefinition: evaluationMethodRevisions.normalizedDefinition,
    })
    .from(evaluationMethodRevisions)
    .where(eq(evaluationMethodRevisions.id, methodRevisionId));

  return (rev?.normalizedDefinition?.definition ?? {}) as MethodDefinition;
}

export interface StartExecutionArgs {
  studyId: string;
  projectId: string;
  profileId: string;
  studyOverrides?: Record<string, unknown>;
  registeredHostProfiles?: string[];
  requestedByUserId?: string | null;
  idempotencyKey?: string | null;
}

export interface StartExecutionResult {
  executionId: string;
  deduped: boolean;
}

// Create a queued Evaluation Execution (T3.3): resolve + snapshot the immutable
// effective profile (D8), snapshot the objective/judge/aggregation policies from
// the same method revision, and emit the `evaluation.queued` event. The
// dispatcher then drives it (capture → check → judge → aggregate). An identical
// `idempotencyKey` within the Study returns the original execution (never a
// duplicate). Callers kick the dispatch tick after this returns for immediacy.
export async function startEvaluationExecution(
  args: StartExecutionArgs,
  db?: Db,
): Promise<StartExecutionResult> {
  const d = db ?? getDb();

  const [study] = await d
    .select({
      id: evaluationStudies.id,
      projectId: evaluationStudies.projectId,
    })
    .from(evaluationStudies)
    .where(eq(evaluationStudies.id, args.studyId));

  if (!study || study.projectId !== args.projectId) {
    throw new MaisterError(
      "PRECONDITION",
      `study ${args.studyId} not found in project ${args.projectId}`,
    );
  }

  const profile = await resolveEffectiveProfile(
    {
      profileId: args.profileId,
      projectId: args.projectId,
      studyOverrides: args.studyOverrides,
    },
    d,
  );
  const methodDef = await loadMethodDefinition(profile.methodRevisionId, d);

  return d.transaction(async (tx: Db) => {
    if (args.idempotencyKey) {
      const [existing] = await tx
        .select({ id: evaluationExecutions.id })
        .from(evaluationExecutions)
        .where(eq(evaluationExecutions.idempotencyKey, args.idempotencyKey));

      if (existing) {
        return { executionId: existing.id, deduped: true };
      }
    }

    const [row] = await tx
      .insert(evaluationExecutions)
      .values({
        studyId: args.studyId,
        status: "queued",
        methodRevisionId: profile.methodRevisionId,
        effectiveProfileSnapshot: profile as unknown as Record<string, unknown>,
        objectivePolicySnapshot: {
          checks: methodDef.objectiveChecks ?? [],
          registeredHostProfiles: args.registeredHostProfiles ?? [],
        },
        judgePolicySnapshot: {
          roleBindings: profile.roleBindings,
          policy: profile.policy,
        },
        aggregationPolicySnapshot: {
          algorithm: methodDef.aggregation?.algorithm ?? null,
          quorum: profile.policy.quorum,
        },
        randomizationSeed: randomUUID(),
        idempotencyKey: args.idempotencyKey ?? null,
        requestedByUserId: args.requestedByUserId ?? null,
      })
      .returning({ id: evaluationExecutions.id });

    await appendEvaluationEvent(tx, {
      studyId: args.studyId,
      executionId: row.id,
      eventType: "evaluation.queued",
      payload: { profileId: args.profileId },
    });

    log.info(
      { studyId: args.studyId, executionId: row.id, profileId: args.profileId },
      "evaluation execution queued",
    );

    return { executionId: row.id, deduped: false };
  });
}

// Create a retry successor for a failed execution (poison recovery, D4). Copies
// the immutable method/profile/policy snapshots (never re-resolves a possibly-
// drifted Panel) into a new queued row with `retry_of` lineage. Refuses to retry
// a non-terminal row.
export async function retryFailedExecution(
  failedExecutionId: string,
  db?: Db,
): Promise<{ executionId: string } | null> {
  const d = db ?? getDb();

  return d.transaction(async (tx: Db) => {
    const [prior] = await tx
      .select({
        id: evaluationExecutions.id,
        studyId: evaluationExecutions.studyId,
        status: evaluationExecutions.status,
        methodRevisionId: evaluationExecutions.methodRevisionId,
        effectiveProfileSnapshot: evaluationExecutions.effectiveProfileSnapshot,
        objectivePolicySnapshot: evaluationExecutions.objectivePolicySnapshot,
        judgePolicySnapshot: evaluationExecutions.judgePolicySnapshot,
        aggregationPolicySnapshot:
          evaluationExecutions.aggregationPolicySnapshot,
        requestedByUserId: evaluationExecutions.requestedByUserId,
      })
      .from(evaluationExecutions)
      .where(eq(evaluationExecutions.id, failedExecutionId));

    if (!prior) {
      throw new MaisterError(
        "PRECONDITION",
        `evaluation execution not found: ${failedExecutionId}`,
      );
    }
    if (prior.status !== "failed") {
      throw new MaisterError(
        "CONFLICT",
        `cannot retry a ${prior.status} execution (${failedExecutionId})`,
      );
    }

    const [row] = await tx
      .insert(evaluationExecutions)
      .values({
        studyId: prior.studyId,
        status: "queued",
        retryOf: prior.id,
        methodRevisionId: prior.methodRevisionId,
        effectiveProfileSnapshot: prior.effectiveProfileSnapshot,
        objectivePolicySnapshot: prior.objectivePolicySnapshot,
        judgePolicySnapshot: prior.judgePolicySnapshot,
        aggregationPolicySnapshot: prior.aggregationPolicySnapshot,
        randomizationSeed: randomUUID(),
        requestedByUserId: prior.requestedByUserId,
      })
      .returning({ id: evaluationExecutions.id });

    await appendEvaluationEvent(tx, {
      studyId: prior.studyId,
      executionId: row.id,
      eventType: "evaluation.queued",
      payload: { retryOf: prior.id },
    });

    log.info(
      { retryOf: prior.id, executionId: row.id },
      "evaluation execution retry queued",
    );

    return { executionId: row.id };
  });
}
