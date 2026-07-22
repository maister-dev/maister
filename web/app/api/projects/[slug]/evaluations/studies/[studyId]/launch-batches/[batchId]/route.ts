import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { resolveProject } from "@/lib/api/project-route-helpers";
import { getStudyForProject } from "@/lib/evaluations/studies";
import { getLaunchBatchForStudy } from "@/lib/evaluations/launch-batch";
import { evalErrorResponse } from "@/lib/evaluations/route-helpers";

const log = pino({
  name: "api-project-eval-launch-batch",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = {
  params: Promise<{ slug: string; studyId: string; batchId: string }>;
};

// GET — a launch batch with its per-item state (launchEvaluationRuns). Batch
// progress is polled here; it is deliberately not on the study SSE channel.
export async function GET(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    await requireActiveSession();

    const { slug, studyId, batchId } = await params;
    const project = await resolveProject(slug);

    await requireProjectAction(project.id, "launchEvaluationRuns");
    await getStudyForProject({ studyId, projectId: project.id });

    const batch = await getLaunchBatchForStudy({ studyId, batchId });

    return NextResponse.json(batch);
  } catch (err) {
    return evalErrorResponse(err, log);
  }
}
