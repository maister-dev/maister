import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { promoteRun } from "@/lib/runs/promote";

const log = pino({
  name: "api-run-promote",
  level: process.env.LOG_LEVEL ?? "info",
});

const promoteBodySchema = z
  .object({
    mode: z.enum(["local_merge", "pull_request"]),
    targetBranch: z.string().min(1).max(255).optional(),
    reviewedTargetCommit: z.string().min(7).max(64).optional(),
    allowTargetDrift: z.boolean().optional(),
  })
  .strict();

type PromoteBody = z.infer<typeof promoteBodySchema>;
type RouteParams = { params: Promise<{ runId: string }> };

function httpStatusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
    case "ACCOUNT_INACTIVE":
      return 403;
    case "CONFIG":
      return 400;
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
    default:
      return 500;
  }
}

function errorResponse(err: unknown, runId: string): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: httpStatusForCode(err.code) },
    );
  }
  const message = err instanceof Error ? err.message : String(err);

  log.error({ runId, err: message }, "POST /api/runs/[runId]/promote");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;
  let body: PromoteBody;

  try {
    body = promoteBodySchema.parse(await req.json());
  } catch (err) {
    return errorResponse(
      new MaisterError(
        "CONFIG",
        `invalid POST body: ${(err as Error).message}`,
      ),
      runId,
    );
  }

  try {
    const sessionUser = await requireActiveSession();

    const result = await promoteRun(runId, body, {
      sessionUser,
      authorize: async (projectId: string) => {
        await requireProjectAction(projectId, "promoteRun");
      },
    });

    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err, runId);
  }
}
