import "server-only";

import type { PeekFrame } from "@/lib/runs/peek-stream-contract";
import type { PeekHint } from "@/lib/runs/peek-wake";

import pino from "pino";

import { requireActiveSession } from "@/lib/authz";
import { isMaisterError } from "@/lib/errors";
import { parsePeekRunId, peekFailure, peekQuery } from "@/lib/runs/peek-http";
import { authorizePeekRun, peekPath } from "@/lib/runs/peek-read-model";
import { subscribePeekChanges } from "@/lib/runs/peek-wake";

const log = pino({
  name: "run-peek-stream",
  level: process.env.LOG_LEVEL ?? "info",
});
const encoder = new TextEncoder();

async function belongs(
  userId: string,
  anchor: string,
  runId: string,
): Promise<boolean> {
  try {
    await peekPath(userId, anchor, runId);

    return true;
  } catch (error) {
    if (isMaisterError(error) && error.code === "PRECONDITION") return false;
    throw error;
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  try {
    const user = await requireActiveSession();
    const anchor = parsePeekRunId((await params).runId);
    const query = peekQuery(request, ["selected"]);
    const requested =
      query.selected === undefined ? null : parsePeekRunId(query.selected);
    const anchorAccess = await authorizePeekRun(user.id, anchor);
    let selected =
      requested &&
      requested !== anchor &&
      (await belongs(user.id, anchor, requested))
        ? requested
        : null;
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let closed = false;
    let working = false;
    let lost = false;
    const pending = new Map<string, PeekHint>();
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let release: (() => Promise<void>) | null = null;
    const send = (frame: PeekFrame): void => {
      if (!closed && controller)
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(frame)}\n\n`),
        );
    };
    const cleanup = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      pending.clear();
      if (heartbeat) clearInterval(heartbeat);
      request.signal.removeEventListener("abort", abort);
      const owned = release;

      release = null;
      if (owned) await owned();
      log.info({ anchorRunId: anchor }, "peek stream disconnected");
    };
    const finish = (): void => {
      if (!closed) controller?.close();
      void cleanup().catch((err: unknown) =>
        log.error({ err }, "peek stream cleanup failed"),
      );
    };
    const abort = (): void => finish();
    const drain = async (): Promise<void> => {
      if (working || !controller || closed) return;
      working = true;
      try {
        while (pending.size && !closed) {
          const [key, hint] = pending.entries().next().value!;

          pending.delete(key);
          await authorizePeekRun(user.id, anchor);
          if (selected && !(await belongs(user.id, anchor, selected))) {
            selected = null;
            send({ type: "peek.selection_unavailable" });
          }
          const related =
            (await belongs(user.id, anchor, hint.runId)) ||
            (!!hint.parentRunId &&
              (await belongs(user.id, anchor, hint.parentRunId))) ||
            (!!hint.previousParentRunId &&
              (await belongs(user.id, anchor, hint.previousParentRunId)));
          const shared =
            hint.source === "workspaces" &&
            hint.rootRunId !== null &&
            hint.rootRunId === (anchorAccess.run.rootRunId ?? anchor);

          if (!related && !shared) continue;
          if (hint.runId === anchor || shared)
            send({ type: "run.changed", runId: anchor, kind: hint.topic });
          if (selected && (hint.runId === selected || shared))
            send({ type: "run.changed", runId: selected, kind: hint.topic });
          send({ type: "peek.changed" });
        }
      } catch (error) {
        log.warn(
          {
            anchorRunId: anchor,
            code: isMaisterError(error) ? error.code : "CRASH",
          },
          "peek stream authorization or read failed",
        );
        send({ type: "peek.resync", reason: "transport" });
        finish();
      } finally {
        working = false;
      }
    };

    release = await subscribePeekChanges(
      (hint) => {
        if (closed) return;
        if (pending.size >= 128) {
          pending.clear();
          send({ type: "peek.resync", reason: "transport" });
        }
        pending.set(
          `${hint.topic}:${hint.runId}:${hint.previousParentRunId ?? ""}`,
          hint,
        );
        void drain();
      },
      () => {
        lost = true;
        send({ type: "peek.resync", reason: "transport" });
        finish();
      },
    );
    if (request.signal.aborted || lost) {
      await release();

      return new Response(null, { status: 503 });
    }
    const stream = new ReadableStream<Uint8Array>({
      start(owned) {
        controller = owned;
        request.signal.addEventListener("abort", abort, { once: true });
        send({
          type: "peek.ready",
          anchorRunId: anchor,
          selectedRunId: selected,
          selectionState: requested
            ? selected
              ? "ready"
              : "unavailable"
            : "none",
        });
        heartbeat = setInterval(() => {
          if (!closed) owned.enqueue(encoder.encode(": heartbeat\n\n"));
        }, 15000);
        void drain();
      },
      async cancel() {
        await cleanup();
      },
    });

    log.info(
      { anchorRunId: anchor, selectedRunId: selected },
      "peek stream connected",
    );

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return peekFailure(error);
  }
}
