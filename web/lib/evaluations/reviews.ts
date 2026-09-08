import "server-only";

import type { AggregateResult } from "./aggregation/algorithms";
import type { DisagreementResult } from "./aggregation/disagreement";
import type { Db } from "@/lib/evaluations/db";
import type { EvaluationReviewKind } from "@/lib/evaluations/types";

import { and, desc, eq } from "drizzle-orm";
import pino from "pino";

import { persistAggregate } from "./aggregation/persist";
import { advanceExecution } from "./dispatcher/advance";
import { appendEvaluationEvent } from "./dispatcher/events";

import { getDb } from "@/lib/db/client";
import {
  evaluationAggregateResults,
  evaluationExecutions,
  evaluationMethodRevisions,
  evaluationReviews,
  evaluationStudies,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "evaluations-reviews",
  level: process.env.LOG_LEVEL ?? "info",
});

// Open a durable disagreement/escalation review for an execution (D13). Emitted
// by the aggregation worker when disagreement requires human adjudication.
export async function openReview(
  args: {
    studyId: string;
    executionId: string;
    kind: EvaluationReviewKind;
    flags?: Record<string, unknown>;
  },
  db?: Db,
): Promise<{ id: string; sequence: number }> {
  const d = db ?? getDb();

  return d.transaction(async (tx: Db) => {
    const [row] = await tx
      .insert(evaluationReviews)
      .values({
        executionId: args.executionId,
        kind: args.kind,
        status: "required",
        flags: args.flags ?? null,
      })
      .returning({ id: evaluationReviews.id });

    const { sequence } = await appendEvaluationEvent(tx, {
      studyId: args.studyId,
      executionId: args.executionId,
      eventType: "review.required",
      payload: { reviewId: row.id, kind: args.kind },
    });

    return { id: row.id, sequence };
  });
}

// The adjudicated aggregate revision records the human settlement — the
// disagreement is resolved by fiat, so its dispersion carries no live signals.
const ADJUDICATED_DISAGREEMENT: DisagreementResult = {
  level: "none",
  reviewRequired: false,
  signals: {
    maxScoreSpread: null,
    confidenceSpread: null,
    insufficientAsymmetry: false,
    objectiveContradiction: false,
    panelIncomplete: false,
  },
};

// Structural guard: an adjudicated result is persisted as a NEW aggregate
// revision only when it is a well-formed AggregateResult; an arbitrary
// notes-shaped record stays on the review row (evaluation_reviews
// .adjudicated_result) only — never fabricated into calculations.
function asAdjudicatedAggregate(
  value: Record<string, unknown> | null | undefined,
): AggregateResult | null {
  if (!value) return null;
  if (typeof value.algorithm !== "string" || !value.algorithm.includes("@")) {
    return null;
  }
  if (
    typeof value.quorum !== "number" ||
    typeof value.quorumMet !== "boolean"
  ) {
    return null;
  }
  if (
    !Array.isArray(value.includedAttemptIds) ||
    !Array.isArray(value.perCriterion) ||
    !Array.isArray(value.excludedAttempts)
  ) {
    return null;
  }

  return value as unknown as AggregateResult;
}

async function resolveMethodDigests(
  tx: Db,
  methodRevisionId: string | null,
  latestAggregateInputs: Record<string, unknown> | null,
): Promise<{ definitionDigest: string; schemaDigest: string } | null> {
  if (methodRevisionId) {
    const [rev] = await tx
      .select({
        definitionDigest: evaluationMethodRevisions.definitionDigest,
        schemaDigest: evaluationMethodRevisions.schemaDigest,
      })
      .from(evaluationMethodRevisions)
      .where(eq(evaluationMethodRevisions.id, methodRevisionId));

    if (rev) return rev;
  }

  // Legacy execution without a method revision: reuse the digests the prior
  // aggregate revision was bound to (persistAggregate stores them in inputs).
  const inputs = latestAggregateInputs as {
    methodDefinitionDigest?: unknown;
    methodSchemaDigest?: unknown;
  } | null;

  if (
    typeof inputs?.methodDefinitionDigest === "string" &&
    typeof inputs?.methodSchemaDigest === "string"
  ) {
    return {
      definitionDigest: inputs.methodDefinitionDigest,
      schemaDigest: inputs.methodSchemaDigest,
    };
  }

  return null;
}

