import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import pino from "pino";

import { requireProjectAction } from "@/lib/authz";
import { resolveProject } from "@/lib/api/project-route-helpers";
import {
  getStudyForProject,
  removeParticipant,
} from "@/lib/evaluations/studies";
import { evalErrorResponse } from "@/lib/evaluations/route-helpers";

const log = pino({
  name: "api-project-eval-participant",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = {
  params: Promise<{ slug: string; studyId: string; participantId: string }>;
};

// DELETE — remove a participant (manageEvaluationStudies). Once referenced by a
// sealed evidence snapshot the row is tombstoned (history survives); otherwise it
// is hard-deleted. Idempotent guard: a missing participant is 404.
export async function DELETE(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    const { slug, studyId, participantId } = await params;
    const project = await resolveProject(slug);

    await requireProjectAction(project.id, "manageEvaluationStudies");
    await getStudyForProject({ studyId, projectId: project.id });

    const result = await removeParticipant({ studyId, participantId });

    return NextResponse.json(result);
  } catch (err) {
    return evalErrorResponse(err, log);
  }
}
