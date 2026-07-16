import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import { getEvaluatorContext } from "@/lib/evaluations/judges/facade";
import { evaluatorErrorResponse } from "@/lib/evaluations/judges/route-error";
import { handleExt } from "@/lib/tokens/ext-handler";

const ENDPOINT = "GET /api/v1/ext/evaluations/context";

// Token-bound evaluator context (ADR-142 D10): no slug, no ids — the judge
// attempt is derived server-side from the token. Requires evaluations:context:read.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const db = getDb();

  return handleExt(
    req,
    {
      scopeLabel: "evaluations:context:read",
      endpoint: ENDPOINT,
      method: "GET",
      db,
    },
    async (ctx) => {
      try {
        return NextResponse.json(await getEvaluatorContext(ctx.actor, db));
      } catch (err) {
        const resp = evaluatorErrorResponse(err);

        if (resp) return resp;

        throw err;
      }
    },
  );
}
