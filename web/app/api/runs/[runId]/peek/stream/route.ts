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
    hint.previousParentRunId !== anchor &&
    (selected === null ||
      (hint.parentRunId !== selected && hint.previousParentRunId !== selected))
  ) {
    return "foreign_root_run";
  }

  return null;
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

async function resolvePeekPath(
  userId: string,
  anchor: string,
  runId: string,
): Promise<string[] | null> {
  try {
    return await peekPath(userId, anchor, runId);
  } catch (error) {
    if (isMaisterError(error) && error.code === "PRECONDITION") return null;
    throw error;
  }
}

async function belongs(
  userId: string,
  anchor: string,
  runId: string,
): Promise<boolean> {
  return (await resolvePeekPath(userId, anchor, runId)) !== null;
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
    const initialPath =
      requested && requested !== anchor
        ? await resolvePeekPath(user.id, anchor, requested)
        : null;
    let selected = initialPath ? requested : null;
    let activePathIds: string[] = initialPath ?? [anchor];
    let governedScope =
      anchorAccess.run.companyId !== null ||
      (await hasGovernedPeekRun(activePathIds));
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
    const shouldSkipHint = (hint: PeekHint): boolean => {
      const skipReason = peekHintSkipReason(hint, {
        anchor,
        selected,
        anchorRoot,
      });

      if (skipReason !== null) {
        hintsSkippedPreDb += 1;
        if (log.isLevelEnabled("debug")) {
          log.debug(
            {
              anchorRunId: anchor,
              source: hint.source,
              topic: hint.topic,
              reason: skipReason,
            },
            "peek stream skipped unrelated hint pre-DB",
          );
        }

        return true;
      }

      return false;
    };
    const recheckAccess = async (): Promise<void> => {
      // A valid selected path already authorizes the anchor. Recheck the
      // anchor separately when there is no current authorized selection.
      const nextPath = selected
        ? await resolvePeekPath(user.id, anchor, selected)
        : null;

      if (!nextPath) {
        await authorizePeekRun(user.id, anchor);
        if (selected) {
          selected = null;
          send({ type: "peek.selection_unavailable" });
        }
        activePathIds = [anchor];
        governedScope =
          anchorAccess.run.companyId !== null ||
          (await hasGovernedPeekRun(activePathIds));
      } else {
        activePathIds = nextPath;
        if (!governedScope) {
          governedScope = await hasGovernedPeekRun(activePathIds);
        }
      }
      lastAuthCheckedAt = Date.now();
    };
    const ensurePreEmitDisclosure = async (
      checkedAccess: boolean,
    ): Promise<void> => {
      if (checkedAccess || governedScope) return;
      if (await hasGovernedPeekRun(activePathIds)) {
        governedScope = true;
        await recheckAccess();
      }
    };
    const drain = async (): Promise<void> => {
      if (working || !controller || closed) return;
      working = true;
      try {
        while (pending.size && !closed) {
          const [key, hint] = pending.entries().next().value!;

          pending.delete(key);
          if (shouldSkipHint(hint)) continue;
          hintsProcessed += 1;
          let checkedAccess = false;

          if (
            governedScope ||
            hint.topic === "summary" ||
            Date.now() - lastAuthCheckedAt >= AUTH_RECHECK_INTERVAL_MS
          ) {
            await recheckAccess();
            checkedAccess = true;
          }
          // Messages affect only the conversation that owns them. Neither the
          // hierarchy nor titles, status, workspace or results depend on them.
          if (hint.topic === "transcript") {
            if (hint.runId === anchor || hint.runId === selected) {
              await ensurePreEmitDisclosure(checkedAccess);
              if (hint.runId === anchor || hint.runId === selected) {
                send({
                  type: "run.changed",
                  runId: hint.runId,
                  kind: hint.topic,
                });
              }
            }
            continue;
          }
          const shared =
            hint.source === "workspaces" &&
            hint.rootRunId !== null &&
            hint.rootRunId === anchorRoot;
          const isRelated = async (): Promise<boolean> =>
            shared ||
            hint.runId === anchor ||
            hint.runId === selected ||
            (await belongs(user.id, anchor, hint.runId)) ||
            (!!hint.parentRunId &&
              (await belongs(user.id, anchor, hint.parentRunId))) ||
            (!!hint.previousParentRunId &&
              (await belongs(user.id, anchor, hint.previousParentRunId)));
          const related = await isRelated();

          if (!related) continue;
          const selectedBefore = selected;

          await ensurePreEmitDisclosure(checkedAccess);
          if (selected !== selectedBefore && !(await isRelated())) continue;
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
        if (shouldSkipHint(hint)) return;
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
