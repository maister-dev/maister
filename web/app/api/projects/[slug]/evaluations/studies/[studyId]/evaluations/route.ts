import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { resolveProject } from "@/lib/api/project-route-helpers";
import { startEvaluationExecution } from "@/lib/evaluations/dispatcher/start";
import { kickEvaluationDispatch } from "@/lib/evaluations/dispatcher/tick";
import { getStudyForProject } from "@/lib/evaluations/studies";
import { MaisterError } from "@/lib/errors";
import {
  evalErrorResponse,
  parseEvalJson,
} from "@/lib/evaluations/route-helpers";

const log = pino({
  name: "api-project-eval-start",
  level: process.env.LOG_LEVEL ?? "info",
});

const startBodySchema = z
  .object({
    profileId: z.string().min(1),
    // Per-Study overrides are allow-list-scoped in resolveEffectiveProfile; the
    // route only forwards them (a forbidden/out-of-bound value is a typed CONFIG).
    studyOverrides: z.record(z.string(), z.unknown()).optional(),
    idempotencyKey: z.string().min(1).max(200).optional(),
  })
  .strict();

type RouteParams = { params: Promise<{ slug: string; studyId: string }> };

// POST — start an Evaluation Execution for the Study (launchEvaluationRuns,
// member). A SESSION route: the actor is always human. Resolves + snapshots the
// effective profile, queues the execution, and fires an immediate in-process
// dispatch kick so the FSM starts without waiting for the 60s cron. The dispatch
// itself launches judges / captures evidence — this route only enqueues.
export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    // Auth-first (repo convention, see tasks route): establish the session
    // BEFORE resolving the slug so unauthenticated callers cannot probe
    // project existence. Project membership is enforced below.
    await requireActiveSession();

    const { slug, studyId } = await params;
    const project = await resolveProject(slug);
    const access = await requireProjectAction(
      project.id,
      "launchEvaluationRuns",
    );

    // Ownership guard: a cross-project studyId is hidden as 404 before any start.
    await getStudyForProject({ studyId, projectId: project.id });

    const parsed = startBodySchema.safeParse(await parseEvalJson(req));

    if (!parsed.success) {
      throw new MaisterError(
        "CONFIG",
        `invalid POST body: ${parsed.error.message}`,
      );
    }

    // Idempotency-Key header is the canonical carrier (repo convention, see
    // scheduled-launches); the body field stays as a fallback.
    const headerKey = req.headers.get("Idempotency-Key");

    if (
      headerKey !== null &&
      (headerKey.length < 1 || headerKey.length > 200)
    ) {
      throw new MaisterError(
        "CONFIG",
        "Idempotency-Key header must be 1-200 characters",
      );
    }

    const result = await startEvaluationExecution({
      studyId,
      projectId: project.id,
      profileId: parsed.data.profileId,
      studyOverrides: parsed.data.studyOverrides,
      idempotencyKey: headerKey ?? parsed.data.idempotencyKey ?? null,
      requestedByUserId: access.user.id,
    });

    if (!result.deduped) kickEvaluationDispatch();

    return NextResponse.json(result, { status: result.deduped ? 200 : 201 });
  } catch (err) {
    return evalErrorResponse(err, log);
  }
}
