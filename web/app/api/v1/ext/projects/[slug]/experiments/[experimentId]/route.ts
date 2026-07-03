import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { getExperimentComparison } from "@/lib/experiments/comparison";
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
    async (ctx) =>
      NextResponse.json(
        await getExperimentComparison({
          projectId: ctx.projectId,
          experimentId,
          viewerType: "external",
        }),
      ),
  );
}
