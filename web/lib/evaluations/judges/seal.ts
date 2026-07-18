import "server-only";

import type { Db } from "@/lib/evaluations/db";
import type { TokenActor } from "@/lib/tokens/verify";

import { and, eq, inArray } from "drizzle-orm";
import pino from "pino";

import { resolveBoundAttempt, type BoundAttempt } from "./facade";
import {
  validateJudgeResult,
  type JudgeCriterionSpec,
  type SubmittedCriterion,
} from "./result-validation";

import { getDb } from "@/lib/db/client";
import {
  evaluationCriterionResults,
  evaluationJudgeAttempts,
  evaluationMethodRevisions,
} from "@/lib/db/schema";
import { sha256, stableStringify } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";
import { revokeAgentRunToken } from "@/lib/agents/tokens";

const log = pino({
  name: "evaluations-judge-seal",
  level: process.env.LOG_LEVEL ?? "info",
});

// One per-criterion cell submitted by a judge (the method result schema is an
// array of these). Converted to the flat Record the pure validator consumes.
export interface SubmittedCriterionCell extends SubmittedCriterion {
  criterionId: string;
}

export interface JudgeSubmission {
  criteria: SubmittedCriterionCell[];
}

export type SealOutcome =
  | { valid: true; attemptId: string; panelAdvanced: boolean }
  | { valid: false; attemptId: string; violations: string[] };

// Criterion specs (scale bounds + required policy) for seal validation. The
// primary source is the execution's start-time `judgePolicySnapshot.criteria` —
// frozen when the execution was created, immune to the methods-registry
// overwriting `normalizedDefinition` in place mid-execution. The method-revision
// read below is ONLY the legacy fallback for executions that predate the
// snapshot (it IS a live read and can drift — acceptable only for those rows).
function specsFromSnapshot(bound: BoundAttempt): JudgeCriterionSpec[] | null {
  const criteria = bound.judgePolicySnapshot?.criteria;

  if (!criteria?.length) return null;

  return criteria.map((c) => ({
    id: c.id,
    scaleMin: c.scaleMin,
    scaleMax: c.scaleMax,
    // A non-optional criterion is REQUIRED — an entirely-absent required
    // criterion is an invalid attempt, never a silent zero (D12).
    required: !c.optional,
  }));
}

async function loadCriterionSpecs(
  methodRevisionId: string,
  d: Db,
): Promise<JudgeCriterionSpec[]> {
  const [rev] = await d
    .select({
      normalizedDefinition: evaluationMethodRevisions.normalizedDefinition,
    })
    .from(evaluationMethodRevisions)
    .where(eq(evaluationMethodRevisions.id, methodRevisionId));

  if (!rev) {
    throw new MaisterError(
      "PRECONDITION",
      `method revision not found: ${methodRevisionId}`,
    );
  }

  const definition = (rev.normalizedDefinition?.definition ?? {}) as {
    criteria?: Array<{
      id: string;
      scale: { min: number; max: number };
      optional?: boolean;
    }>;
  };
  const criteria = definition.criteria ?? [];

  return criteria.map((c) => ({
    id: c.id,
    scaleMin: c.scale.min,
    scaleMax: c.scale.max,
    // A non-optional criterion is REQUIRED — an entirely-absent required
    // criterion is an invalid attempt, never a silent zero (D12).
    required: !c.optional,
  }));
}

