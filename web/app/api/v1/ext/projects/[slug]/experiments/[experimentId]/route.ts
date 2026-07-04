import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { getExperimentComparison } from "@/lib/experiments/comparison";
import { isUnauthorizedExperimentAgentActor } from "@/lib/experiments/advisory";
import { ExperimentNotFoundError } from "@/lib/experiments/errors";
import { handleExt } from "@/lib/tokens/ext-handler";

const ENDPOINT =
  "GET /api/v1/ext/projects/[slug]/experiments/[experimentId]";

type RouteParams = {
  params: Promise<{ slug: string; experimentId: string }>;
};

export async function GET(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, experimentId } = await params;

  return handleExt(
    req,
    {
      slug,
      scopeLabel: "experiments:read",
      endpoint: ENDPOINT,
      method: "GET",
    },
    async (ctx) => {
      if (isUnauthorizedExperimentAgentActor(ctx.actor)) {
        return NextResponse.json(
          {
            code: "UNAUTHORIZED",
            message: "experiment detail is reserved for the experiment judge agent",
          },
          { status: 403 },
        );
      }

      try {
        return NextResponse.json(
          await getExperimentComparison({
            projectId: ctx.projectId,
            experimentId,
            viewerType: "external",
          }),
        );
      } catch (err) {
        if (err instanceof ExperimentNotFoundError) {
          return NextResponse.json(
            { code: "NOT_FOUND", message: err.message },
            { status: 404 },
          );
        }

        throw err;
      }
    },
  );
}
