import "server-only";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { resolveActiveBoundRun } from "@/lib/runs/bound-run";
import { handleExt, httpStatusForExtCode } from "@/lib/tokens/ext-handler";
import { stopWorkbenchRunForToken } from "@/lib/workbench-lifecycle/service";

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/services/tasks.ts).
const { runs } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const ENDPOINT = "POST /api/v1/ext/runs/cancel";

const bodySchema = z
  .object({
    childRunId: z.string().min(1),
  })
  .strict();

type CancelBody = z.infer<typeof bodySchema>;

export async function POST(
  req: NextRequest,
  _routeCtx: object,
): Promise<NextResponse> {
  const db = getDb() as Db;

  return handleExt(
    req,
    {
      scopeLabel: "runs:cancel",
      endpoint: ENDPOINT,
      method: "POST",
      db,
    },
    async (ctx) => {
      let body: CancelBody;

      try {
        body = bodySchema.parse(await req.json());
      } catch (err) {
        return NextResponse.json(
          {
            code: "CONFIG",
            message: `invalid body: ${(err as Error).message}`,
          },
          { status: 422 },
        );
      }

      const parentRunId = ctx.actor.boundRunId;

      if (!parentRunId) {
        return NextResponse.json(
          {
            code: "PRECONDITION",
            message: "cancel requires a run-bound orchestrator token",
          },
          { status: httpStatusForExtCode("PRECONDITION") },
        );
      }

      // Finding 1 (Codex adversarial review): fail closed if the bound
      // orchestrator has terminalized — a stale run-bound token must not cancel
      // children under a terminal tree.
      const boundRes = await resolveActiveBoundRun(
        db,
        parentRunId,
        ctx.projectId,
      );

      if (!boundRes.ok) {
        return NextResponse.json(
          { code: boundRes.code, message: boundRes.message },
          { status: httpStatusForExtCode(boundRes.code) },
        );
      }

      // Only a direct child of the bound orchestrator, in the token's project,
      // may be cancelled.
      const rows = await db
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.id, body.childRunId),
            eq(runs.parentRunId, parentRunId),
            eq(runs.projectId, ctx.projectId),
          ),
        );

      if (rows.length === 0) {
        return NextResponse.json(
          {
            code: "PRECONDITION",
            message: "run is not a child of the bound orchestrator run",
          },
          { status: httpStatusForExtCode("PRECONDITION") },
        );
      }

      try {
        const result = await stopWorkbenchRunForToken(body.childRunId, {
          projectId: ctx.projectId,
        });

        return NextResponse.json(
          { childRunId: result.runId, status: result.runStatus },
          { status: 200 },
        );
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
