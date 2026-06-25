import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import {
  requireActiveSession,
  requireProjectAction,
  type ProjectAction,
} from "@/lib/authz";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { storedDeliveryPolicySchema } from "@/lib/runs/delivery-policy";
import { executionPolicySchema } from "@/lib/runs/execution-policy";
import {
  formatLaunchErrorFrame,
  formatLaunchProgressFrame,
  formatLaunchResultFrame,
  type LaunchProgressEvent,
} from "@/lib/runs/launch-progress";
import { launchRun, launchRunStaged } from "@/lib/services/runs";

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
    executionPolicy: executionPolicySchema.optional(),
    packageVersions: z
      .record(z.string().min(1), z.enum(["keep", "adopt", "cut_and_adopt"]))
      .optional(),
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

function frameErrorFor(err: unknown): { code: string; message: string } {
  if (isMaisterError(err)) return { code: err.code, message: err.message };

  return { code: "CRASH", message: "internal error" };
}

// Phase 6 (FR-F1/F2, T6.3): content-negotiated launch. A board client that
// sends `Accept: text/event-stream` gets the staged launch progress on this
// response (precondition → worktree_created → materializing → terminal
// `scratch.launch_result` wrapping `{runId,status,queuePosition?}`); every other
// caller (programmatic, tests) gets the unchanged JSON 202. Preconditions throw
// BEFORE the stream opens either way → JSON error with the right HTTP status.
export async function POST(req: NextRequest): Promise<Response> {
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

  // Auth-first: authenticate AND clear the forced-password-change gate up
  // front, so must-change callers cannot probe task/project existence before
  // auth. Project-role authz happens once projectId is derived from the task
  // row inside launchRun (taskId is body-controlled — never trust a body
  // projectId).
  let user: Awaited<ReturnType<typeof requireActiveSession>>;

  try {
    user = await requireActiveSession();
  } catch (err) {
    return errorResponse(err);
  }

  const input = {
    taskId: body.taskId,
    flowId: body.flowId,
    runnerId: body.runnerId,
    baseBranch: body.baseBranch,
    targetBranch: body.targetBranch,
    deliveryPolicy: body.deliveryPolicy,
    executionPolicy: body.executionPolicy,
    packageVersions: body.packageVersions,
  };
  const ctx = {
    actorUserId: user.id,
    authorize: async (
      projectId: string,
      action: ProjectAction = "launchRun",
    ) => {
      await requireProjectAction(projectId, action);
    },
  };

  const wantsStream = (req.headers.get("accept") ?? "").includes(
    "text/event-stream",
  );

  if (!wantsStream) {
    try {
      const result = await launchRun(input, ctx);

      return NextResponse.json(
        result.status === "Running"
          ? { runId: result.runId, status: "Running" }
          : {
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

  const gen = launchRunStaged(input, ctx, undefined, { signal: req.signal });

  // Run the head (all preconditions) up to the first `precondition` yield. A
  // throw here predates any side-effect → JSON error with its HTTP status.
  let first: IteratorResult<LaunchProgressEvent, unknown>;

  try {
    first = await gen.next();
  } catch (err) {
    return errorResponse(err);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (frame: string) => {
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          /* consumer gone — server-side compensation still runs */
        }
      };

      try {
        if (!first.done) enqueue(formatLaunchProgressFrame(first.value));

        let step: IteratorResult<LaunchProgressEvent, unknown> = first.done
          ? first
          : await gen.next();

        while (!step.done) {
          enqueue(formatLaunchProgressFrame(step.value));
          step = await gen.next();
        }
        enqueue(formatLaunchResultFrame(step.value));
      } catch (err) {
        const { code, message } = frameErrorFor(err);

        log.warn({ code, message }, "flow launch stream failed");
        enqueue(formatLaunchErrorFrame(code, message));
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
