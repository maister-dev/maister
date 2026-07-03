import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import {
  errorResponse,
  notFoundResponse,
  resolveProject,
} from "@/lib/api/project-route-helpers";
import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getExperimentDetail } from "@/lib/experiments/service";

const log = pino({
  name: "api-project-experiment-detail",
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

    const experiment = await getExperimentDetail(project.id, experimentId);

    if (!experiment) {
      return notFoundResponse(`experiment not found: ${experimentId}`);
    }

    return NextResponse.json(experiment);
  } catch (err) {
    return errorResponse(err, log, slug);
  }
}
