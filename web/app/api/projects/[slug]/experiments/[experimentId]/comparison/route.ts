import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import {
  errorResponse,
  notFoundResponse,
  resolveProject,
} from "@/lib/api/project-route-helpers";
import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getExperimentComparison } from "@/lib/experiments/comparison";
import { ExperimentNotFoundError } from "@/lib/experiments/errors";

const log = pino({
  name: "api-project-experiment-comparison",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = {
  params: Promise<{ slug: string; experimentId: string }>;
};

export async function GET(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, experimentId } = await params;

  try {
    await requireActiveSession();
    const project = await resolveProject(slug);

    await requireProjectAction(project.id, "readExperiments");

    return NextResponse.json(
      await getExperimentComparison({
        projectId: project.id,
        experimentId,
        viewerType: "session",
      }),
    );
  } catch (err) {
    if (err instanceof ExperimentNotFoundError) {
      return notFoundResponse(err.message);
    }

    return errorResponse(err, log, slug);
  }
}
