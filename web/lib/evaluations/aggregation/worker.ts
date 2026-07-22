import "server-only";

import type { Db } from "@/lib/evaluations/db";
import type { AggregationAlgorithm } from "@/lib/evaluations/method-schema";
import type {
  EvaluationExecutionAggregationPolicySnapshot,
  EvaluationExecutionJudgePolicySnapshot,
} from "@/lib/evaluations/types";

import { eq } from "drizzle-orm";
import pino from "pino";

import {
  computeAggregate,
  type AggCriterion,
  type AttemptResult,
} from "./algorithms";
import { classifyDisagreement } from "./disagreement";
import {
  computeTournamentForExecution,
  persistTournamentAggregate,
} from "./pairwise-aggregate";
import { persistAggregate } from "./persist";
import { PAIRWISE_TOURNAMENT_ALGORITHM } from "./tournament";

import { advanceExecution } from "@/lib/evaluations/dispatcher/advance";
import { openReview } from "@/lib/evaluations/reviews";
import { getDb } from "@/lib/db/client";
import {
  evaluationCriterionResults,
  evaluationExecutions,
  evaluationJudgeAttempts,
  evaluationMethodRevisions,
  evaluationObjectiveCheckRuns,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "evaluations-aggregation-worker",
  level: process.env.LOG_LEVEL ?? "info",
});

const ATTEMPT_TERMINAL = new Set([
  "completed",
  "invalid",
  "timed_out",
  "cancelled",
  "error",
]);

interface LoadedMethod {
  criteria: AggCriterion[];
  algorithm: AggregationAlgorithm;
  quorum: number;
  totalMax?: number;
  criterionScaleMax: number;
  gateCheckIds: Set<string>;
  definitionDigest: string;
  schemaDigest: string;
}

// Build the aggregation criteria + policy from the execution's START-TIME
// snapshots (judge_policy_snapshot.criteria + aggregation_policy_snapshot) —
// the exact definition slices the panel was launched against. The methods
// registry overwrites `normalizedDefinition` in place, so the live revision is
// NOT immutable mid-execution; only pre-snapshot legacy rows fall back to it.
function methodFromSnapshots(exec: ExecutionRow): LoadedMethod | null {
  const judgeSnap = exec.judgePolicySnapshot;
  const aggSnap = exec.aggregationPolicySnapshot;
  const criteria = judgeSnap?.criteria;

  if (
    !criteria?.length ||
    !aggSnap ||
    typeof aggSnap.algorithm !== "string" ||
    typeof aggSnap.quorum !== "number" ||
    typeof aggSnap.definitionDigest !== "string" ||
    typeof aggSnap.schemaDigest !== "string"
  ) {
    return null;
  }

  return {
    criteria: criteria.map((c) => ({
      id: c.id,
      weight: c.weight,
      normalizedWeight: c.normalizedWeight,
      scaleMin: c.scaleMin,
      scaleMax: c.scaleMax,
      itemCap: c.itemCap ?? undefined,
      optional: c.optional,
    })),
    algorithm: aggSnap.algorithm as AggregationAlgorithm,
    // The RESOLVED quorum (profile policy), snapshotted at start — never the
    // raw method floor (B: the snapshot was write-only before this).
    quorum: aggSnap.quorum,
    totalMax: aggSnap.totalMax ?? undefined,
    criterionScaleMax: Math.max(...criteria.map((c) => c.scaleMax)),
    gateCheckIds: new Set(aggSnap.gateCheckIds ?? []),
    definitionDigest: aggSnap.definitionDigest,
    schemaDigest: aggSnap.schemaDigest,
  };
}

async function loadMethodConfig(
  exec: ExecutionRow,
  d: Db,
): Promise<LoadedMethod | null> {
  const snapshotted = methodFromSnapshots(exec);

  if (snapshotted) return snapshotted;
  if (!exec.methodRevisionId) return null;

  // Legacy execution predating the start-time snapshot — the live revision is
  // the only source (bounded drift accepted for those rows only).
  return loadMethod(exec.methodRevisionId, d);
}

