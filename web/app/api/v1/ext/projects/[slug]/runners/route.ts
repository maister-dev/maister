import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import { listEnabledRunnerSummaries } from "@/lib/queries/project";
import { handleExt } from "@/lib/tokens/ext-handler";

const ENDPOINT_RUNNERS_GET = "GET /api/v1/ext/projects/[slug]/runners";

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
      scopeLabel: "runners:read",
      endpoint: ENDPOINT_RUNNERS_GET,
      method: "GET",
      db,
    },
    // Runners are platform-scoped; the URL slug is used only for auth/scope
    // enforcement (cross-project → 404). The set is the global enabled catalog.
    async () => {
      const runners = await listEnabledRunnerSummaries();

      return NextResponse.json({ runners }, { status: 200 });
    },
  );
}
