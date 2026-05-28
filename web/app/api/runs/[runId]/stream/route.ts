import "server-only";

import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { projects, runs } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "api-runs-stream",
  level: process.env.LOG_LEVEL ?? "info",
});

const TERMINAL_RUN_STATUS = new Set([
  "Done",
  "Abandoned",
  "Failed",
  "Crashed",
]);

const POLL_INTERVAL_MS = 100;
const STATUS_REFRESH_MS = 500;
const CHUNK_SIZE = 64 * 1024;

function runtimeRoot(): string {
  return process.env.MAISTER_RUNTIME_ROOT ?? process.cwd();
}

function keepaliveMs(): number {
  const raw = process.env.MAISTER_KEEPALIVE_MINUTES ?? "30";
  const minutes = Number.parseInt(raw, 10);

  return Number.isFinite(minutes) && minutes > 0
    ? minutes * 60_000
    : 30 * 60_000;
}

type RouteParams = { params: Promise<{ runId: string }> };

type RunLite = {
  id: string;
  status: string;
  currentStepId: string | null;
  projectId: string;
  projectSlug: string;
};

async function loadRunLite(runId: string): Promise<RunLite | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = getDb() as any;
  const rows = await db
    .select({
      id: runs.id,
      status: runs.status,
      currentStepId: runs.currentStepId,
      projectId: runs.projectId,
      slug: projects.slug,
    })
    .from(runs)
    .innerJoin(projects, eq(projects.id, runs.projectId))
    .where(eq(runs.id, runId));

  const row = rows[0];

  if (!row) return null;

  return {
    id: row.id,
    status: row.status,
    currentStepId: row.currentStepId,
    projectId: row.projectId,
    projectSlug: row.slug,
  };
}

async function refreshRunStatus(
  runId: string,
): Promise<{ status: string; currentStepId: string | null } | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = getDb() as any;
  const rows = await db
    .select({ status: runs.status, currentStepId: runs.currentStepId })
    .from(runs)
    .where(eq(runs.id, runId));
  const row = rows[0];

  if (!row) return null;

  return { status: row.status, currentStepId: row.currentStepId };
}

function eventsLogPath(
  projectSlug: string,
  runId: string,
  stepId: string,
): string {
  return path.join(
    runtimeRoot(),
    ".maister",
    projectSlug,
    "runs",
    runId,
    `${stepId}.events.jsonl`,
  );
}

function parseLastEventId(req: NextRequest): number {
  const header = req.headers.get("last-event-id");
  const query = new URL(req.url).searchParams.get("lastEventId");
  const raw = header ?? query;

  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);

  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

async function readAvailable(
  fh: FileHandle,
  offset: number,
): Promise<{ chunk: Uint8Array; nextOffset: number }> {
  const buf = new Uint8Array(CHUNK_SIZE);
  const { bytesRead } = await fh.read(buf, 0, CHUNK_SIZE, offset);

  return {
    chunk: buf.subarray(0, bytesRead),
    nextOffset: offset + bytesRead,
  };
}

function formatSseEvent(
  monotonicId: number,
  type: string,
  data: string,
): string {
  return `id: ${monotonicId}\nevent: ${type}\ndata: ${data}\n\n`;
}