async function loadMethod(
  methodRevisionId: string,
  d: Db,
): Promise<LoadedMethod> {
  const [rev] = await d
    .select({
      normalizedDefinition: evaluationMethodRevisions.normalizedDefinition,
      definitionDigest: evaluationMethodRevisions.definitionDigest,
      schemaDigest: evaluationMethodRevisions.schemaDigest,
    })
    .from(evaluationMethodRevisions)
    .where(eq(evaluationMethodRevisions.id, methodRevisionId));

  if (!rev) {
    throw new MaisterError(
      "PRECONDITION",
      `method revision not found: ${methodRevisionId}`,
    );
  }

  const def = rev.normalizedDefinition?.definition as {
    criteria: Array<{
      id: string;
      weight: number;
      scale: { min: number; max: number };
      optional?: boolean;
      itemCap?: number;
    }>;
    aggregation: { algorithm: AggregationAlgorithm };
    panelPolicy: { quorum: number };
    caps?: { totalMax?: number };
    objectiveChecks?: Array<{ id: string; policy: string }>;
  };
  const normalized = (rev.normalizedDefinition?.criteria ?? []) as Array<{
    id: string;
    normalizedWeight: number;
  }>;
  const normalizedById = new Map(
    normalized.map((c) => [c.id, c.normalizedWeight]),
  );

  const criteria: AggCriterion[] = def.criteria.map((c) => ({
    id: c.id,
    weight: c.weight,
    normalizedWeight: normalizedById.get(c.id) ?? c.weight,
    scaleMin: c.scale.min,
    scaleMax: c.scale.max,
    itemCap: c.itemCap,
    optional: c.optional ?? false,
  }));

  return {
    criteria,
    algorithm: def.aggregation.algorithm,
    quorum: def.panelPolicy.quorum,
    totalMax: def.caps?.totalMax,
    criterionScaleMax: Math.max(...def.criteria.map((c) => c.scale.max)),
    gateCheckIds: new Set(
      (def.objectiveChecks ?? [])
        .filter((c) => c.policy === "gate")
        .map((c) => c.id),
    ),
    definitionDigest: rev.definitionDigest,
    schemaDigest: rev.schemaDigest,
  };
}

// The adapter: sealed judge attempts + their criterion results → the pure
// AttemptResult[] that computeAggregate consumes. A non-completed attempt is
// carried as `valid:false` so computeAggregate excludes it with a reason (never
// dropped silently); its criterion scores are ignored.
export async function loadAttemptResults(
  executionId: string,
  d: Db,
): Promise<{
  attempts: AttemptResult[];
  validConfidences: number[];
  validCount: number;
  totalCount: number;
  terminalCount: number;
}> {
  const attemptRows = await d
    .select({
      id: evaluationJudgeAttempts.id,
      status: evaluationJudgeAttempts.status,
    })
    .from(evaluationJudgeAttempts)
    .where(eq(evaluationJudgeAttempts.executionId, executionId));

  const attempts: AttemptResult[] = [];
  const validConfidences: number[] = [];
  let validCount = 0;
  let terminalCount = 0;

  for (const a of attemptRows) {
    if (ATTEMPT_TERMINAL.has(a.status)) terminalCount++;
    const valid = a.status === "completed";

    if (valid) validCount++;

    const critRows = await d
      .select({
        criterionId: evaluationCriterionResults.criterionId,
        state: evaluationCriterionResults.state,
        score: evaluationCriterionResults.score,
        confidence: evaluationCriterionResults.confidence,
      })
      .from(evaluationCriterionResults)
      .where(eq(evaluationCriterionResults.attemptId, a.id));

    const criteria: AttemptResult["criteria"] = {};

    for (const c of critRows) {
      criteria[c.criterionId] = {
        state: c.state as AttemptResult["criteria"][string]["state"],
        score: c.score === null ? null : Number(c.score),
      };
      if (valid && c.confidence !== null) {
        validConfidences.push(Number(c.confidence));
      }
    }

    attempts.push({ attemptId: a.id, valid, criteria });
  }

  return {
    attempts,
    validConfidences,
    validCount,
    totalCount: attemptRows.length,
    terminalCount,
  };
}

