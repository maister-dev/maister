import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession } from "@/lib/authz";
import { isMaisterError } from "@/lib/errors";
import {
  formatLaunchErrorFrame,
  formatLaunchProgressFrame,
  formatLaunchResultFrame,
  type LaunchProgressEvent,
} from "@/lib/runs/launch-progress";
import { parseScratchRequest } from "@/lib/scratch-runs/request";
import { launchScratchRunStaged } from "@/lib/scratch-runs/service";
import { scratchLaunchInputSchema } from "@/lib/scratch-runs/types";

const log = pino({
  name: "api-scratch-runs",
  level: process.env.LOG_LEVEL ?? "info",
});

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
    case "EXECUTOR_UNAVAILABLE":
      return 503;
    default:
      return 500;
  }
}

function errorResponse(err: unknown): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: httpStatusForCode(err.code) },
    );
  }
  const message = err instanceof Error ? err.message : String(err);

  log.error({ err: message }, "POST /api/scratch-runs unhandled error");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

function frameErrorFor(err: unknown): { code: string; message: string } {
  if (isMaisterError(err)) return { code: err.code, message: err.message };

  return { code: "CRASH", message: "internal error" };
}

// Phase 6 (FR-F1/F2, sub-plan 2026-06-17): the launch streams its staged
// progress on THIS response. We drive ONE generator step first — running every
// precondition — so a head-check failure is still a JSON error with its HTTP
// status. Only after `precondition` yields do we commit to `text/event-stream`;
// side-effect failures (and client cancel) then surface as in-stream frames
// while the generator's own compensation GCs the worktree/session.
export async function POST(req: NextRequest): Promise<Response> {
  let parsed: Awaited<ReturnType<typeof parseScratchRequest>>;
  let userId: string;

  try {
    const user = await requireActiveSession();

    parsed = await parseScratchRequest(req, scratchLaunchInputSchema);
    userId = user.id;

    log.debug(
      {
        userId,
        projectId: parsed.body.projectId,
        contentType: parsed.contentType,
        fileCount: parsed.uploadedFiles.length,
        metadataAttachmentCount: parsed.body.attachments.length,
      },
      "POST /api/scratch-runs parsed request",
    );
  } catch (err) {
    if (isMaisterError(err) && err.code === "PRECONDITION") {
      log.warn(
        { code: err.code, message: err.message },
        "POST /api/scratch-runs rejected",
      );
    }

    return errorResponse(err);
  }

  const gen = launchScratchRunStaged(
    { body: parsed.body, uploadedFiles: parsed.uploadedFiles, userId },
    { signal: req.signal },
  );

  // Run the head (all preconditions) up to the first `precondition` yield. A
  // throw here predates any side-effect → JSON error with its HTTP status.
  let first: IteratorResult<LaunchProgressEvent, unknown>;

  try {
    first = await gen.next();
  } catch (err) {
    if (isMaisterError(err) && err.code === "PRECONDITION") {
      log.warn(
        { code: err.code, message: err.message },
        "POST /api/scratch-runs rejected",
      );
    }

    return errorResponse(err);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (frame: string) => {
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          /* consumer gone — server-side compensation still runs below */
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

        log.warn({ code, message }, "scratch launch stream failed");
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