export async function GET(
  req: NextRequest,
  { params }: RouteParams,
): Promise<Response> {
  const { runId } = await params;
  const lastEventId = parseLastEventId(req);
  const run = await loadRunLite(runId);

  if (!run) {
    return NextResponse.json(
      { code: "PRECONDITION", message: `run not found: ${runId}` },
      { status: 404 },
    );
  }

  const startedAt = Date.now();
  let eventsSent = 0;
  let disconnectReason: "client-disconnect" | "terminal" | "timeout" =
    "terminal";

  log.info(
    {
      runId,
      lastEventId,
      currentStepId: run.currentStepId,
      status: run.status,
    },
    "stream connect",
  );

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let cursor = 0;
      let lastSeen = lastEventId;
      let fh: FileHandle | null = null;
      let currentStepId = run.currentStepId;
      let projectSlug = run.projectSlug;
      let lastStatusCheck = Date.now();
      let consecutiveEmpty = 0;
      const maxQuietMs = keepaliveMs();

      const cleanup = async () => {
        if (fh) {
          try {
            await fh.close();
          } catch {
            /* ignore */
          }
          fh = null;
        }
        try {
          controller.close();
        } catch {
          /* ignore double-close */
        }
      };

      req.signal.addEventListener("abort", () => {
        disconnectReason = "client-disconnect";
        log.info(
          {
            runId,
            eventsSent,
            durationMs: Date.now() - startedAt,
            reason: disconnectReason,
          },
          "stream disconnect (client)",
        );
        void cleanup();
      });

      if (!currentStepId) {
        try {
          controller.enqueue(
            encoder.encode(`:awaiting-step\n\n`),
          );
        } catch {
          /* client gone */
        }
      }

      try {
        let pending = "";

        while (!req.signal.aborted) {
          if (!currentStepId) {
            await delay(POLL_INTERVAL_MS);
            const status = await refreshRunStatus(runId);

            if (!status) break;
            currentStepId = status.currentStepId;
            if (TERMINAL_RUN_STATUS.has(status.status)) {
              break;
            }
            if (!currentStepId) {
              if (Date.now() - startedAt > maxQuietMs) {
                disconnectReason = "timeout";
                break;
              }
              continue;
            }
          }

          if (!fh) {
            try {
              fh = await open(
                eventsLogPath(projectSlug, runId, currentStepId),
                "r",
              );
              cursor = 0;
              pending = "";
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                await delay(POLL_INTERVAL_MS);
                continue;
              }
              throw err;
            }
          }

          const { chunk, nextOffset } = await readAvailable(fh, cursor);

          cursor = nextOffset;
          if (chunk.length > 0) {
            consecutiveEmpty = 0;
            pending += chunk.length ? new TextDecoder().decode(chunk) : "";
            let nl = pending.indexOf("\n");

            while (nl !== -1) {
              const line = pending.slice(0, nl);

              pending = pending.slice(nl + 1);
              if (line.trim().length === 0) {
                nl = pending.indexOf("\n");
                continue;
              }
              try {
                const ev = JSON.parse(line) as {
                  type: string;
                  monotonicId: number;
                };

                if (typeof ev.monotonicId === "number" && ev.monotonicId > lastSeen) {
                  lastSeen = ev.monotonicId;
                  controller.enqueue(
                    encoder.encode(
                      formatSseEvent(ev.monotonicId, ev.type, line),
                    ),
                  );
                  eventsSent += 1;
                }
              } catch {
                /* skip malformed line */
              }
              nl = pending.indexOf("\n");
            }
          } else {
            consecutiveEmpty += 1;
          }

          if (Date.now() - lastStatusCheck >= STATUS_REFRESH_MS) {
            lastStatusCheck = Date.now();
            const status = await refreshRunStatus(runId);

            if (!status) break;
            if (TERMINAL_RUN_STATUS.has(status.status)) {
              const { chunk: tail } = await readAvailable(fh, cursor);

              if (tail.length > 0) {
                pending += new TextDecoder().decode(tail);
                let nl = pending.indexOf("\n");

                while (nl !== -1) {
                  const line = pending.slice(0, nl);

                  pending = pending.slice(nl + 1);
                  if (line.trim().length === 0) {
                    nl = pending.indexOf("\n");
                    continue;
                  }
                  try {
                    const ev = JSON.parse(line) as {
                      type: string;
                      monotonicId: number;
                    };

                    if (
                      typeof ev.monotonicId === "number" &&
                      ev.monotonicId > lastSeen
                    ) {
                      lastSeen = ev.monotonicId;
                      controller.enqueue(
                        encoder.encode(
                          formatSseEvent(ev.monotonicId, ev.type, line),
                        ),
                      );
                      eventsSent += 1;
                    }
                  } catch {
                    /* skip */
                  }
                  nl = pending.indexOf("\n");
                }
              }
              disconnectReason = "terminal";
              break;
            }
            if (status.currentStepId && status.currentStepId !== currentStepId) {
              currentStepId = status.currentStepId;
              if (fh) {
                await fh.close();
                fh = null;
              }
              cursor = 0;
              pending = "";
            }
          }

          if (consecutiveEmpty * POLL_INTERVAL_MS > maxQuietMs) {
            disconnectReason = "timeout";
            controller.enqueue(
              encoder.encode(
                formatSseEvent(
                  lastSeen + 1,
                  "session.stream_timeout",
                  JSON.stringify({
                    type: "session.stream_timeout",
                    reason: "no events within keepalive window",
                  }),
                ),
              ),
            );
            break;
          }

          await delay(POLL_INTERVAL_MS);
        }
      } catch (err) {
        log.warn(
          {
            runId,
            err: err instanceof Error ? err.message : String(err),
          },
          "stream loop error",
        );
      } finally {
        await cleanup();
        log.info(
          {
            runId,
            eventsSent,
            durationMs: Date.now() - startedAt,
            reason: disconnectReason,
          },
          "stream disconnect",
        );
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
