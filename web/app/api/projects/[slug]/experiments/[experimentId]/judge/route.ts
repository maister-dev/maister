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
import { getExperimentDetail } from "@/lib/experiments/service";
import { launchExperimentJudge } from "@/lib/experiments/judge";

const log = pino({
  name: "api-project-experiment-judge",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = {
  params: Promise<{ slug: string; experimentId: string }>;
};

export async function POST(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, experimentId } = await params;

  try {
    await requireActiveSession();

    const project = await resolveProject(slug);

    await requireProjectAction(project.id, "manageExperiments");
    await requireProjectAction(project.id, "launchRun");

    const experiment = await getExperimentDetail(project.id, experimentId);

    if (!experiment) {
      return notFoundResponse(`experiment not found: ${experimentId}`);
    }

    const result = await launchExperimentJudge({
      projectId: project.id,
      taskId: experiment.taskId,
      experimentId,
    });

    if ("deduped" in result) {
      throw new MaisterError("CONFLICT", "experiment judge launch deduped");
    }

    return NextResponse.json(
      {
        runId: result.runId,
        status: result.status,
        ...(result.queuePosition !== undefined
          ? { queuePosition: result.queuePosition }
          : {}),
      },
      { status: 202 },
    );
  } catch (err) {
    return errorResponse(err, log, slug);
  }
}
