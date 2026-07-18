import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { resolveProject } from "@/lib/api/project-route-helpers";
import {
  addObservedParticipants,
  getStudyForProject,
  listParticipants,
} from "@/lib/evaluations/studies";
import { toParticipantDto } from "@/lib/evaluations/study-dtos";
import { MaisterError } from "@/lib/errors";
import {
  evalErrorResponse,
  parseEvalJson,
} from "@/lib/evaluations/route-helpers";

const log = pino({
  name: "api-project-eval-participants",
  level: process.env.LOG_LEVEL ?? "info",
});

const addParticipantsBodySchema = z
  .object({
    runIds: z.array(z.string().min(1)).min(1),
    labels: z.record(z.string(), z.string()).optional(),
  })
  .strict();

type RouteParams = { params: Promise<{ slug: string; studyId: string }> };

// GET the Study's participants (readEvaluationStudies).
export async function GET(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    // Auth-first (repo convention, see tasks route): establish the session
    // BEFORE resolving the slug so unauthenticated callers cannot probe
    // project existence. Project membership is enforced below.
    await requireActiveSession();

    const { slug, studyId } = await params;
    const project = await resolveProject(slug);

    await requireProjectAction(project.id, "readEvaluationStudies");
    await getStudyForProject({ studyId, projectId: project.id });

    const participants = (await listParticipants(studyId)).map(
      toParticipantDto,
    );

    return NextResponse.json({ participants });
  } catch (err) {
    return evalErrorResponse(err, log);
  }
}

// POST — add observed Run participants (manageEvaluationStudies). Each run is
// validated to belong to the study's task+project and be a flow run; an observed
// participant NEVER gains launch semantics/holds (D3).
export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    await requireActiveSession();

    const { slug, studyId } = await params;
    const project = await resolveProject(slug);

    await requireProjectAction(project.id, "manageEvaluationStudies");
    await getStudyForProject({ studyId, projectId: project.id });

    const parsed = addParticipantsBodySchema.safeParse(
      await parseEvalJson(req),
    );

    if (!parsed.success) {
      throw new MaisterError(
        "CONFIG",
        `invalid POST body: ${parsed.error.message}`,
      );
    }

    const participants = (
      await addObservedParticipants({
        studyId,
        runIds: parsed.data.runIds,
        labels: parsed.data.labels,
      })
    ).map(toParticipantDto);

    return NextResponse.json({ participants }, { status: 201 });
  } catch (err) {
    return evalErrorResponse(err, log);
  }
}
