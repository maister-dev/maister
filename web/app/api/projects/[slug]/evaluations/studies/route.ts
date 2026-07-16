import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireProjectAction } from "@/lib/authz";
import { resolveProject } from "@/lib/api/project-route-helpers";
import { createStudy, listStudies } from "@/lib/evaluations/studies";
import { toStudyDto } from "@/lib/evaluations/study-dtos";
import { MaisterError } from "@/lib/errors";
import {
  evalErrorResponse,
  parseEvalJson,
} from "@/lib/evaluations/route-helpers";

const log = pino({
  name: "api-project-eval-studies",
  level: process.env.LOG_LEVEL ?? "info",
});

const createStudyBodySchema = z
  .object({
    taskId: z.string().min(1),
    title: z.string().min(1).max(300),
    purpose: z.string().max(4000).nullable().optional(),
  })
  .strict();

type RouteParams = { params: Promise<{ slug: string }> };

// GET — list the project's Studies (readEvaluationStudies, viewer).
export async function GET(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    const { slug } = await params;
    const project = await resolveProject(slug);

    await requireProjectAction(project.id, "readEvaluationStudies");

    const studies = (await listStudies(project.id)).map(toStudyDto);

    return NextResponse.json({ studies });
  } catch (err) {
    return evalErrorResponse(err, log);
  }
}

// POST — create a Study (manageEvaluationStudies, member). taskId is validated
// against the slug-derived project inside createStudy (cross-project rejected).
export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    const { slug } = await params;
    const project = await resolveProject(slug);
    const access = await requireProjectAction(
      project.id,
      "manageEvaluationStudies",
    );

    const parsed = createStudyBodySchema.safeParse(await parseEvalJson(req));

    if (!parsed.success) {
      throw new MaisterError(
        "CONFIG",
        `invalid POST body: ${parsed.error.message}`,
      );
    }

    const study = await createStudy({
      projectId: project.id,
      taskId: parsed.data.taskId,
      title: parsed.data.title,
      purpose: parsed.data.purpose ?? null,
      createdByUserId: access.user.id,
    });

    return NextResponse.json({ study: toStudyDto(study) }, { status: 201 });
  } catch (err) {
    return evalErrorResponse(err, log);
  }
}
