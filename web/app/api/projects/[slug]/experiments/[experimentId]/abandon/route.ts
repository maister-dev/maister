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
import { ExperimentNotFoundError } from "@/lib/experiments/errors";
import { abandonExperimentInputSchema } from "@/lib/experiments/http-schemas";
import { abandonExperiment } from "@/lib/experiments/service";

const log = pino({
  name: "api-project-experiment-abandon",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = {
  params: Promise<{ slug: string; experimentId: string }>;
};

function bodyErrorResponse(err: unknown): NextResponse {
  return NextResponse.json(
    {
      code: "CONFIG",
      message: `invalid POST body: ${(err as Error).message}`,
    },
    { status: 422 },
  );
}

async function readOptionalJsonBody(req: NextRequest): Promise<unknown> {
  const raw = await req.text();

  if (raw.trim().length === 0) return {};

  return JSON.parse(raw);
}

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, experimentId } = await params;

  try {
    const user = await requireActiveSession();
    const project = await resolveProject(slug);

    await requireProjectAction(project.id, "manageExperiments");

    const body = await readOptionalJsonBody(req);

    if (
      body !== null &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      Object.keys(body).length === 0
    ) {
      log.debug(
        { slug, experimentId },
        "[FIX:experiment-abandon-body] defaulted empty abandon body",
      );
    }

    const parsed = abandonExperimentInputSchema.safeParse(body);

    if (!parsed.success) return bodyErrorResponse(parsed.error);

    const result = await abandonExperiment({
      projectId: project.id,
      experimentId,
      actorUserId: user.id,
      input: parsed.data,
    });

    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof SyntaxError) return bodyErrorResponse(err);
    if (err instanceof ExperimentNotFoundError) {
      return notFoundResponse(err.message);
    }
    if (err instanceof MaisterError && err.code === "CONFIG") {
      return errorResponse(err, log, slug);
    }

    return errorResponse(err, log, slug);
  }
}
