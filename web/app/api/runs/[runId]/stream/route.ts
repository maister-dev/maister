import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { and, asc, desc, eq, gt, isNotNull } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import {
  httpStatusForAuthz,
  requireActiveSession,
  requireProjectRole,
} from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import {
  executionEvents,
  localPackages,
  projects,
  runs,
} from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { keepaliveMs } from "@/lib/runs/keepalive-config";
import {
  shouldReplayRunStream,
  streamReadyEvent,
} from "@/lib/runs/stream-options";
import { assertLocalPackageAssistantActor } from "@/lib/scratch-runs/service";
import { runEventWakeBus } from "@/lib/execution-host/events/run-wake";

const log = pino({
  name: "api-runs-stream",
  level: process.env.LOG_LEVEL ?? "info",
});

const TERMINAL_RUN_STATUS = new Set(["Done", "Abandoned", "Failed", "Crashed"]);

const STATUS_REFRESH_MS = 500;
const CANONICAL_WAKE_TIMEOUT_MS = 1_000;

type RouteParams = { params: Promise<{ runId: string }> };

type RunLite = {
  id: string;
  status: string;
  currentStepId: string | null;
  projectId: string | null;
  createdByUserId: string | null;
  localPackageId: string | null;
};

async function loadRunLite(runId: string): Promise<RunLite | null> {
  const db = getDb() as unknown as Db;
  const rows = await db
    .select({
      id: runs.id,
      status: runs.status,
      currentStepId: runs.currentStepId,
      projectId: runs.projectId,
      createdByUserId: runs.createdByUserId,
      localPackageId: runs.localPackageId,
    })
    .from(runs)
    .leftJoin(projects, eq(projects.id, runs.projectId))
    .leftJoin(localPackages, eq(localPackages.id, runs.localPackageId))
    .where(eq(runs.id, runId));

  const row: RunLite | undefined = rows[0];

  if (!row) return null;

  return {
    id: row.id,
    status: row.status,
    currentStepId: row.currentStepId,
    projectId: row.projectId,
    createdByUserId: row.createdByUserId,
    localPackageId: row.localPackageId,
  };
}

async function refreshRunStatus(
  runId: string,
): Promise<{ status: string; currentStepId: string | null } | null> {
  const db = getDb() as unknown as Db;
  const rows = await db
    .select({ status: runs.status, currentStepId: runs.currentStepId })
    .from(runs)
    .where(eq(runs.id, runId));
  const row = rows[0];

  if (!row) return null;

  return { status: row.status, currentStepId: row.currentStepId };
}

// Durable events that DO advance Last-Event-ID. We deliberately do NOT
// emit a custom `event: <type>` field: browser EventSource dispatches
// named events ONLY to `addEventListener(<eventName>)`, never to the
// `onmessage` handler. Keeping every event on the default `message`
// dispatch lets consumers discriminate on the `type` field carried
// inside `data` without having to register a listener per variant.
function formatSseEvent(monotonicId: string | number, data: string): string {
  return `id: ${monotonicId}\ndata: ${data}\n\n`;
}

// Synthetic bridge events are deliberately outside the durable event sequence.
function formatSyntheticSseEvent(data: string): string {
  return `data: ${data}\n\n`;
}

function parseCanonicalLastEventId(req: NextRequest): bigint {
  const header = req.headers.get("last-event-id");
  const query = new URL(req.url).searchParams.get("lastEventId");
  const raw = header ?? query;

  if (!raw) return -1n;
  if (!/^(0|[1-9][0-9]{0,18})$/.test(raw)) {
    throw new Error("canonical run stream cursor must be a decimal sequence");
  }

  return BigInt(raw);
}

async function latestCanonicalRunSequence(runId: string): Promise<bigint> {
  const db = getDb() as unknown as Db;
  const rows = await db
    .select({ runSequence: executionEvents.runSequence })
    .from(executionEvents)
    .where(
      and(
        eq(executionEvents.runId, runId),
        isNotNull(executionEvents.runSequence),
      ),
    )
    .orderBy(desc(executionEvents.runSequence))
    .limit(1);

  return rows[0]?.runSequence ?? -1n;
}

async function readCanonicalRunEvents(
  runId: string,
  afterSequence: bigint,
): Promise<Array<Record<string, unknown>>> {
  const db = getDb() as unknown as Db;

  return db
    .select({
      id: executionEvents.id,
      runSequence: executionEvents.runSequence,
      eventType: executionEvents.eventType,
      payload: executionEvents.payload,
      occurredAt: executionEvents.occurredAt,
      hostSessionId: executionEvents.hostSessionId,
    })
    .from(executionEvents)
    .where(
      and(
        eq(executionEvents.runId, runId),
        isNotNull(executionEvents.runSequence),
        gt(executionEvents.runSequence, afterSequence),
      ),
    )
    .orderBy(asc(executionEvents.runSequence))
    .limit(500);
}

