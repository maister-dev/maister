import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { resolveProject } from "@/lib/api/project-route-helpers";
import { getStudyForProject } from "@/lib/evaluations/studies";
import { livePreflightLoaders } from "@/lib/evaluations/preflight-loaders";
import {
  standardizeRecipe,
  toStandardizedRecipeDto,
} from "@/lib/evaluations/standardization";
import { MaisterError } from "@/lib/errors";
import {
  evalErrorResponse,
  parseOptionalEvalJson,
} from "@/lib/evaluations/route-helpers";

const log = pino({
  name: "api-project-eval-standardize",
  level: process.env.LOG_LEVEL ?? "info",
});

const bodySchema = z
  .object({ slot: z.string().min(1).max(64).optional() })
  .strict();

type RouteParams = { params: Promise<{ slug: string; studyId: string }> };

// POST — standardize this Study's winning recipe into the project-default slot
// (manageProjectEvaluationOverrides, admin; study-ownership guarded). Phase 2:
// human-approved, non-automatic — the service ALSO refuses a non-human actor.
// Eligibility is re-checked inside the write tx (drift → 409). No Run status
// change, no promotion.
export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    const session = await requireActiveSession();

    const { slug, studyId } = await params;
    const project = await resolveProject(slug);

    await requireProjectAction(project.id, "manageProjectEvaluationOverrides");
    await getStudyForProject({ studyId, projectId: project.id });

    const parsed = bodySchema.safeParse(await parseOptionalEvalJson(req));

    if (!parsed.success) {
      throw new MaisterError(
        "CONFIG",
        `invalid POST body: ${parsed.error.message}`,
      );
    }

    const row = await standardizeRecipe(
      {
        studyId,
        projectId: project.id,
        slot: parsed.data.slot,
        actor: { type: "user", id: session.id },
      },
      livePreflightLoaders(),
    );

    log.info(
      { studyId, slot: row.slot, revision: row.revision },
      "recipe standardized",
    );

    return NextResponse.json(toStandardizedRecipeDto(row), { status: 201 });
  } catch (err) {
    return evalErrorResponse(err, log);
  }
}