async function objectiveGatingFailed(
  executionId: string,
  gateCheckIds: Set<string>,
  d: Db,
): Promise<boolean> {
  if (gateCheckIds.size === 0) return false;

  const failed = await d
    .select({
      checkId: evaluationObjectiveCheckRuns.checkId,
      status: evaluationObjectiveCheckRuns.status,
    })
    .from(evaluationObjectiveCheckRuns)
    .where(eq(evaluationObjectiveCheckRuns.executionId, executionId));

  return failed.some(
    (r) => gateCheckIds.has(r.checkId) && r.status === "failed",
  );
}

interface ExecutionRow {
  id: string;
  studyId: string;
  status: string;
  version: number;
  methodRevisionId: string | null;
  judgePolicySnapshot: EvaluationExecutionJudgePolicySnapshot | null;
  aggregationPolicySnapshot: EvaluationExecutionAggregationPolicySnapshot | null;
}

async function loadExecution(
  executionId: string,
  d: Db,
): Promise<ExecutionRow> {
  const [row] = await d
    .select({
      id: evaluationExecutions.id,
      studyId: evaluationExecutions.studyId,
      status: evaluationExecutions.status,
      version: evaluationExecutions.version,
      methodRevisionId: evaluationExecutions.methodRevisionId,
      judgePolicySnapshot: evaluationExecutions.judgePolicySnapshot,
      aggregationPolicySnapshot: evaluationExecutions.aggregationPolicySnapshot,
    })
    .from(evaluationExecutions)
    .where(eq(evaluationExecutions.id, executionId));

  if (!row) {
    throw new MaisterError(
      "PRECONDITION",
      `evaluation execution not found: ${executionId}`,
    );
  }

  return {
    ...row,
    // Opaque jsonb Records; startEvaluationExecution is the only writer and it
    // stores exactly these typed shapes.
    judgePolicySnapshot:
      row.judgePolicySnapshot as EvaluationExecutionJudgePolicySnapshot | null,
    aggregationPolicySnapshot:
      row.aggregationPolicySnapshot as EvaluationExecutionAggregationPolicySnapshot | null,
  };
}

// Panel-completion gate (D4): `judging -> aggregating` fires when the valid
// (completed) attempt count meets quorum OR every attempt is terminal. Idempotent
// — a call while not in `judging`, or before the panel is ready, is a no-op.
// Returns whether the panel advanced (and aggregation ran).
export async function evaluateAndAdvancePanel(
  executionId: string,
  db?: Db,
): Promise<boolean> {
  const d = db ?? getDb();
  const exec = await loadExecution(executionId, d);

  if (exec.status !== "judging") return false;

  const method = await loadMethodConfig(exec, d);

  if (!method) return false;

  const loaded = await loadAttemptResults(executionId, d);

  // Pairwise: `method.quorum` is the PER-MATCH quorum, decided at aggregation —
  // the scalar total-quorum short-circuit would advance before every match has
  // its picks. Wait for all attempts terminal; the tournament then resolves each
  // match (unmet-quorum matches stay unresolved → partial).
  const isPairwise = method.algorithm === PAIRWISE_TOURNAMENT_ALGORITHM;
  const quorumMet = !isPairwise && loaded.validCount >= method.quorum;
  const allTerminal =
    loaded.totalCount > 0 && loaded.terminalCount === loaded.totalCount;

  if (!quorumMet && !allTerminal) return false;

  // Claim judging -> aggregating (short, non-cancellable computational state).
  await advanceExecution(
    {
      studyId: exec.studyId,
      executionId,
      from: "judging",
      to: "aggregating",
      expectedVersion: exec.version,
      payload: { validCount: loaded.validCount, quorumMet },
    },
    d,
  );

  await runAggregationForExecution(executionId, d);

  return true;
}

