import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireProjectAction } from "@/lib/authz";
import { resolveProject } from "@/lib/api/project-route-helpers";
import { getStudyForProject } from "@/lib/evaluations/studies";
import { listVerdicts, recordVerdict } from "@/lib/evaluations/verdicts";
import { MaisterError } from "@/lib/errors";
import {
  evalErrorResponse,
  parseEvalJson,
} from "@/lib/evaluations/route-helpers";

const log = pino({
  name: "api-project-eval-verdicts",
  level: process.env.LOG_LEVEL ?? "info",
});

const recordVerdictBodySchema = z
  .object({
    outcome: z.enum(["winner", "tie", "inconclusive"]),
    participantIds: z.array(z.string().min(1)),
    executionIds: z.array(z.string().min(1)),
    noEvaluationEvidenceAck: z.boolean().optional(),
    rationale: z.string().max(8000).nullable().optional(),
    acknowledgedWarnings: z.array(z.string()).optional(),
    supersedesId: z.string().min(1).nullable().optional(),
  })
  .strict();

type RouteParams = { params: Promise<{ slug: string; studyId: string }> };

// GET the Study's append-only human verdict history (readEvaluationStudies).
export async function GET(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    const { slug, studyId } = await params;
    const project = await resolveProject(slug);

    await requireProjectAction(project.id, "readEvaluationStudies");
    await getStudyForProject({ studyId, projectId: project.id });

    return NextResponse.json({ verdicts: await listVerdicts(studyId) });
  } catch (err) {
    return evalErrorResponse(err, log);
  }
}

// POST — record an append-only conclusive human verdict (concludeEvaluationStudy,
// member). This is a SESSION route, so the actor is always a human — a judge/agent
// ext token can never reach it. The verdict cites terminal executions only, needs
// the no-evaluation-evidence ack for a zero-citation, and causes NO Run status
// change / promotion / abandon (D14, enforced in recordVerdict).
export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    const { slug, studyId } = await params;
    const project = await resolveProject(slug);
    const access = await requireProjectAction(
      project.id,
      "concludeEvaluationStudy",
    );

    await getStudyForProject({ studyId, projectId: project.id });

    const parsed = recordVerdictBodySchema.safeParse(await parseEvalJson(req));

    if (!parsed.success) {
      throw new MaisterError(
        "CONFIG",
        `invalid POST body: ${parsed.error.message}`,
      );
    }

    const result = await recordVerdict({
      studyId,
      outcome: parsed.data.outcome,
      participantIds: parsed.data.participantIds,
      executionIds: parsed.data.executionIds,
      noEvaluationEvidenceAck: parsed.data.noEvaluationEvidenceAck,
      rationale: parsed.data.rationale,
      acknowledgedWarnings: parsed.data.acknowledgedWarnings,
      supersedesId: parsed.data.supersedesId,
      createdByUserId: access.user.id,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return evalErrorResponse(err, log);
  }
}
