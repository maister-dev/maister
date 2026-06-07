import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { respondToHitl } from "@/lib/services/hitl";

const log = pino({
  name: "api-hitl",
  level: process.env.LOG_LEVEL ?? "info",
});

const bodySchema = z.object({
  optionId: z.string().min(1).optional(),
  response: z.unknown().optional(),
  // M17 ADR-054: responder self-reported confidence in [0,1].
  // Validation happens in the service layer (resolveConfidence → 422 NEEDS_INPUT).
  confidence: z.unknown().optional(),
});

function errorResponse(
  err: unknown,
  ctx: { runId: string; hitlRequestId: string },
): NextResponse {
  if (isMaisterError(err)) {
    const status = httpStatusForCode(err.code);

    log.warn(
      { ...ctx, code: err.code, message: err.message, status },
      "respond error",
    );

    return NextResponse.json(
      { code: err.code, message: err.message },
      { status },
    );
  }
  const message = err instanceof Error ? err.message : String(err);

  log.error({ ...ctx, err: message }, "respond unhandled error");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

function httpStatusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
    case "ACCOUNT_INACTIVE":
      return 403;
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
    case "EXECUTOR_UNAVAILABLE":
      return 503;
    case "HITL_TIMEOUT":
      return 410;
    case "CONFIG":
      return 400;
    case "NEEDS_INPUT":
      return 422;
    // Supervisor rejected the delivery at the protocol level — terminal upstream
    // failure, distinct from a generic 500 or a retryable 503.
    case "ACP_PROTOCOL":
      return 502;
    default:
      return 500;
  }
}

type RouteParams = {
  params: Promise<{ runId: string; hitlRequestId: string }>;
};

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId, hitlRequestId } = await params;

  let body: z.infer<typeof bodySchema>;

  try {
    body = bodySchema.parse(await req.json());
  } catch (err) {
    return errorResponse(
      new MaisterError(
        "CONFIG",
        `invalid response body: ${(err as Error).message}`,
      ),
      { runId, hitlRequestId },
    );
  }

  try {
    // Auth-first: authenticate AND clear the forced-password-change gate
    // BEFORE any resource lookup, so unauthenticated or must-change callers
    // cannot probe HITL/run existence via PRECONDITION shape-leaks. Project
    // membership is enforced below, once projectId is derived from the run row.
    const sessionUser = await requireActiveSession();

    // FIXME(any): dual drizzle-orm peer-dep variants — pg|sqlite union.
    const db = getDb() as any;
    const label = sessionUser.name ?? sessionUser.email ?? sessionUser.id;

    return await respondToHitl(
      { runId, hitlRequestId, body },
      { kind: "user", userId: sessionUser.id, label },
      { db },
    );
  } catch (err) {
    return errorResponse(err, { runId, hitlRequestId });
  }
}
