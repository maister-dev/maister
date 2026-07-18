import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import { readBoundEvidenceItem } from "@/lib/evaluations/judges/facade";
import { evaluatorErrorResponse } from "@/lib/evaluations/judges/route-error";
import { handleExt } from "@/lib/tokens/ext-handler";

const ENDPOINT = "GET /api/v1/ext/evaluations/evidence/[itemId]";

type RouteParams = { params: Promise<{ itemId: string }> };

// A non-numeric value would survive the store's Math.min/max clamps as NaN and
// crash the bounded fs read — gate it at the route boundary as a typed 422,
// keeping the default for an absent param. Thrown inside `work` so auth still
// precedes it.
function finiteQueryParam(
  raw: string | null,
  name: string,
): number | undefined {
  if (raw === null) return undefined;

  const value = Number(raw);

  if (!Number.isFinite(value)) {
    throw new MaisterError(
      "CONFIG",
      `query parameter "${name}" must be a finite number (got "${raw}")`,
    );
  }

  return value;
}

// Bounded read of one bound-snapshot evidence item (ADR-145 D10). The itemId is
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
              offset: finiteQueryParam(offsetParam, "offset"),
              length: finiteQueryParam(lengthParam, "length"),
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
