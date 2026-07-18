import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import { listBoundEvidence } from "@/lib/evaluations/judges/facade";
import { evaluatorErrorResponse } from "@/lib/evaluations/judges/route-error";
import { handleExt } from "@/lib/tokens/ext-handler";

const ENDPOINT = "GET /api/v1/ext/evaluations/evidence";

// A non-numeric value would survive the facade's Math.min/max clamps as NaN and
// blow up in SQL — gate it at the route boundary as a typed 422, keeping the
// default for an absent param. Thrown inside `work` so auth still precedes it.
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

// Cursor-paginated evidence metadata for the token-bound snapshot (ADR-145 D10).
// Requires evaluations:evidence:read. Real participant ids are blinded.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const db = getDb();
  const url = new URL(req.url);
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const limitParam = url.searchParams.get("limit");

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
        const limit = finiteQueryParam(limitParam, "limit");

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