function canonicalBrowserEvent(
  event: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: event.eventType,
    eventId: event.id,
    runSequence: String(event.runSequence),
    occurredAt:
      event.occurredAt instanceof Date
        ? event.occurredAt.toISOString()
        : String(event.occurredAt),
    hostSessionId: event.hostSessionId ?? null,
  };
}

function canonicalRunEventStream(input: {
  req: NextRequest;
  run: RunLite;
  replayEvents: boolean;
  replayCursor: bigint | null;
  startedAt: number;
}): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let cursor = input.replayEvents
        ? (input.replayCursor ?? -1n)
        : await latestCanonicalRunSequence(input.run.id);
      let eventsSent = 0;
      let lastStatusCheck = Date.now();
      const maxQuietMs = keepaliveMs();
      let lastEventAt = Date.now();
      const close = (): void => {
        try {
          controller.close();
        } catch {
          // The client may have aborted while a database read completed.
        }
      };

      if (!input.replayEvents) {
        controller.enqueue(
          encoder.encode(
            formatSyntheticSseEvent(JSON.stringify(streamReadyEvent())),
          ),
        );
      }

      try {
        while (!input.req.signal.aborted) {
          const events = await readCanonicalRunEvents(input.run.id, cursor);

          for (const event of events) {
            const sequence = event.runSequence;

            if (typeof sequence !== "bigint") {
              throw new Error(
                "canonical run event is missing a bigint run sequence",
              );
            }
            cursor = sequence;
            controller.enqueue(
              encoder.encode(
                formatSseEvent(
                  sequence.toString(),
                  JSON.stringify(canonicalBrowserEvent(event)),
                ),
              ),
            );
            eventsSent += 1;
            lastEventAt = Date.now();
          }

          if (Date.now() - lastStatusCheck >= STATUS_REFRESH_MS) {
            lastStatusCheck = Date.now();
            const status = await refreshRunStatus(input.run.id);

            if (!status || TERMINAL_RUN_STATUS.has(status.status)) break;
          }
          if (Date.now() - lastEventAt > maxQuietMs) {
            controller.enqueue(
              encoder.encode(
                formatSyntheticSseEvent(
                  JSON.stringify({
                    type: "session.stream_timeout",
                    reason: "no canonical events within keepalive window",
                  }),
                ),
              ),
            );
            break;
          }
          // A local wake only reduces latency. The next iteration always
          // replays from the durable sequence, including after a missed wake
          // from another web process or a manager restart.
          await runEventWakeBus.wait(input.run.id, CANONICAL_WAKE_TIMEOUT_MS);
        }
      } catch (error) {
        log.warn(
          {
            runId: input.run.id,
            reason:
              error instanceof Error
                ? error.message
                : "canonical_stream_failure",
          },
          "canonical-run-stream-error",
        );
      } finally {
        close();
        log.info(
          {
            runId: input.run.id,
            eventsSent,
            durationMs: Date.now() - input.startedAt,
            source: "canonical_events",
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

export async function GET(
  req: NextRequest,
  { params }: RouteParams,
): Promise<Response> {
  const { runId } = await params;
  const replayEvents = shouldReplayRunStream(req.url);

  // Auth-first: authenticate AND clear the forced-password-change gate BEFORE
  // the run lookup, so unauthenticated / must-change callers cannot probe run
  // existence (404-vs-403 shape). Project membership is enforced below once
  // projectId is derived from the run row.
  let sessionUser: { id: string };

  try {
    sessionUser = await requireActiveSession();
  } catch (err) {
    if (isMaisterError(err)) {
      const status = httpStatusForAuthz(err.code) ?? 500;

      return NextResponse.json(
        { code: err.code, message: err.message },
        { status },
      );
    }
    throw err;
  }

  const run = await loadRunLite(runId);

  if (!run) {
    return NextResponse.json(
      { code: "PRECONDITION", message: `run not found: ${runId}` },
      { status: 404 },
    );
  }

  // RBAC: project runs require viewer+ on the derived project; project-less
  // local-package assistant runs are private to their launching user.
  try {
    if (run.projectId) {
      await requireProjectRole(run.projectId, "viewer");
    } else {
      await assertLocalPackageAssistantActor(run, sessionUser.id, {
        requireLock: false,
      });
    }
  } catch (err) {
    if (isMaisterError(err)) {
      const status = httpStatusForAuthz(err.code) ?? 500;

      return NextResponse.json(
        { code: err.code, message: err.message },
        { status },
      );
    }
    throw err;
  }

  const startedAt = Date.now();

  log.info(
    {
      runId,
      currentStepId: run.currentStepId,
      replayEvents,
      status: run.status,
    },
    "stream connect",
  );

  let replayCursor: bigint | null = null;

  if (replayEvents) {
    try {
      replayCursor = parseCanonicalLastEventId(req);
    } catch (error) {
      return NextResponse.json(
        {
          code: "PRECONDITION",
          message:
            error instanceof Error
              ? error.message
              : "invalid canonical run stream cursor",
        },
        { status: 400 },
      );
    }
  }

  return canonicalRunEventStream({
    req,
    run,
    replayEvents,
    replayCursor,
    startedAt,
  });
}