// Seal a submitted judge result into an immutable attempt (D12). Strict
// validation is fail-closed: an out-of-range/unknown/missing-required criterion
// terminalizes the attempt as `invalid` (a distinct outcome, never a partial row
// masquerading as valid). A valid result writes normalized criterion rows and
// completes the attempt. The attempt token is revoked either way. After a
// terminal seal the panel-completion check may advance the execution to
// aggregating (making the judging state live).
export async function submitBoundJudgeResult(
  actor: TokenActor,
  submission: JudgeSubmission,
  db?: Db,
): Promise<SealOutcome> {
  const d = db ?? getDb();
  const bound = await resolveBoundAttempt(actor, d);

  let specs = specsFromSnapshot(bound);

  if (!specs) {
    if (!bound.methodRevisionId) {
      throw new MaisterError(
        "PRECONDITION",
        "bound execution has no method revision to validate against",
      );
    }
    specs = await loadCriterionSpecs(bound.methodRevisionId, d);
  }

  const submitted: Record<string, SubmittedCriterion> = {};

  for (const cell of submission.criteria) {
    submitted[cell.criterionId] = {
      state: cell.state,
      score: cell.score,
      rationale: cell.rationale,
      confidence: cell.confidence,
      evidenceRefs: cell.evidenceRefs,
      objectiveRefs: cell.objectiveRefs,
    };
  }

  const validation = validateJudgeResult(submitted, specs);
  const resultDigest = sha256(stableStringify(submission));

  // Terminal seals re-assert liveness INSIDE the UPDATE (CAS): a reaper-flipped
  // timed_out/cancelled attempt or a concurrent double submit must never be
  // silently overwritten to a different terminal state. 0 rows → typed CONFLICT.
  const liveStatusCas = and(
    eq(evaluationJudgeAttempts.id, bound.attemptId),
    inArray(evaluationJudgeAttempts.status, ["queued", "running"]),
  );
  const sealConflict = () =>
    new MaisterError(
      "CONFLICT",
      `judge attempt ${bound.attemptId} is no longer live — seal refused`,
    );

  if (!validation.valid) {
    const flipped = await d
      .update(evaluationJudgeAttempts)
      .set({
        status: "invalid",
        reason: validation.violations.slice(0, 20).join("; "),
        sealedResult: submission as unknown as Record<string, unknown>,
        resultDigest,
        terminalAt: new Date(),
      })
      .where(liveStatusCas)
      .returning({ id: evaluationJudgeAttempts.id });

    if (!flipped.length) throw sealConflict();

    await revokeAgentRunToken(actor.tokenId, d);

    log.warn(
      { attemptId: bound.attemptId, violations: validation.violations.length },
      "judge attempt sealed INVALID",
    );

    return {
      valid: false,
      attemptId: bound.attemptId,
      violations: validation.violations,
    };
  }

  await d.transaction(async (tx: Db) => {
    // CAS FIRST: the winner takes the row lock and terminalizes; a concurrent
    // racer blocks here, then sees a non-live status, gets 0 rows, and rolls
    // back BEFORE writing any criterion row. The (attempt, criterion,
    // participant) unique index is the belt under this suspenders.
    const claimed = await tx
      .update(evaluationJudgeAttempts)
      .set({
        status: "completed",
        sealedResult: submission as unknown as Record<string, unknown>,
        resultDigest,
        terminalAt: new Date(),
      })
      .where(liveStatusCas)
      .returning({ id: evaluationJudgeAttempts.id });

    if (!claimed.length) throw sealConflict();

    for (const c of validation.criteria) {
      await tx.insert(evaluationCriterionResults).values({
        attemptId: bound.attemptId,
        // Holistic per-criterion result (the method result schema carries no
        // participant field); a per-candidate model would set participantId.
        participantId: null,
        criterionId: c.criterionId,
        state: c.state,
        score: c.state === "scored" ? String(c.score) : null,
        rationale: c.rationale,
        confidence: c.confidence === null ? null : String(c.confidence),
        evidenceRefs: c.evidenceRefs,
        objectiveRefs: c.objectiveRefs,
      });
    }
  });

  await revokeAgentRunToken(actor.tokenId, d);

  log.info(
    { attemptId: bound.attemptId, executionId: bound.executionId },
    "judge attempt sealed COMPLETED",
  );

  const panelAdvanced = await maybeCompletePanel(bound, d);

  return { valid: true, attemptId: bound.attemptId, panelAdvanced };
}

// After each seal, decide whether the panel is done. `judging -> aggregating`
// fires when the valid-completed count meets quorum OR every attempt is terminal
// (D4). The advance + aggregation are delegated to the aggregation worker so this
// module stays free of the aggregation math. A dynamic import breaks the cycle
// (worker imports the AttemptResult adapter which lives near the aggregation
// cores, not here).
async function maybeCompletePanel(
  bound: BoundAttempt,
  d: Db,
): Promise<boolean> {
  const { evaluateAndAdvancePanel } = await import(
    "@/lib/evaluations/aggregation/worker"
  );

  return evaluateAndAdvancePanel(bound.executionId, d);
}
