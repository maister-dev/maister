import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import {
  errorResponse,
  notFoundResponse,
  resolveProject,
} from "@/lib/api/project-route-helpers";
import {
  requireActiveSession,
  requireProjectAction,
  type ProjectAction,
} from "@/lib/authz";
import { MaisterError } from "@/lib/errors";
import { ExperimentNotFoundError } from "@/lib/experiments/errors";
import { launchExperimentInputSchema } from "@/lib/experiments/http-schemas";
import { launchExperimentVariants } from "@/lib/experiments/launch";

const log = pino({
  name: "api-project-experiment-launch",
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

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, experimentId } = await params;

  try {
    const user = await requireActiveSession();
    const project = await resolveProject(slug);

    await requireProjectAction(project.id, "manageExperiments");

    const parsed = launchExperimentInputSchema.safeParse(await req.json());

    if (!parsed.success) return bodyErrorResponse(parsed.error);

    const result = await launchExperimentVariants({
      projectId: project.id,
      experimentId,
      actorUserId: user.id,
      input: parsed.data,
      authorizeRunAction: async (
        projectId: string,
        action?: ProjectAction,
      ) => {
        await requireProjectAction(projectId, action ?? "launchRun");
      },
    });

    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof SyntaxError) {
      return bodyErrorResponse(err);
    }
    if (err instanceof ExperimentNotFoundError) {
      return notFoundResponse(err.message);
    }

    if (err instanceof MaisterError && err.code === "CONFIG") {
      return errorResponse(err, log, slug);
    }

    return errorResponse(err, log, slug);
  }
}
