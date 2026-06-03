import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import { getRunReadiness } from "@/lib/queries/readiness";
import { handleExt } from "@/lib/tokens/ext-handler";

const ENDPOINT = "GET /api/v1/ext/runs/[runId]/readiness";

type RouteParams = { params: Promise<{ runId: string }> };

export async function GET(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;
  const db = getDb();

  return handleExt(
    req,
    {
      scopeLabel: "readiness:read",
      endpoint: ENDPOINT,
      method: "GET",
      db,
    },
    async (ctx) => {
      const readiness = await getRunReadiness(runId, ctx.projectId, db);

      if (!readiness) {
        return NextResponse.json(
          { code: "NOT_FOUND", message: "run not found" },
          { status: 404 },
        );
      }

      return NextResponse.json(readiness, { status: 200 });
    },
  );
}