// Execute the FSM's `review_required -> completed|partial` edge for a resolved
// review — the ONLY driver of those edges, and it runs in the SAME transaction
// as the review-row update so an adjudicated execution can never stay
// non-terminal (citability requires completed|partial, see verdicts.ts).
//
// Terminal mapping (documented contract): the human resolves the DISAGREEMENT,
// not the evidentiary sufficiency — quorum decides the terminal:
//   1. a well-formed adjudicated AggregateResult carries its own quorumMet
//      (completed when true, partial when false), and is persisted as a NEW
//      append-only aggregate revision;
//   2. else the latest persisted aggregate revision's quorum.quorumMet;
//   3. else (no aggregate at all — crash/legacy artifact) `partial`, never a
//      fabricated `completed`.
// An execution that is no longer review_required (a second review on an
// already-adjudicated execution, or a legacy review on a terminal row) skips
// the advance — the review row still resolves.
async function advanceAdjudicatedExecution(
  tx: Db,
  args: {
    executionId: string;
    reviewId: string;
    adjudicatedResult: Record<string, unknown> | null;
  },
): Promise<void> {
  const [exec] = await tx
    .select({
      studyId: evaluationExecutions.studyId,
      status: evaluationExecutions.status,
      version: evaluationExecutions.version,
      methodRevisionId: evaluationExecutions.methodRevisionId,
    })
    .from(evaluationExecutions)
    .where(eq(evaluationExecutions.id, args.executionId));

  if (!exec) return;

  if (exec.status !== "review_required") {
    log.warn(
      {
        reviewId: args.reviewId,
        executionId: args.executionId,
        status: exec.status,
      },
      "review resolved on a non-review_required execution; FSM advance skipped",
    );

    return;
  }

  const [latestAggregate] = await tx
    .select({
      quorum: evaluationAggregateResults.quorum,
      inputs: evaluationAggregateResults.inputs,
    })
    .from(evaluationAggregateResults)
    .where(eq(evaluationAggregateResults.executionId, args.executionId))
    .orderBy(desc(evaluationAggregateResults.revision))
    .limit(1);

  const adjudicated = asAdjudicatedAggregate(args.adjudicatedResult);

  if (adjudicated) {
    const methodDigests = await resolveMethodDigests(
      tx,
      exec.methodRevisionId,
      latestAggregate?.inputs ?? null,
    );

    if (methodDigests) {
      await persistAggregate(
        {
          executionId: args.executionId,
          result: adjudicated,
          disagreement: ADJUDICATED_DISAGREEMENT,
          methodDigests,
        },
        tx,
      );
    } else {
      log.warn(
        { reviewId: args.reviewId, executionId: args.executionId },
        "adjudicated aggregate not persisted as a revision — no method digests resolvable; review row keeps the adjudication",
      );
    }
  } else if (args.adjudicatedResult) {
    log.warn(
      { reviewId: args.reviewId, executionId: args.executionId },
      "adjudicated result is not a well-formed aggregate; stored on the review row only",
    );
  }

  const quorumMet = adjudicated
    ? adjudicated.quorumMet
    : (latestAggregate?.quorum as { quorumMet?: unknown } | null)?.quorumMet ===
      true;
  const to = quorumMet ? ("completed" as const) : ("partial" as const);

  await advanceExecution(
    {
      studyId: exec.studyId,
      executionId: args.executionId,
      from: "review_required",
      to,
      expectedVersion: exec.version,
      patch:
        to === "partial" ? { terminalReason: "quorum_not_met" } : undefined,
      payload: { reviewId: args.reviewId, adjudicated: adjudicated !== null },
    },
    tx,
  );
}

