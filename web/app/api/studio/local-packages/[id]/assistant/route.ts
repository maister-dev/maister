import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import {
  errorResponse,
  notFoundResponse,
} from "@/lib/api/project-route-helpers";
import { requireGlobalRole } from "@/lib/authz";
import { isMaisterError } from "@/lib/errors";
import { assertHoldsLock } from "@/lib/local-packages/lock";
import { getLocalPackage } from "@/lib/local-packages/service";
import {
  formatLaunchErrorFrame,
  formatLaunchProgressFrame,
  formatLaunchResultFrame,
  type LaunchProgressEvent,
} from "@/lib/runs/launch-progress";
import {
  launchLocalPackageAssistantStaged,
  type ScratchRunResponse,
} from "@/lib/scratch-runs/service";

// M36 Phase 5 (ADR-097) T5.7: launch the Flow Studio assistant for a local
// package. `sessionId` is the editor's working-dir lock session — `assertHoldsLock`
// gates the launch so the assistant runs UNDER the holder's lock (the run writes
// as the lock holder; only the holder may spawn it). One ACP run per editor tab,
// counting against the flow/scratch concurrency pool (MAISTER_MAX_CONCURRENT_RUNS).
//
// ADR-110 staged-stream addendum (2026-06-29): the launch streams its staged
// progress on THIS response (mirroring POST /api/scratch-runs). Cheap sync gates
// stay JSON errors; the generator head runs every service-level precondition
// before the first `precondition` yield, so a head failure is still a JSON error
// with its HTTP status. Only after `precondition` yields do we commit to
// `text/event-stream`; `session_ready` surfaces `runId` BEFORE the first turn so
// the editor attaches the live run SSE (transcript + working badge) immediately.
const log = pino({
  name: "api/studio/local-packages/[id]/assistant",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ id: string }> };

const bodySchema = z
  .object({
    sessionId: z.string().trim().min(1),
    prompt: z.string().trim().min(1).max(60_000),
    runnerId: z.string().trim().min(1).optional(),
    intent: z.enum(["auto", "ask", "edit"]).default("auto"),
    focus: z
      .object({
        path: z.string().trim().min(1).max(512).optional(),
        selectedNodeId: z.string().trim().min(1).max(256).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

function badBody(message: string): NextResponse {
  return NextResponse.json({ code: "CONFIG", message }, { status: 422 });
}

function frameErrorFor(err: unknown): { code: string; message: string } {
  if (isMaisterError(err)) return { code: err.code, message: err.message };

  return { code: "CRASH", message: "internal error" };
}

// Map the service's ScratchRunResponse down to the narrow StudioAssistantLaunchResponse
// the OpenAPI contract documents (only the transport changed, not the shape).
function narrowResult(r: ScratchRunResponse): {
  runId: string;
  dialogStatus: string;
  actionResult: unknown;
} {
  return {
    runId: r.runId,
    dialogStatus: r.status.dialogStatus,
    actionResult: r.actionResult ?? null,
  };
}

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<Response> {
  let id: string;
  let parsed: z.infer<typeof bodySchema>;
  let userId: string;

  try {
    const user = await requireGlobalRole("member");

    ({ id } = await params);

    const body = bodySchema.safeParse(await req.json());

    if (!body.success) {
      return badBody(body.error.issues[0]?.message ?? "bad body");
    }
    parsed = body.data;

    const pkg = await getLocalPackage(id);

    if (!pkg || pkg.status !== "active") {
      return notFoundResponse("local package not found");
    }

    // Lock coordination: only the live working-dir lock holder may launch the
    // assistant (a CONFLICT surfaces the editor's reload banner).
    await assertHoldsLock(id, parsed.sessionId);
    userId = user.id;
  } catch (err) {
    return errorResponse(err, log, "studio/local-packages/[id]/assistant POST");
  }

  const gen = launchLocalPackageAssistantStaged(
    {
      body: {
        localPackageId: id,
        sessionId: parsed.sessionId,
        prompt: parsed.prompt,
        runnerId: parsed.runnerId,
        intent: parsed.intent,
        focus: parsed.focus,
      },
      userId,
    },
    { signal: req.signal },
  );

  // Run the head (all service-level preconditions) up to the first `precondition`
  // yield. A throw here predates any side effect → JSON error with its HTTP status.
  let first: IteratorResult<LaunchProgressEvent, ScratchRunResponse>;

  try {
    first = await gen.next();
  } catch (err) {
    return errorResponse(err, log, "studio/local-packages/[id]/assistant POST");
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (frame: string) => {
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          /* consumer gone — server-side compensation still runs in the generator */
        }
      };

      try {
        if (!first.done) enqueue(formatLaunchProgressFrame(first.value));

        let step: IteratorResult<LaunchProgressEvent, ScratchRunResponse> =
          first.done ? first : await gen.next();

        while (!step.done) {
          enqueue(formatLaunchProgressFrame(step.value));
          step = await gen.next();
        }

        const result = narrowResult(step.value);

        log.info(
          { id, runId: result.runId, dialogStatus: result.dialogStatus },
          "[localPkg.assistant] launched",
        );
        enqueue(formatLaunchResultFrame(result));
      } catch (err) {
        const { code, message } = frameErrorFor(err);

        log.warn(
          { id, code, message },
          "studio assistant launch stream failed",
        );
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
