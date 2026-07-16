import "server-only";

import type { AggregationAlgorithm } from "@/lib/evaluations/method-schema";

import { eq } from "drizzle-orm";
import pino from "pino";

import {
  computeAggregate,
  type AggCriterion,
  type AttemptResult,
} from "./algorithms";
import { classifyDisagreement } from "./disagreement";
import { persistAggregate } from "./persist";

import { advanceExecution } from "@/lib/evaluations/dispatcher/advance";
import { openReview } from "@/lib/evaluations/reviews";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

// FIXME(any): schema-module bridge (matches lib/evaluations/config.ts).
const {
  evaluationExecutions,
  evaluationJudgeAttempts,
  evaluationCriterionResults,
  evaluationMethodRevisions,
  evaluationObjectiveCheckRuns,
} = schemaModule as unknown as Record<string, any>;

// FIXME(any): narrow this injected database seam to its operations.
type Db = any;

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

// Build the aggregation criteria + policy from the SNAPSHOTTED method revision —
// the same immutable definition the panel scored against.
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
  const attemptRows = (await d
    .select({
      id: evaluationJudgeAttempts.id,
      status: evaluationJudgeAttempts.status,
    })
    .from(evaluationJudgeAttempts)
    .where(eq(evaluationJudgeAttempts.executionId, executionId))) as Array<{
    id: string;
    status: string;
  }>;

  const attempts: AttemptResult[] = [];
  const validConfidences: number[] = [];
  let validCount = 0;
  let terminalCount = 0;

  for (const a of attemptRows) {
    if (ATTEMPT_TERMINAL.has(a.status)) terminalCount++;
    const valid = a.status === "completed";

    if (valid) validCount++;

    const critRows = (await d
      .select({
        criterionId: evaluationCriterionResults.criterionId,
        state: evaluationCriterionResults.state,
        score: evaluationCriterionResults.score,
        confidence: evaluationCriterionResults.confidence,
      })
      .from(evaluationCriterionResults)
      .where(eq(evaluationCriterionResults.attemptId, a.id))) as Array<{
      criterionId: string;
      state: string;
      score: string | null;
      confidence: string | null;
    }>;

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

  const failed = (await d
    .select({
      checkId: evaluationObjectiveCheckRuns.checkId,
      status: evaluationObjectiveCheckRuns.status,
    })
    .from(evaluationObjectiveCheckRuns)
    .where(
      eq(evaluationObjectiveCheckRuns.executionId, executionId),
    )) as Array<{
    checkId: string;
    status: string;
  }>;

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
}

async function loadExecution(
  executionId: string,
  d: Db,
): Promise<ExecutionRow> {
  const [row] = (await d
    .select({
      id: evaluationExecutions.id,
      studyId: evaluationExecutions.studyId,
      status: evaluationExecutions.status,
      version: evaluationExecutions.version,
      methodRevisionId: evaluationExecutions.methodRevisionId,
    })
    .from(evaluationExecutions)
    .where(eq(evaluationExecutions.id, executionId))) as ExecutionRow[];

  if (!row) {
    throw new MaisterError(
      "PRECONDITION",
      `evaluation execution not found: ${executionId}`,
    );
  }

  return row;
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
  if (!exec.methodRevisionId) return false;

  const method = await loadMethod(exec.methodRevisionId, d);
  const loaded = await loadAttemptResults(executionId, d);

  const quorumMet = loaded.validCount >= method.quorum;
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
  if (!exec.methodRevisionId) {
    throw new MaisterError(
      "PRECONDITION",
      `execution ${executionId} has no method revision`,
    );
  }

  const method = await loadMethod(exec.methodRevisionId, d);
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
    d,
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
      d,
    );
  }

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
