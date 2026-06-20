import "server-only";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { promoteChildRunForToken } from "@/lib/runs/promote";
import { handleExt, httpStatusForExtCode } from "@/lib/tokens/ext-handler";

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/services/tasks.ts).
const { runs } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const ENDPOINT = "POST /api/v1/ext/runs/promote";

const bodySchema = z
  .object({
    childRunId: z.string().min(1),
  })
  .strict();

type PromoteBody = z.infer<typeof bodySchema>;

export async function POST(
  req: NextRequest,
  _routeCtx: object,
): Promise<NextResponse> {
  const db = getDb() as Db;

  // M37 (ADR-100): only an orchestrator's run-bound token holds `runs:promote`
  // (child agent tokens do not), so a child→child promote is a 403 by scope.
  return handleExt(
    req,
    {
      scopeLabel: "runs:promote",
      endpoint: ENDPOINT,
      method: "POST",
      db,
    },
    async (ctx) => {
      let body: PromoteBody;

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
            message: "promote requires a run-bound orchestrator token",
          },
          { status: httpStatusForExtCode("PRECONDITION") },
        );
      }

      // Only a direct child of the bound orchestrator, in the token's project,
      // and currently in Review may be promoted.
      const rows = await db
        .select({ id: runs.id, status: runs.status })
        .from(runs)
        .where(
          and(
            eq(runs.id, body.childRunId),
            eq(runs.parentRunId, parentRunId),
            eq(runs.projectId, ctx.projectId),
          ),
        );
      const child = rows[0];

      if (!child) {
        return NextResponse.json(
          {
            code: "PRECONDITION",
            message: "run is not a child of the bound orchestrator run",
          },
          { status: httpStatusForExtCode("PRECONDITION") },
        );
      }

      if (child.status !== "Review") {
        return NextResponse.json(
          {
            code: "PRECONDITION",
            message: `child run is not in Review (status=${child.status})`,
          },
          { status: httpStatusForExtCode("PRECONDITION") },
        );
      }

      // An orchestrator token is ownerless (system actor); a future agent-bound
      // promoter would act as that agent.
      const actor = ctx.actor.agentId
        ? ({ kind: "agent", agentId: ctx.actor.agentId } as const)
        : ({ kind: "system" } as const);

      try {
        const result = await promoteChildRunForToken(body.childRunId, {
          projectId: ctx.projectId,
          actor,
          db,
        });

        return NextResponse.json(
          {
            childRunId: body.childRunId,
            status: "Done",
            ...(result.commit ? { commit: result.commit } : {}),
          },
          { status: 200 },
        );
      } catch (err) {
        // A merge conflict surfaces as CONFLICT (409) — the child stays in Review
        // for a human to resolve; the orchestrator never auto-resolves (§8).
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
