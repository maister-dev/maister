import "server-only";

import type { PeekFrame } from "@/lib/runs/peek-stream-contract";
import type { PeekHint } from "@/lib/runs/peek-wake";

import { inArray, sql } from "drizzle-orm";
import pino from "pino";

import { requireActiveSession } from "@/lib/authz";
import { runDisclosureGovernedSql } from "@/lib/brain/knowledge-run-disclosure";
import { getDb } from "@/lib/db/client";
import { runs } from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { parsePeekRunId, peekFailure, peekQuery } from "@/lib/runs/peek-http";
import { authorizePeekRun, peekPath } from "@/lib/runs/peek-read-model";
import { subscribePeekChanges } from "@/lib/runs/peek-wake";

const log = pino({
  name: "run-peek-stream",
  level: process.env.LOG_LEVEL ?? "info",
});
const encoder = new TextEncoder();
const AUTH_RECHECK_INTERVAL_MS = 2_500;

type PeekHintScope = {
  anchor: string;
  selected: string | null;
  anchorRoot: string;
};

function peekHintSkipReason(
  hint: PeekHint,
  { anchor, selected, anchorRoot }: PeekHintScope,
): string | null {
  if (hint.topic === "transcript") {
    return hint.runId === anchor || hint.runId === selected
      ? null
      : "unrelated_transcript";
  }
  if (hint.source === "execution_events") {
    return hint.runId === anchor || hint.runId === selected
      ? null
      : "unrelated_execution_event";
  }
  if (
    hint.source === "runs" &&
    hint.runId !== anchor &&
    hint.runId !== selected &&
    hint.parentRunId === null &&
    hint.previousParentRunId === null
  ) {
    return "unrelated_top_level_run";
  }
  const reparented =
    hint.previousParentRunId !== null &&
    hint.previousParentRunId !== hint.parentRunId;

  if (
    !reparented &&
    hint.rootRunId !== null &&
    hint.rootRunId !== anchorRoot &&
    hint.runId !== anchor &&
    hint.runId !== selected &&
    hint.parentRunId !== anchor &&
    hint.previousParentRunId !== anchor
  ) {
    return "foreign_root_run";
  }

  return null;
}

function isHintPotentiallyRelevant(
  hint: PeekHint,
  scope: PeekHintScope,
): boolean {
  return peekHintSkipReason(hint, scope) === null;
}

async function hasGovernedPeekRun(runIds: readonly string[]): Promise<boolean> {
  if (runIds.length === 0) return false;
  const rows = await getDb()
    .select({
      isGoverned: sql<boolean>`COALESCE(${runs.companyId} IS NOT NULL OR ${runDisclosureGovernedSql({ id: runs.id, knowledgeAccess: runs.knowledgeAccess, resultContract: runs.resultContract })}, false)`,
    })
    .from(runs)
    .where(inArray(runs.id, [...runIds]));

  return rows.some((row) => row.isGoverned === true);
}

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
    const anchorRoot = anchorAccess.run.rootRunId ?? anchor;
    let selected =
      requested &&
      requested !== anchor &&
      (await belongs(user.id, anchor, requested))
        ? requested
        : null;
    let governedScope =
      anchorAccess.run.companyId !== null ||
      (await hasGovernedPeekRun(selected ? [anchor, selected] : [anchor]));
    let lastAuthCheckedAt = Date.now();
    let hintsProcessed = 0;
    let hintsSkippedPreDb = 0;
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let closed = false;
    let working = false;
    let lost = false;
    const pending = new Map<string, PeekHint>();
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let release: (() => Promise<void>) | null = null;
    const cleanup = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      pending.clear();
      if (heartbeat) clearInterval(heartbeat);
      request.signal.removeEventListener("abort", abort);
      const owned = release;

      release = null;
      if (owned) await owned();
      log.info(
        { anchorRunId: anchor, hintsProcessed, hintsSkippedPreDb },
        "peek stream disconnected",
      );
    };
    const finish = (): void => {
      if (!closed) {
        try {
          controller?.close();
        } catch {
          // Controller may already be closed or errored on client disconnect.
        }
      }
      void cleanup().catch((err: unknown) =>
        log.error({ err }, "peek stream cleanup failed"),
      );
    };
    const send = (frame: PeekFrame): void => {
      if (!closed && controller) {
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(frame)}\n\n`),
          );
        } catch {
          finish();
        }
      }
    };
    const abort = (): void => finish();
    const recheckAccess = async (): Promise<void> => {
      // A valid selected path already authorizes the anchor. Recheck the
      // anchor separately when there is no current authorized selection.
      if (!selected || !(await belongs(user.id, anchor, selected))) {
        await authorizePeekRun(user.id, anchor);
        if (selected) {
          selected = null;
          send({ type: "peek.selection_unavailable" });
        }
        governedScope =
          anchorAccess.run.companyId !== null ||
          (await hasGovernedPeekRun([anchor]));
      } else if (!governedScope) {
        governedScope = await hasGovernedPeekRun([anchor, selected]);
      }
      lastAuthCheckedAt = Date.now();
    };
    const drain = async (): Promise<void> => {
      if (working || !controller || closed) return;
      working = true;
      try {
        while (pending.size && !closed) {
          const [key, hint] = pending.entries().next().value!;

          pending.delete(key);
          const scope: PeekHintScope = { anchor, selected, anchorRoot };

          if (!isHintPotentiallyRelevant(hint, scope)) {
            hintsSkippedPreDb += 1;
            if (log.isLevelEnabled("debug")) {
              log.debug(
                {
                  anchorRunId: anchor,
                  source: hint.source,
                  topic: hint.topic,
                  reason: peekHintSkipReason(hint, scope),
                },
                "peek stream skipped unrelated hint pre-DB",
              );
            }
            continue;
          }
          hintsProcessed += 1;
          if (
            governedScope ||
            hint.topic === "summary" ||
            Date.now() - lastAuthCheckedAt >= AUTH_RECHECK_INTERVAL_MS
          ) {
            await recheckAccess();
          }
          // Messages affect only the conversation that owns them. Neither the
          // hierarchy nor titles, status, workspace or results depend on them.
          if (hint.topic === "transcript") {
            if (hint.runId === anchor || hint.runId === selected)
              send({
                type: "run.changed",
                runId: hint.runId,
                kind: hint.topic,
              });
            continue;
          }
          const shared =
            hint.source === "workspaces" &&
            hint.rootRunId !== null &&
            hint.rootRunId === anchorRoot;
          const related =
            shared ||
            hint.runId === anchor ||
            hint.runId === selected ||
            (await belongs(user.id, anchor, hint.runId)) ||
            (!!hint.parentRunId &&
              (await belongs(user.id, anchor, hint.parentRunId))) ||
            (!!hint.previousParentRunId &&
              (await belongs(user.id, anchor, hint.previousParentRunId)));

          if (!related) continue;
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
          `${hint.source}:${hint.topic}:${hint.runId}:${hint.previousParentRunId ?? ""}`,
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
      const owned = release;

      release = null;
      if (owned) await owned();

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
          if (closed) return;
          try {
            owned.enqueue(encoder.encode(": heartbeat\n\n"));
          } catch {
            finish();
          }
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
