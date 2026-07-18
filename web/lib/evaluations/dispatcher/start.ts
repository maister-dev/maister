import "server-only";

import type { Db } from "@/lib/evaluations/db";
import type {
  EvaluationCriterionSnapshotSpec,
  EvaluationExecutionAggregationPolicySnapshot,
  EvaluationExecutionJudgePolicySnapshot,
} from "@/lib/evaluations/types";

import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import pino from "pino";

import { appendEvaluationEvent } from "./events";

import { getDb } from "@/lib/db/client";
import {
  evaluationExecutions,
  evaluationMethodRevisions,
  evaluationStudies,
} from "@/lib/db/schema";
import { contentDigest } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";
import { resolveEffectiveProfile } from "@/lib/evaluations/resolution";

const log = pino({
  name: "evaluations-dispatch-start",
  level: process.env.LOG_LEVEL ?? "info",
});

// The evidence-protocol digest keyed by the shared M46 capture protocol (diff +
// ground-truth). Derived from the method's `evidence` block (the real schema
// key — captureBudgetBytes + requiredCoverage), deterministically: coverage is
// order-insensitive and the cosmetic `description` is excluded, so a sealed
// snapshot is reusable across compatible methods over the same participant set
// (D5). NOT the method definition digest. A definition without an `evidence`
// block falls back to the shared default protocol token.
export function deriveEvidenceProtocolDigest(
  methodDef: Record<string, unknown>,
): string {
  const evidence = methodDef.evidence as
    | { captureBudgetBytes?: number; requiredCoverage?: string[] }
    | undefined;

  if (!evidence || typeof evidence !== "object") {
    return contentDigest({ evidenceProtocol: "diff+ground_truth@1" });
  }

  return contentDigest({
    evidenceProtocol: {
      captureBudgetBytes: evidence.captureBudgetBytes ?? null,
      requiredCoverage: [...(evidence.requiredCoverage ?? [])].sort(),
    },
  });
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
  criteria?: Array<{
    id: string;
    weight: number;
    scale: { min: number; max: number };
    optional?: boolean;
    itemCap?: number;
  }>;
  caps?: { totalMax?: number };
}

async function loadMethodDefinition(
  methodRevisionId: string,
  d: Db,
): Promise<{
  definition: MethodDefinition;
  normalizedCriteria: Array<{ id: string; normalizedWeight: number }>;
}> {
  const [rev] = await d
    .select({
      normalizedDefinition: evaluationMethodRevisions.normalizedDefinition,
    })
    .from(evaluationMethodRevisions)
    .where(eq(evaluationMethodRevisions.id, methodRevisionId));

  return {
    definition: (rev?.normalizedDefinition?.definition ??
      {}) as MethodDefinition,
    normalizedCriteria: (rev?.normalizedDefinition?.criteria ?? []) as Array<{
      id: string;
      normalizedWeight: number;
    }>,
  };
}

