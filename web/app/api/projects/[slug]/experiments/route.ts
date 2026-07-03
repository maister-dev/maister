import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import {
  errorResponse,
  notFoundResponse,
  resolveProject,
} from "@/lib/api/project-route-helpers";
import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { MaisterError } from "@/lib/errors";
import { createExperimentInputSchema } from "@/lib/experiments/http-schemas";
import {
  createExperiment,
  listProjectExperiments,
} from "@/lib/experiments/service";

const log = pino({
  name: "api-project-experiments",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ slug: string }> };

function bodyErrorResponse(err: unknown): NextResponse {
  return NextResponse.json(
    {
      code: "CONFIG",
      message: `invalid POST body: ${(err as Error).message}`,
    },
    { status: 422 },
  );
}

export async function GET(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;

  try {
    await requireActiveSession();

    const project = await resolveProject(slug);

    await requireProjectAction(project.id, "readExperiments");

    const experiments = await listProjectExperiments(project.id);

    return NextResponse.json({ experiments });
  } catch (err) {
    return errorResponse(err, log, slug);
  }
}

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;

  try {
    const user = await requireActiveSession();
    const project = await resolveProject(slug);

    await requireProjectAction(project.id, "manageExperiments");

    const parsed = createExperimentInputSchema.safeParse(await req.json());

    if (!parsed.success) return bodyErrorResponse(parsed.error);

    const experiment = await createExperiment({
      projectId: project.id,
      slug,
      actorUserId: user.id,
      input: parsed.data,
    });

    return NextResponse.json(experiment, { status: 201 });
  } catch (err) {
    if (err instanceof SyntaxError) {
      return bodyErrorResponse(err);
    }

    if (err instanceof MaisterError && err.message.includes("not found")) {
      return notFoundResponse(err.message);
    }

    return errorResponse(err, log, slug);
  }
}
