import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireProjectAction } from "@/lib/authz";
import { resolveProject } from "@/lib/api/project-route-helpers";
import { getReviewForProject, resolveReview } from "@/lib/evaluations/reviews";
import { MaisterError } from "@/lib/errors";
import {
  evalErrorResponse,
  parseEvalJson,
  requireIfMatchRevision,
} from "@/lib/evaluations/route-helpers";

const log = pino({
  name: "api-project-eval-review",
  level: process.env.LOG_LEVEL ?? "info",
});

const resolveReviewBodySchema = z
  .object({
    resolution: z.string().min(1).max(2000),
    rationale: z.string().max(8000).nullable().optional(),
    adjudicatedResult: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();

type RouteParams = { params: Promise<{ slug: string; reviewId: string }> };

// PATCH — resolve a disagreement/escalation review with an If-Match optimistic CAS
// (resolveEvaluationReview, admin). Ownership is guarded through the review →
// execution → study → project chain; a stale revision loses as 409.
export async function PATCH(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    const { slug, reviewId } = await params;
    const project = await resolveProject(slug);
    const access = await requireProjectAction(
      project.id,
      "resolveEvaluationReview",
    );

    const review = await getReviewForProject({
      reviewId,
      projectId: project.id,
    });

    const expectedVersion = requireIfMatchRevision(req);
    const parsed = resolveReviewBodySchema.safeParse(await parseEvalJson(req));

    if (!parsed.success) {
      throw new MaisterError(
        "CONFIG",
        `invalid PATCH body: ${parsed.error.message}`,
      );
    }

    const result = await resolveReview({
      reviewId,
      expectedRevision: expectedVersion,
      reviewerUserId: access.user.id,
      resolution: parsed.data.resolution,
      rationale: parsed.data.rationale,
      adjudicatedResult: parsed.data.adjudicatedResult,
      studyId: review.studyId,
    });

    return NextResponse.json(result);
  } catch (err) {
    return evalErrorResponse(err, log);
  }
}
