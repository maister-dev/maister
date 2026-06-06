import "server-only";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { respondToHitl } from "@/lib/services/hitl";
import { httpStatusForExtCode, handleExt } from "@/lib/tokens/ext-handler";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { hitlRequests, runs } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const ENDPOINT = "POST /api/v1/ext/runs/[runId]/hitl/[hitlRequestId]/respond";
const SCOPE = "hitl:respond";

type RouteParams = {
  params: Promise<{ runId: string; hitlRequestId: string }>;
};

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId, hitlRequestId } = await params;
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
      // Parse request body — all fields are optional at the HTTP layer;
      // respondToHitl validates per hitl kind.
      const raw = await req.json().catch(() => undefined);
      const body = raw !== null && typeof raw === "object" ? raw : {};
      const { optionId, response, confidence } = body as {
        optionId?: string;
        response?: unknown;
        confidence?: unknown;
      };

      // Existence-hide: a run outside the token's project is indistinguishable
      // from a missing run (both 404).
      const runRows = await db
        .select({ id: runs.id, projectId: runs.projectId })
        .from(runs)
        .where(and(eq(runs.id, runId), eq(runs.projectId, ctx.projectId)));

      if (runRows.length === 0) {
        return NextResponse.json(
          { code: "NOT_FOUND", message: "run not found" },
          { status: 404 },
        );
      }

      // Existence-hide hitlRequest within this run.
      const hitlRows = await db
        .select({ id: hitlRequests.id })
        .from(hitlRequests)
        .where(
          and(
            eq(hitlRequests.id, hitlRequestId),
            eq(hitlRequests.runId, runId),
          ),
        );

      if (hitlRows.length === 0) {
        return NextResponse.json(
          { code: "NOT_FOUND", message: "hitl request not found" },
          { status: 404 },
        );
      }

      try {
        return await respondToHitl(
          { runId, hitlRequestId, body: { optionId, response, confidence } },
          {
            kind: "api_token",
            tokenId: ctx.actor.tokenId,
            projectId: ctx.projectId,
            label: ctx.actor.actorLabel,
          },
          { db },
        );
      } catch (err) {
        if (isMaisterError(err)) {
          // Genuine-absence (run/hitl not found) is already existence-hidden as
          // 404 by the pre-checks above. A service-thrown PRECONDITION here is
          // only the transient race / server-inconsistency flavor ("row vanished
          // mid-transaction", "project slug not found"), so it must fall through
          // to httpStatusForExtCode (409 — retryable), NOT a terminal 404.
          const status =
            err.code === "UNAUTHORIZED"
              ? 403
              : err.code === "NEEDS_INPUT"
                ? 422
                : httpStatusForExtCode(err.code);

          return NextResponse.json(
            { code: err.code, message: err.message },
            { status },
          );
        }

        throw err;
      }
    },
  );
}
