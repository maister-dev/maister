import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireProjectAction } from "@/lib/authz";
import { resolveProject } from "@/lib/api/project-route-helpers";
import {
  getStudyForProject,
  patchStudy,
} from "@/lib/evaluations/studies";
import { toStudyDto } from "@/lib/evaluations/study-dtos";
import { MaisterError } from "@/lib/errors";
import {
  evalErrorResponse,
  parseEvalJson,
  requireIfMatchRevision,
} from "@/lib/evaluations/route-helpers";

const log = pino({
  name: "api-project-eval-study",
  level: process.env.LOG_LEVEL ?? "info",
});

const patchStudyBodySchema = z
  .object({
    title: z.string().min(1).max(300).optional(),
    purpose: z.string().max(4000).nullable().optional(),
  })
  .strict()
  .refine((b) => b.title !== undefined || b.purpose !== undefined, {
    message: "at least one of title/purpose is required",
  });

type RouteParams = { params: Promise<{ slug: string; studyId: string }> };

// GET one Study (readEvaluationStudies). Cross-project id hidden as 404.
export async function GET(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    const { slug, studyId } = await params;
    const project = await resolveProject(slug);

    await requireProjectAction(project.id, "readEvaluationStudies");

    const study = await getStudyForProject({ studyId, projectId: project.id });

    return NextResponse.json({ study: toStudyDto(study) });
  } catch (err) {
    return evalErrorResponse(err, log);
  }
}

// PATCH title/purpose with mandatory If-Match optimistic revision
// (manageEvaluationStudies). Stale revision → 409; ownership guarded first.
export async function PATCH(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    const { slug, studyId } = await params;
    const project = await resolveProject(slug);

    await requireProjectAction(project.id, "manageEvaluationStudies");
    // Ownership guard before any write — a cross-project studyId is 404.
    await getStudyForProject({ studyId, projectId: project.id });

    const expectedVersion = requireIfMatchRevision(req);
    const parsed = patchStudyBodySchema.safeParse(await parseEvalJson(req));

    if (!parsed.success) {
      throw new MaisterError(
        "CONFIG",
        `invalid PATCH body: ${parsed.error.message}`,
      );
    }

    const study = await patchStudy({
      studyId,
      expectedVersion,
      title: parsed.data.title,
      purpose: parsed.data.purpose,
    });

    return NextResponse.json({ study: toStudyDto(study) });
  } catch (err) {
    return evalErrorResponse(err, log);
  }
}