// Freeze the definition slices the judge/aggregation pipeline consumes
// mid-flight onto the execution snapshots. The methods-registry upsert mutates
// `normalizedDefinition` in place, so anything read after start MUST come from
// these snapshots, never a live revision re-read (bounded exception: the judge
// context prompt/rubric, see judges/facade.ts).
function buildCriterionSnapshot(loaded: {
  definition: MethodDefinition;
  normalizedCriteria: Array<{ id: string; normalizedWeight: number }>;
}): EvaluationCriterionSnapshotSpec[] {
  const normalizedById = new Map(
    loaded.normalizedCriteria.map((c) => [c.id, c.normalizedWeight]),
  );

  return (loaded.definition.criteria ?? []).map((c) => ({
    id: c.id,
    weight: c.weight,
    normalizedWeight: normalizedById.get(c.id) ?? c.weight,
    scaleMin: c.scale.min,
    scaleMax: c.scale.max,
    optional: c.optional ?? false,
    itemCap: c.itemCap ?? null,
  }));
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
// `idempotencyKey` within the Study replays the original execution when the
// request digest matches; the same key with a DIFFERENT request is a CONFLICT
// (never a silent replay of an unrelated request). Concurrent first submits
// converge on the insert winner via the (study, key) partial unique index.
// Callers kick the dispatch tick after this returns for immediacy.
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
  const method = await loadMethodDefinition(profile.methodRevisionId, d);
  const methodDef = method.definition;

  // Pairwise execution is owner-deferred with the pairwise UI: the judge
  // submission contract carries no A/B pick yet, so an execution would only
  // die later at aggregation. Fail closed here with a typed refusal.
  if (methodDef.aggregation?.algorithm === "pairwise_tournament@1") {
    throw new MaisterError(
      "CONFIG",
      "pairwise_tournament methods are not executable yet — the pairwise execution path lands with the pairwise UI",
    );
  }

  const requestDigest = contentDigest({
    profileId: args.profileId,
    studyOverrides: args.studyOverrides ?? null,
  });

  const replayOrConflict = (existing: {
    id: string;
    requestDigest: string | null;
  }): StartExecutionResult => {
    if (existing.requestDigest !== requestDigest) {
      throw new MaisterError(
        "CONFLICT",
        `idempotency key "${args.idempotencyKey}" was already used for a different request in study ${args.studyId}`,
      );
    }

    return { executionId: existing.id, deduped: true };
  };

  return d.transaction(async (tx: Db) => {
    if (args.idempotencyKey) {
      const [existing] = await tx
        .select({
          id: evaluationExecutions.id,
          requestDigest: evaluationExecutions.requestDigest,
        })
        .from(evaluationExecutions)
        .where(
          and(
            eq(evaluationExecutions.studyId, args.studyId),
            eq(evaluationExecutions.idempotencyKey, args.idempotencyKey),
          ),
        );

      if (existing) {
        return replayOrConflict(existing);
      }
    }

    const inserted = await tx
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
          criteria: buildCriterionSnapshot(method),
        } satisfies EvaluationExecutionJudgePolicySnapshot as Record<
          string,
          unknown
        >,
        aggregationPolicySnapshot: {
          algorithm: methodDef.aggregation?.algorithm ?? null,
          quorum: profile.policy.quorum,
          totalMax: methodDef.caps?.totalMax ?? null,
          gateCheckIds: (methodDef.objectiveChecks ?? [])
            .filter((c) => c.policy === "gate")
            .map((c) => c.id),
          definitionDigest: profile.methodDigests.definitionDigest,
          schemaDigest: profile.methodDigests.schemaDigest,
        } satisfies EvaluationExecutionAggregationPolicySnapshot as Record<
          string,
          unknown
        >,
        randomizationSeed: randomUUID(),
        idempotencyKey: args.idempotencyKey ?? null,
        requestDigest,
        requestedByUserId: args.requestedByUserId ?? null,
      })
      .onConflictDoNothing({
        target: [
          evaluationExecutions.studyId,
          evaluationExecutions.idempotencyKey,
        ],
        where: sql`idempotency_key is not null`,
      })
      .returning({ id: evaluationExecutions.id });

    if (!inserted.length) {
      // A concurrent same-key submit won the (study, key) unique race while
      // this transaction was in flight — converge on the winner, never 23505.
      const [winner] = await tx
        .select({
          id: evaluationExecutions.id,
          requestDigest: evaluationExecutions.requestDigest,
        })
        .from(evaluationExecutions)
        .where(
          and(
            eq(evaluationExecutions.studyId, args.studyId),
            eq(evaluationExecutions.idempotencyKey, args.idempotencyKey ?? ""),
          ),
        );

      if (!winner) {
        throw new MaisterError(
          "CONFLICT",
          `execution insert conflicted but no winner row is visible (study ${args.studyId})`,
        );
      }

      return replayOrConflict(winner);
    }

    const row = inserted[0];

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
