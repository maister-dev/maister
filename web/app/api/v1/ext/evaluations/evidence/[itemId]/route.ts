import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import { readBoundEvidenceItem } from "@/lib/evaluations/judges/facade";
import { evaluatorErrorResponse } from "@/lib/evaluations/judges/route-error";
import { handleExt } from "@/lib/tokens/ext-handler";

const ENDPOINT = "GET /api/v1/ext/evaluations/evidence/[itemId]";

type RouteParams = { params: Promise<{ itemId: string }> };

// Bounded read of one bound-snapshot evidence item (ADR-142 D10). The itemId is
// validated to belong to the token-bound snapshot; offset/length are server-capped.
// Requires evaluations:evidence:read.
export async function GET(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { itemId } = await params;
  const db = getDb();
  const url = new URL(req.url);
  const offsetParam = url.searchParams.get("offset");
  const lengthParam = url.searchParams.get("length");

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
          await readBoundEvidenceItem(
            ctx.actor,
            {
              itemId,
              offset: offsetParam === null ? undefined : Number(offsetParam),
              length: lengthParam === null ? undefined : Number(lengthParam),
            },
            db,
          ),
        );
      } catch (err) {
        const resp = evaluatorErrorResponse(err);

        if (resp) return resp;

        throw err;
      }
    },
  );
}
