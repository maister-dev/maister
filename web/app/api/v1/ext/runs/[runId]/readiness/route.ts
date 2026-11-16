import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import { assertRunKnowledgeDisclosure } from "@/lib/brain/knowledge-run-disclosure";
import { isMaisterError } from "@/lib/errors";
import { getRunReadiness } from "@/lib/queries/readiness";
import { runProjectResolver } from "@/lib/tokens/run-project";
import { handleExt, httpStatusForExtCode } from "@/lib/tokens/ext-handler";

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
      admitLibrarian: true,
      resolveProjectId: runProjectResolver(runId),
      endpoint: ENDPOINT,
      method: "GET",
      db,
    },
    async (ctx) => {
      try {
        if ((await runProjectResolver(runId)({ db })) !== ctx.projectId)
          return NextResponse.json(
            { code: "NOT_FOUND", message: "run not found" },
            { status: 404 },
          );
        const recipient = {
          kind: "token" as const,
          tokenId: ctx.actor.tokenId,
        };

        await assertRunKnowledgeDisclosure(db, recipient, runId);
        const readiness = await getRunReadiness(runId, ctx.projectId, db);

        if (!readiness) {
          return NextResponse.json(
            { code: "NOT_FOUND", message: "run not found" },
            { status: 404 },
          );
        }

        await assertRunKnowledgeDisclosure(db, recipient, runId);

        return NextResponse.json(readiness, { status: 200 });
      } catch (error) {
        if (isMaisterError(error))
          return NextResponse.json(
            { code: error.code, message: error.message },
            { status: httpStatusForExtCode(error.code) },
          );
        throw error;
      }
    },
  );
}
