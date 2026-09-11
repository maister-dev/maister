import "server-only";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { handleExt, httpStatusForExtCode } from "@/lib/tokens/ext-handler";
import { discardWorkbenchForToken } from "@/lib/workbench-lifecycle/service";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const ENDPOINT = "POST /api/v1/ext/runs/[runId]/discard";
// ADR-034 designed recover and discard as ONE RBAC pair under `recoverRun`, so
// they share ONE scope. Recover's own refusals tell the caller to discard —
// gating the two separately would let the API instruct an action it then denies.
const SCOPE = "runs:recover";

type RouteParams = { params: Promise<{ runId: string }> };

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
      db,
    },
    async (ctx) => {
      // Existence-hidden 404 for a foreign or unknown run, matching the sibling
      // recover route. `discardWorkbenchForToken` re-checks the project on the
      // context it loads, so the service stays safe for any future caller.
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
        const result = await discardWorkbenchForToken(runId, {
          projectId: ctx.projectId,
        });

        return NextResponse.json(result, { status: 200 });
      } catch (err) {
        if (isMaisterError(err)) {
          return NextResponse.json(
            { code: err.code, message: err.message },
            { status: httpStatusForExtCode(err.code) },
          );
        }

        throw err;
      }
    },
  );
}
