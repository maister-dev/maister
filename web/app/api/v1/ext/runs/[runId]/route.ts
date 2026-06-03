import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import { getRunDTO } from "@/lib/services/runs";
import { handleExt } from "@/lib/tokens/ext-handler";

const ENDPOINT = "GET /api/v1/ext/runs/[runId]";

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
      scopeLabel: "runs:read",
      endpoint: ENDPOINT,
      method: "GET",
      db,
    },
    async (ctx) => {
      const run = await getRunDTO(runId, ctx.projectId, db);

      if (!run) {
        return NextResponse.json(
          { code: "NOT_FOUND", message: "run not found" },
          { status: 404 },
        );
      }

      return NextResponse.json(run, { status: 200 });
    },
  );
}
