import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getDb } from "@/lib/db/client";
import { isMaisterError } from "@/lib/errors";
import { resolveActiveBoundRun } from "@/lib/runs/bound-run";
import {
  collectChild,
  directChildRunIds,
  markCollected,
  type CollectedChild,
} from "@/lib/run-results/collect";
import { handleExt, httpStatusForExtCode } from "@/lib/tokens/ext-handler";

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const ENDPOINT = "POST /api/v1/ext/runs/collect";

const bodySchema = z
  .object({
    childRunId: z.string().min(1).optional(),
    all: z.boolean().optional(),
  })
  .strict()
  .refine((b) => b.childRunId !== undefined || b.all === true, {
    message: "either childRunId or all:true is required",
  });

type CollectBody = z.infer<typeof bodySchema>;

export async function POST(
  req: NextRequest,
  _routeCtx: object,
): Promise<NextResponse> {
  const db = getDb() as Db;

  return handleExt(
    req,
    {
      scopeLabel: "runs:collect",
      endpoint: ENDPOINT,
      method: "POST",
      db,
    },
    async (ctx) => {
      let body: CollectBody;

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
            message: "collect requires a run-bound orchestrator token",
          },
          { status: httpStatusForExtCode("PRECONDITION") },
        );
      }

      // Finding 1 (Codex adversarial review): fail closed if the bound
      // orchestrator has terminalized — a stale run-bound token must not read its
      // children's results under a terminal tree.
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

      // DIRECT children only. A named grandchild — or a run in another tree —
      // is refused by `collectChild` with the existence-hiding message, and
      // `all` simply never sees one.
      const childRunIds = body.childRunId
        ? [body.childRunId]
        : await directChildRunIds(db, {
            parentRunId,
            projectId: ctx.projectId,
          });

      const collected: CollectedChild[] = [];

      try {
        for (const id of childRunIds) {
          collected.push(
            await collectChild(db, {
              parentRunId,
              projectId: ctx.projectId,
              childRunId: id,
            }),
          );
        }
      } catch (err) {
        if (!isMaisterError(err)) throw err;

        return NextResponse.json(
          { code: err.code, message: err.message },
          { status: httpStatusForExtCode(err.code) },
        );
      }

      // ADR-165 (T7.2 / W6): the marker commits BEFORE the response. A caller
      // that never sees the body simply retries — the read is idempotent and
      // the marker is write-once, so the body is byte-identical either way.
      await markCollected(db, collected);

      // Only the wire DTO leaves the boundary — `servedResultId` is an internal
      // ledger handle the marker needs and a caller must never see.
      return NextResponse.json(
        collected.map((c) => c.result),
        { status: 200 },
      );
    },
  );
}
