import "server-only";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getDb } from "@/lib/db/client";
import { runs } from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { tokenAuditIdentity } from "@/lib/tokens/audit";
import { handleExt, httpStatusForExtCode, recordRequiredTokenAudit, unknownLibrarianEffectResponse } from "@/lib/tokens/ext-handler";
import { runProjectResolver } from "@/lib/tokens/run-project";
import { stopWorkbenchRunForToken } from "@/lib/workbench-lifecycle/service";

const ENDPOINT = "POST /api/v1/ext/runs/[runId]/stop";
const bodySchema = z.object({}).strict();
type RouteParams = { params: Promise<{ runId: string }> };

export async function POST(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { runId } = await params;
  const db = getDb();

  return handleExt(req, {
    scopeLabel: "runs:cancel",
    endpoint: ENDPOINT,
    method: "POST",
    admitLibrarian: true,
    resolveLibrarianProjectId: runProjectResolver(runId),
    successAuditInWork: true,
    idempotency: {
      kind: "run_stop",
      target: { runId },
      parseBody: async (request) => bodySchema.parse(await request.json()),
    },
    db,
  }, async (ctx) => {
    try {
      bodySchema.parse(await req.json());
    } catch (err) {
      return NextResponse.json({ code: "CONFIG", message: `invalid body: ${(err as Error).message}` }, { status: 422 });
    }

    const [run] = await db.select({ id: runs.id }).from(runs).where(
      and(eq(runs.id, runId), eq(runs.projectId, ctx.projectId)),
    );

    if (!run) {
      return NextResponse.json({ code: "NOT_FOUND", message: "run not found" }, { status: 404 });
    }

    try {
      const stopped = await stopWorkbenchRunForToken(runId, { projectId: ctx.projectId });
      const receipt = { runId, status: stopped.runStatus };

      await db.transaction(async (tx) => {
        await recordRequiredTokenAudit({
          ...tokenAuditIdentity(ctx.actor),
          projectId: ctx.projectId,
          scopeUsed: "runs:cancel",
          endpoint: ENDPOINT,
          method: "POST",
          result: "ok",
          statusCode: 200,
          operationId: ctx.operationId,
          operation: ctx.operationId
            ? { id: ctx.operationId, result: { statusCode: 200, body: receipt } }
            : undefined,
        }, tx);
      });

      return NextResponse.json(receipt);
    } catch (err) {
      if (ctx.operationId) {
        return unknownLibrarianEffectResponse({
          actor: ctx.actor,
          projectId: ctx.projectId,
          operationId: ctx.operationId,
          scopeLabel: "runs:cancel",
          endpoint: ENDPOINT,
          method: "POST",
          error: err,
        }, db);
      }
      if (!isMaisterError(err)) throw err;

      return NextResponse.json({ code: err.code, message: err.message, details: err.details }, {
        status: httpStatusForExtCode(err.code),
      });
    }
  });
}
