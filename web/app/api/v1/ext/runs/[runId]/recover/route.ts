import "server-only";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { resumeCrashedRun } from "@/lib/runs/recover";
import { recoverHttpResponse } from "@/lib/runs/recover-http";
import { handleExt } from "@/lib/tokens/ext-handler";

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
      endpoint: ENDPOINT,
      method: "POST",
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

      const result = await resumeCrashedRun(runId);
      const { httpStatus, body } = recoverHttpResponse(result.state);

      return NextResponse.json(body, { status: httpStatus });
    },
  );
}
