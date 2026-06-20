import "server-only";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { reworkChildRun } from "@/lib/agents/launch";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { handleExt, httpStatusForExtCode } from "@/lib/tokens/ext-handler";

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/services/tasks.ts).
const { runs } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const ENDPOINT = "POST /api/v1/ext/runs/rework";

const bodySchema = z
  .object({
    childRunId: z.string().min(1),
    prompt: z.string().min(1),
  })
  .strict();

type ReworkBody = z.infer<typeof bodySchema>;

export async function POST(
  req: NextRequest,
  _routeCtx: object,
): Promise<NextResponse> {
  const db = getDb() as Db;

  // M36 (ADR-097): re-open a reviewed child for another turn. Reuses the
  // runs:delegate scope — a run-bound orchestrator addressing its own child.
  return handleExt(
    req,
    {
      scopeLabel: "runs:delegate",
      endpoint: ENDPOINT,
      method: "POST",
      db,
    },
    async (ctx) => {
      let body: ReworkBody;

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
            message: "rework requires a run-bound orchestrator token",
          },
          { status: httpStatusForExtCode("PRECONDITION") },
        );
      }

      // Only a direct child of the bound orchestrator, in the token's project,
      // and currently in Review may be reworked.
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

      try {
        const result = await reworkChildRun(body.childRunId, body.prompt, {
          db,
        });

        return NextResponse.json(
          { childRunId: result.childRunId, status: result.status },
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
