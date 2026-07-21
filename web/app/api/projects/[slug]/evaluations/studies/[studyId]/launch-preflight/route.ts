import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { resolveProject } from "@/lib/api/project-route-helpers";
import { getStudyForProject } from "@/lib/evaluations/studies";
import { livePreflightLoaders } from "@/lib/evaluations/preflight-loaders";
import { preflightStudyRecipe } from "@/lib/evaluations/recipes";
import { MaisterError } from "@/lib/errors";
import {
  evalErrorResponse,
  parseEvalJson,
} from "@/lib/evaluations/route-helpers";

const log = pino({
  name: "api-project-eval-launch-preflight",
  level: process.env.LOG_LEVEL ?? "info",
});

const bodySchema = z
  .object({
    recipes: z.array(z.unknown()).min(1).max(32),
  })
  .strict();

type RouteParams = { params: Promise<{ slug: string; studyId: string }> };

// POST — preflight one or more controlled recipes against live contracts
// (launchEvaluationRuns). PURE: no side effect, nothing persisted. Returns every
// typed refusal/warning verbatim so the launch dialog can render them; the same
// core runs again at launch (ADR-149, ADR-146 D16).
export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    await requireActiveSession();

    const { slug, studyId } = await params;
    const project = await resolveProject(slug);

    await requireProjectAction(project.id, "launchEvaluationRuns");
    await getStudyForProject({ studyId, projectId: project.id });

    const parsed = bodySchema.safeParse(await parseEvalJson(req));

    if (!parsed.success) {
      throw new MaisterError(
        "CONFIG",
        `invalid POST body: ${parsed.error.message}`,
      );
    }

    const loaders = livePreflightLoaders();
    const results = await Promise.all(
      parsed.data.recipes.map((definition) =>
        preflightStudyRecipe(
          { studyId, projectId: project.id, definition },
          loaders,
        ),
      ),
    );

    log.info(
      {
        studyId,
        recipeCount: results.length,
        ok: results.every((r) => r.ok),
      },
      "controlled recipe launch-preflight evaluated",
    );

    return NextResponse.json({ results });
  } catch (err) {
    return evalErrorResponse(err, log);
  }
}
