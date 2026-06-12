import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { storedDeliveryPolicySchema } from "@/lib/runs/delivery-policy";
import { launchRun } from "@/lib/services/runs";

const log = pino({
  name: "api-runs",
  level: process.env.LOG_LEVEL ?? "info",
});

const postBodySchema = z
  .object({
    taskId: z.string().min(1),
    flowId: z.string().min(1).optional(),
    runnerId: z.string().min(1).optional(),
    baseBranch: z.string().min(1).optional(),
    targetBranch: z.string().min(1).optional(),
    deliveryPolicy: storedDeliveryPolicySchema.optional(),
  })
  .strict();

function errorResponse(err: unknown): NextResponse {
  if (isMaisterError(err)) {
    const status = httpStatusForCode(err.code);

    return NextResponse.json(
      { code: err.code, message: err.message },
      { status },
    );
  }
  const message = err instanceof Error ? err.message : String(err);

  log.error({ err: message }, "POST /api/runs unhandled error");

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
      return 403;
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
    case "EXECUTOR_UNAVAILABLE":
      return 503;
    case "CONFIG":
      return 400;
    default:
      return 500;
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: z.infer<typeof postBodySchema>;

  try {
    body = postBodySchema.parse(await req.json());
  } catch (err) {
    return errorResponse(
      new MaisterError(
        "CONFIG",
        `invalid POST body: ${(err as Error).message}`,
      ),
    );
  }

  try {
    // Auth-first: authenticate AND clear the forced-password-change gate up
    // front, so must-change callers cannot probe task/project existence before
    // auth. Project-role authz happens once projectId is derived from the task
    // row below (taskId is body-controlled — never trust a body projectId).
    const user = await requireActiveSession();

    const result = await launchRun(
      {
        taskId: body.taskId,
        flowId: body.flowId,
        runnerId: body.runnerId,
        baseBranch: body.baseBranch,
        targetBranch: body.targetBranch,
        deliveryPolicy: body.deliveryPolicy,
      },
      {
        actorUserId: user.id,
        authorize: async (projectId) => {
          await requireProjectAction(projectId, "launchRun");
        },
      },
    );

    if (result.status === "Running") {
      return NextResponse.json(
        { runId: result.runId, status: "Running" },
        { status: 202 },
      );
    }

    return NextResponse.json(
      {
        runId: result.runId,
        status: "Pending",
        queuePosition: result.queuePosition,
      },
      { status: 202 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
