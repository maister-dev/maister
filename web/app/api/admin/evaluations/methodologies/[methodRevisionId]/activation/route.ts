import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireGlobalRole } from "@/lib/authz";
import { MaisterError } from "@/lib/errors";
import { setMethodActivation } from "@/lib/evaluations/methods-registry";
import {
  evalErrorResponse,
  parseEvalJson,
} from "@/lib/evaluations/route-helpers";

const log = pino({
  name: "api-admin-eval-methodology-activation",
  level: process.env.LOG_LEVEL ?? "info",
});

const bodySchema = z
  .object({ activation: z.enum(["enabled", "disabled"]) })
  .strict();

// PATCH /api/admin/evaluations/methodologies/{methodRevisionId}/activation —
// enable/disable a projected method (manageEvaluationConfig). Enabling is gated
// on ready health (trusted + compatible); a degraded/incompatible method is
// refused with an actionable reason and can never drive execution.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ methodRevisionId: string }> },
): Promise<NextResponse> {
  try {
    await requireGlobalRole("admin");

    const { methodRevisionId } = await params;
    const parsed = bodySchema.safeParse(await parseEvalJson(req));

    if (!parsed.success) {
      throw new MaisterError(
        "CONFIG",
        `invalid PATCH body: ${parsed.error.message}`,
      );
    }

    const result = await setMethodActivation(
      { methodRevisionId, activation: parsed.data.activation },
      undefined,
    );

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return evalErrorResponse(err, log);
  }
}
