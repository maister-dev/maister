import "server-only";

import type { EvaluationReviewKind } from "@/lib/evaluations/types";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import { appendEvaluationEvent } from "./dispatcher/events";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

// FIXME(any): schema-module bridge (matches lib/evaluations/config.ts).
const { evaluationReviews, evaluationExecutions } =
  schemaModule as unknown as Record<string, any>;

// FIXME(any): narrow this injected database seam to its operations.
type Db = any;

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

// Resolve a review with an optimistic-revision CAS (If-Match). A stale revision
// loses as CONFLICT (409), never a raw error. Records reviewer, resolution,
// rationale, and an optional adjudicated result; emits `review.resolved`.
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