// The `aggregating`-state handler: compute the deterministic aggregate, classify
// disagreement, persist an append-only aggregate row, and take the exact terminal
// edge — completed (valid + no review), review_required (disagreement/escalation),
// or partial (quorum unmet but policy permits). Never overwrites raw attempts.
export async function runAggregationForExecution(
  executionId: string,
  db?: Db,
): Promise<void> {
  const d = db ?? getDb();
  const exec = await loadExecution(executionId, d);

  if (exec.status !== "aggregating") {
    throw new MaisterError(
      "CONFLICT",
      `execution ${executionId} is ${exec.status}, not aggregating`,
    );
  }

  const method = await loadMethodConfig(exec, d);

  if (!method) {
    throw new MaisterError(
      "PRECONDITION",
      `execution ${executionId} has no aggregation config (no policy snapshot and no method revision)`,
    );
  }

  // Pairwise executions aggregate through the tournament, never the scalar
  // combine (ADR-147). Resolve each match under the per-match quorum, persist the
  // ranking, and take the terminal edge — completed when every match resolved,
  // else partial (quorum shortfall). No disagreement/review lane in v1.
  if (method.algorithm === PAIRWISE_TOURNAMENT_ALGORITHM) {
    const tournament = await computeTournamentForExecution(
      { executionId, studyId: exec.studyId, quorum: method.quorum },
      d,
    );

    await persistTournamentAggregate(
      {
        executionId,
        result: tournament,
        methodDigests: {
          definitionDigest: method.definitionDigest,
          schemaDigest: method.schemaDigest,
        },
      },
      d,
    );

    const to = tournament.unresolvedMatchCount > 0 ? "partial" : "completed";
    const fresh = await loadExecution(executionId, d);

    await advanceExecution(
      {
        studyId: exec.studyId,
        executionId,
        from: "aggregating",
        to,
        expectedVersion: fresh.version,
        patch:
          to === "partial" ? { terminalReason: "quorum_not_met" } : undefined,
        payload: {
          unresolvedMatchCount: tournament.unresolvedMatchCount,
          rankingTop: tournament.standings[0]?.participantId ?? null,
        },
      },
      d,
    );

    log.info(
      {
        executionId,
        to,
        unresolvedMatchCount: tournament.unresolvedMatchCount,
        matches: tournament.matches.length,
      },
      "pairwise tournament aggregation completed",
    );

    return;
  }

  const loaded = await loadAttemptResults(executionId, d);

  const result = computeAggregate({
    algorithm: method.algorithm,
    quorum: method.quorum,
    criteria: method.criteria,
    attempts: loaded.attempts,
    totalMax: method.totalMax,
  });

  const topCriterionValue = result.perCriterion
    .map((c) => c.displayValue)
    .filter((v): v is number => v !== null)
    .reduce<number | null>(
      (max, v) => (max === null || v > max ? v : max),
      null,
    );

  const gatingFailed = await objectiveGatingFailed(
    executionId,
    method.gateCheckIds,
    d,
  );

  const disagreement = classifyDisagreement({
    perCriterion: result.perCriterion,
    attemptConfidences: loaded.validConfidences,
    validAttemptCount: loaded.validCount,
    expectedAttemptCount: loaded.totalCount,
    objectiveGatingFailed: gatingFailed,
    topCriterionValue,
    criterionScaleMax: method.criterionScaleMax,
  });

  await persistAggregate(
    {
      executionId,
      result,
      disagreement,
      methodDigests: {
        definitionDigest: method.definitionDigest,
        schemaDigest: method.schemaDigest,
      },
    },
    d,
  );

  const to = disagreement.reviewRequired
    ? "review_required"
    : result.quorumMet
      ? "completed"
      : "partial";

  const fresh = await loadExecution(executionId, d);

  // ONE transaction for the terminal edge + its review row: a crash between
  // them must never leave a review_required execution with no review to
  // resolve. openReview accepts the tx as its db parameter (savepoint-nested).
  await d.transaction(async (tx: Db) => {
    await advanceExecution(
      {
        studyId: exec.studyId,
        executionId,
        from: "aggregating",
        to,
        expectedVersion: fresh.version,
        patch:
          to === "partial" ? { terminalReason: "quorum_not_met" } : undefined,
        payload: {
          level: disagreement.level,
          quorumMet: result.quorumMet,
        },
      },
      tx,
    );

    if (disagreement.reviewRequired) {
      await openReview(
        {
          studyId: exec.studyId,
          executionId,
          kind: disagreement.signals.objectiveContradiction
            ? "escalation"
            : "disagreement",
          flags: disagreement.signals as unknown as Record<string, unknown>,
        },
        tx,
      );
    }
  });

  log.info(
    {
      executionId,
      to,
      level: disagreement.level,
      quorumMet: result.quorumMet,
    },
    "evaluation aggregation completed",
  );
}
