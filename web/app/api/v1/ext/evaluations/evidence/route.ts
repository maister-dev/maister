import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import { listBoundEvidence } from "@/lib/evaluations/judges/facade";
import { evaluatorErrorResponse } from "@/lib/evaluations/judges/route-error";
import { handleExt } from "@/lib/tokens/ext-handler";

const ENDPOINT = "GET /api/v1/ext/evaluations/evidence";

// Cursor-paginated evidence metadata for the token-bound snapshot (ADR-145 D10).
// Requires evaluations:evidence:read. Real participant ids are blinded.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const db = getDb();
  const url = new URL(req.url);
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam === null ? undefined : Number(limitParam);

  return handleExt(
    req,
    {
      scopeLabel: "evaluations:evidence:read",
      endpoint: ENDPOINT,
      method: "GET",
      db,
    },
    async (ctx) => {
      try {
        return NextResponse.json(
          await listBoundEvidence(ctx.actor, { cursor, limit }, db),
        );
      } catch (err) {
        const resp = evaluatorErrorResponse(err);

        if (resp) return resp;

        throw err;
      }
    },
  );
}
