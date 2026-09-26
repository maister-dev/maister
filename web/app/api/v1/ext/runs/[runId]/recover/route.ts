import "server-only";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { resumeCrashedRun } from "@/lib/runs/recover";
import { recoverHttpResponse } from "@/lib/runs/recover-http";
import { tokenAuditIdentity } from "@/lib/tokens/audit";
import { handleExt, recordRequiredTokenAudit, unknownLibrarianEffectResponse } from "@/lib/tokens/ext-handler";
import { runProjectResolver } from "@/lib/tokens/run-project";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const ENDPOINT = "POST /api/v1/ext/runs/[runId]/recover";
const SCOPE = "runs:recover";

type RouteParams = { params: Promise<{ runId: string }> };

// ADR-034 amendment: the token-authority twin of the internal recover route.
// Empty body (ADR-034: "bodies are empty"); the outcome projection is the
// SHARED `recoverHttpResponse`, so this surface can never answer a recovery
// outcome differently from the internal one.
export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;
  const db = getDb() as Db;

  return handleExt(
    req,
    {
      scopeLabel: SCOPE,
      admitLibrarian: true,
      endpoint: ENDPOINT,
      method: "POST",
      successAuditInWork: true,
      resolveLibrarianProjectId: runProjectResolver(runId),
      idempotency: {
        kind: "run_recover",
        target: { runId },
        parseBody: async () => ({}),
      },
      requireScope: true,
      // Without this a GLOBAL operator token is refused on BINDING, before the
      // scope check, even though `runs:recover` already maps to `recoverRun`.
      // Resolving the project from the run reaches that ladder; a project-bound
      // token pointed at a foreign run is still existence-hidden as 404.
      resolveProjectId: async ({ db: handlerDb }) => {
        const rows = await handlerDb
          .select({ projectId: runs.projectId })
          .from(runs)
          .where(eq(runs.id, runId));

        return rows[0]?.projectId ?? null;
      },
      db,
    },
    async (ctx) => {
      // Load-bearing, NOT belt-and-braces: `resumeCrashedRun` takes no
      // projectId, so this is the ONLY thing standing between a project-A token
      // and a run in project B. A foreign (or unknown) run is existence-hidden
      // as 404 — `runs.id` is `text`, so a malformed id is a lookup miss here,
      // never a database error.
      const rows = await db
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.id, runId), eq(runs.projectId, ctx.projectId)));

      if (rows.length === 0) {
        return NextResponse.json(
          { code: "NOT_FOUND", message: "run not found" },
          { status: 404 },
        );
      }

      try {
        const result = await resumeCrashedRun(runId);
        const { httpStatus, body } = recoverHttpResponse(result);

        if (result.state === "transient" && ctx.operationId) {
          return unknownLibrarianEffectResponse({
            actor: ctx.actor,
            projectId: ctx.projectId,
            operationId: ctx.operationId,
            scopeLabel: SCOPE,
            endpoint: ENDPOINT,
            method: "POST",
            error: new Error("recover outcome is transient"),
          }, db);
        }

        if (httpStatus < 400) {
          await db.transaction(async (tx: Db) => {
            await recordRequiredTokenAudit({
              ...tokenAuditIdentity(ctx.actor),
              projectId: ctx.projectId,
              scopeUsed: SCOPE,
              endpoint: ENDPOINT,
              method: "POST",
              result: "ok",
              statusCode: httpStatus,
              operationId: ctx.operationId,
              operation: ctx.operationId
                ? { id: ctx.operationId, result: { statusCode: httpStatus, body } }
                : undefined,
            }, tx);
          });
        }

        return NextResponse.json(body, { status: httpStatus });
      } catch (err) {
        if (!ctx.operationId) throw err;

        return unknownLibrarianEffectResponse({
          actor: ctx.actor,
          projectId: ctx.projectId,
          operationId: ctx.operationId,
          scopeLabel: SCOPE,
          endpoint: ENDPOINT,
          method: "POST",
          error: err,
        }, db);
      }
    },
  );
}
