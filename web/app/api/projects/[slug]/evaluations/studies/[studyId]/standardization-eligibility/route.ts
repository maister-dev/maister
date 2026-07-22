import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { resolveProject } from "@/lib/api/project-route-helpers";
import { getStudyForProject } from "@/lib/evaluations/studies";
import { livePreflightLoaders } from "@/lib/evaluations/preflight-loaders";
import {
  checkStandardizationEligible,
  toStandardizationEligibilityDto,
} from "@/lib/evaluations/standardization";
import { evalErrorResponse } from "@/lib/evaluations/route-helpers";

const log = pino({
  name: "api-project-eval-standardization-eligibility",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ slug: string; studyId: string }> };

// GET — preview whether a Study's winner can be standardized
// (manageProjectEvaluationOverrides, admin; study-ownership guarded). Phase 1:
// NO side effect. Runs a FRESH preflight so eligibility reflects live contracts.
export async function GET(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    await requireActiveSession();

    const { slug, studyId } = await params;
    const project = await resolveProject(slug);

    await requireProjectAction(project.id, "manageProjectEvaluationOverrides");
    await getStudyForProject({ studyId, projectId: project.id });

    const eligibility = await checkStandardizationEligible(
      { studyId, projectId: project.id },
      livePreflightLoaders(),
    );

    log.info(
      { studyId, eligible: eligibility.eligible },
      "standardization eligibility evaluated",
    );

    return NextResponse.json(toStandardizationEligibilityDto(eligibility));
  } catch (err) {
    return evalErrorResponse(err, log);
  }
}