// Resolve a review with an optimistic-revision CAS (If-Match). A stale revision
// loses as CONFLICT (409), never a raw error. Records reviewer, resolution,
// rationale, and an optional adjudicated result; advances the execution over
// the FSM's review_required -> completed|partial edge in the SAME transaction
// (see advanceAdjudicatedExecution for the terminal mapping); emits
// `review.resolved`.
export async function resolveReview(
  args: {
    reviewId: string;
    expectedRevision: number;
    reviewerUserId: string;
    resolution: string;
    rationale?: string | null;
    adjudicatedResult?: Record<string, unknown> | null;
    studyId: string;
  },
  db?: Db,
): Promise<{ sequence: number }> {
  const d = db ?? getDb();

  return d.transaction(async (tx: Db) => {
    const updated = await tx
      .update(evaluationReviews)
      .set({
        status: "resolved",
        reviewerUserId: args.reviewerUserId,
        resolution: args.resolution,
        rationale: args.rationale ?? null,
        adjudicatedResult: args.adjudicatedResult ?? null,
        version: args.expectedRevision + 1,
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(evaluationReviews.id, args.reviewId),
          eq(evaluationReviews.status, "required"),
          eq(evaluationReviews.version, args.expectedRevision),
        ),
      )
      .returning({ executionId: evaluationReviews.executionId });

    if (updated.length === 0) {
      const [exists] = await tx
        .select({
          status: evaluationReviews.status,
          version: evaluationReviews.version,
        })
        .from(evaluationReviews)
        .where(eq(evaluationReviews.id, args.reviewId));

      if (!exists) {
        throw new MaisterError(
          "PRECONDITION",
          `review not found: ${args.reviewId}`,
        );
      }

      throw new MaisterError(
        "CONFLICT",
        `review ${args.reviewId} is ${exists.status}@v${exists.version}, not required@v${args.expectedRevision}`,
      );
    }

    await advanceAdjudicatedExecution(tx, {
      executionId: updated[0].executionId,
      reviewId: args.reviewId,
      adjudicatedResult: args.adjudicatedResult ?? null,
    });

    const { sequence } = await appendEvaluationEvent(tx, {
      studyId: args.studyId,
      executionId: updated[0].executionId,
      eventType: "review.resolved",
      payload: { reviewId: args.reviewId },
    });

    log.info(
      { reviewId: args.reviewId, reviewerUserId: args.reviewerUserId },
      "evaluation review resolved",
    );

    return { sequence };
  });
}

// Load a review scoped to a project (review → execution → study → project),
// the ownership guard for the resolve route. A missing/cross-project reviewId is
// hidden as PRECONDITION (404). Returns the review's studyId + current version so
// the caller can pass them to resolveReview without a second query.
export async function getReviewForProject(
  args: { reviewId: string; projectId: string },
  db?: Db,
): Promise<{ studyId: string; version: number; status: string }> {
  const d = db ?? getDb();
  const [row] = await d
    .select({
      studyId: evaluationExecutions.studyId,
      version: evaluationReviews.version,
      status: evaluationReviews.status,
      projectId: evaluationStudies.projectId,
    })
    .from(evaluationReviews)
    .innerJoin(
      evaluationExecutions,
      eq(evaluationReviews.executionId, evaluationExecutions.id),
    )
    .innerJoin(
      evaluationStudies,
      eq(evaluationExecutions.studyId, evaluationStudies.id),
    )
    .where(eq(evaluationReviews.id, args.reviewId));

  if (!row || row.projectId !== args.projectId) {
    throw new MaisterError(
      "PRECONDITION",
      `review not found: ${args.reviewId}`,
    );
  }

  return { studyId: row.studyId, version: row.version, status: row.status };
}

export async function listReviews(
  executionId: string,
  db?: Db,
): Promise<Record<string, unknown>[]> {
  const d = db ?? getDb();

  return d
    .select()
    .from(evaluationReviews)
    .where(eq(evaluationReviews.executionId, executionId));
}

// Guard used by callers that need the execution's study for event routing.
export async function studyIdForExecution(
  executionId: string,
  db?: Db,
): Promise<string> {
  const d = db ?? getDb();
  const [row] = await d
    .select({ studyId: evaluationExecutions.studyId })
    .from(evaluationExecutions)
    .where(eq(evaluationExecutions.id, executionId));

  if (!row) {
    throw new MaisterError(
      "PRECONDITION",
      `evaluation execution not found: ${executionId}`,
    );
  }

  return row.studyId;
}
