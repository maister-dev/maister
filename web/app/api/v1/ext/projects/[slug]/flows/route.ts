import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import { listLaunchableFlowSummaries } from "@/lib/queries/project";
import { handleExt } from "@/lib/tokens/ext-handler";

const ENDPOINT_FLOWS_GET = "GET /api/v1/ext/projects/[slug]/flows";

type RouteParams = { params: Promise<{ slug: string }> };

export async function GET(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;
  const db = getDb();

  return handleExt(
    req,
    {
      slug,
      scopeLabel: "flows:read",
      endpoint: ENDPOINT_FLOWS_GET,
      method: "GET",
      db,
    },
    async (ctx) => {
      const flows = await listLaunchableFlowSummaries(ctx.projectId);

      return NextResponse.json({ flows }, { status: 200 });
    },
  );
}
