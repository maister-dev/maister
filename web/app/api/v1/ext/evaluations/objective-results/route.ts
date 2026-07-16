import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import { getBoundObjectiveResults } from "@/lib/evaluations/judges/facade";
import { evaluatorErrorResponse } from "@/lib/evaluations/judges/route-error";
import { handleExt } from "@/lib/tokens/ext-handler";

const ENDPOINT = "GET /api/v1/ext/evaluations/objective-results";

// Structured objective facts for the token-bound execution (ADR-142 D11).
// Requires evaluations:objective:read. Missing/absent statuses keep their reason.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const db = getDb();

  return handleExt(
    req,
    {
      scopeLabel: "evaluations:objective:read",
      endpoint: ENDPOINT,
      method: "GET",
      db,
    },
    async (ctx) => {
      try {
        return NextResponse.json(await getBoundObjectiveResults(ctx.actor, db));
      } catch (err) {
        const resp = evaluatorErrorResponse(err);

        if (resp) return resp;

        throw err;
      }
    },
  );
}
