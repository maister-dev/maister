import "server-only";

import type { ExecutionEvent } from "@/lib/db/schema";
import type { Db } from "@/lib/execution-host/db";
import type { ContextSnapshot } from "@/lib/runs/context-snapshot";

import { and, asc, desc, eq, gt, isNotNull, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import {
  httpStatusForAuthz,
  requireActiveSession,
  requireActiveUserById,
  requireProjectRoleForUser,
} from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { assertCompanyRunReadAccess } from "@/lib/agents/company-run-read-access";
import {
  assertRunKnowledgeDisclosure,
  isRunKnowledgeUnavailable,
} from "@/lib/brain/knowledge-run-disclosure";
import { FINDINGS_CONTRACT } from "@/lib/run-results/findings-contract";
import {
  contextProjectionThrough,
  readContextSnapshot,
  readCurrentAttemptId,
} from "@/lib/runs/context-reader";
import { executionEvents, runs } from "@/lib/db/schema";
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
const AUTH_RECHECK_INTERVAL_MS = 2_500;
const CONTEXT_SNAPSHOT_COALESCE_MS = 500;

type RouteParams = { params: Promise<{ runId: string }> };

type RunLite = {
  id: string;
  runKind: string;
  status: string;
  currentStepId: string | null;
  projectId: string | null;
  companyId: string | null;
  createdByUserId: string | null;
  localPackageId: string | null;
  isGoverned: boolean;
};

function runGovernedSql() {
  return sql<boolean>`COALESCE(
    ${runs.knowledgeAccess} IS NOT NULL
    OR ${runs.resultContract}->>'nativeContract' = ${FINDINGS_CONTRACT}
    OR EXISTS (
      SELECT 1 FROM agent_memory_injections memory
      WHERE memory.run_id = ${runs.id}
        AND memory.application_state <> 'retired'
    ),
    false
  )`;
}

async function isRunGoverned(runId: string): Promise<boolean> {
  const db = getDb() as unknown as Db;
  const rows = await db
    .select({ isGoverned: runGovernedSql() })
    .from(runs)
    .where(eq(runs.id, runId));

  return rows[0]?.isGoverned === true;
}

async function loadRunLite(runId: string): Promise<RunLite | null> {
  const db = getDb() as unknown as Db;
  const rows = await db
    .select({
      id: runs.id,
      runKind: runs.runKind,
      status: runs.status,
      currentStepId: runs.currentStepId,
      projectId: runs.projectId,
      companyId: runs.companyId,
      createdByUserId: runs.createdByUserId,
      localPackageId: runs.localPackageId,
      isGoverned: runGovernedSql(),
    })
    .from(runs)
    .where(eq(runs.id, runId));

  const row: RunLite | undefined = rows[0];

  if (!row) return null;

  return {
    id: row.id,
    runKind: row.runKind,
    status: row.status,
    currentStepId: row.currentStepId,
    projectId: row.projectId,
    companyId: row.companyId,
    createdByUserId: row.createdByUserId,
    localPackageId: row.localPackageId,
    isGoverned: row.isGoverned === true,
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

type CanonicalRunEvent = Pick<
  ExecutionEvent,
  "id" | "runSequence" | "eventType" | "occurredAt" | "hostSessionId"
> & {
  payloadIsNull: boolean;
  contextUsageOnly?: boolean;
};

async function readCanonicalRunEvents(
  runId: string,
  afterSequence: bigint,
  context: boolean,
): Promise<CanonicalRunEvent[]> {
  const db = getDb() as unknown as Db;
  const baseColumns = {
    id: executionEvents.id,
    runSequence: executionEvents.runSequence,
    eventType: executionEvents.eventType,
    occurredAt: executionEvents.occurredAt,
    hostSessionId: executionEvents.hostSessionId,
    payloadIsNull: sql<boolean>`${executionEvents.payload} IS NULL`,
  };
  const columns = context
    ? {
        ...baseColumns,
        contextUsageOnly: sql<boolean>`COALESCE(CASE
          WHEN ${executionEvents.eventType} = 'session.update' THEN
            jsonb_typeof(${executionEvents.payload}) = 'object'
            AND (
              ${executionEvents.payload}->>'contextType' = 'usage_update'
              OR (
                jsonb_typeof(${executionEvents.payload}->'update') = 'object'
                AND ${executionEvents.payload}->'update'->>'sessionUpdate' = 'usage_update'
              )
            )
          WHEN ${executionEvents.eventType} = 'session.line' THEN
            jsonb_typeof(${executionEvents.payload}) = 'object'
            AND ${executionEvents.payload}->'contextUsageOnly' = 'true'::jsonb
          ELSE false
        END, false)`,
      }
    : baseColumns;

  return db
    .select(columns)
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

function buildCanonicalBrowserEvent(
  event: CanonicalRunEvent,
  context: boolean,
): Record<string, unknown> {
  const contextUsageOnly = context && event.contextUsageOnly === true;

  return {
    type: event.eventType,
    eventId: event.id,
    runSequence: String(event.runSequence),
    occurredAt:
      event.occurredAt instanceof Date
        ? event.occurredAt.toISOString()
        : String(event.occurredAt),
    hostSessionId: event.hostSessionId ?? null,
    ...(contextUsageOnly ? { contextUsageOnly: true } : {}),
  };
}

function serializeContextState(
  snapshot: ContextSnapshot | null,
): string | null {
  if (!snapshot) return null;

  // A newer observation is useful for selection, but alone changes no state.
  return JSON.stringify({
    ...snapshot,
    bindingObservedAt: undefined,
  });
}

function canonicalRunEventStream(input: {
  req: NextRequest;
  userId: string;
  run: RunLite;
  replayEvents: boolean;
  replayCursor: bigint | null;
  startedAt: number;
  context: boolean;
}): Response {
  const cancellation = new AbortController();
  const signal = AbortSignal.any([input.req.signal, cancellation.signal]);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let cursor = input.replayEvents ? (input.replayCursor ?? -1n) : -1n;
      let governed = input.run.companyId !== null || input.run.isGoverned;
      const trackContext = input.context && input.run.runKind !== "librarian";
      const isFlow = input.run.runKind === "flow";
      let eventsSent = 0;
      let authChecks = 0;
      let contextReads = 0;
      let lastStatusCheck = Date.now();
      let lastAuthCheck = input.startedAt;
      let lastContextReadAt: number | null = null;
      let pendingContextSettle = false;
      let forceFinalContextRead = false;
      const maxQuietMs = keepaliveMs();
      let lastEventAt = Date.now();
      let lastContext = "";
      let lastAttemptContext = "";
      let terminalDeadline: number | null = null;
      let terminalProjectionCursor: bigint | null = null;
      const close = (): void => {
        try {
          controller.close();
        } catch {
          // The client may have aborted while a database read completed.
        }
      };
      const verifyStreamAuth = async (): Promise<void> => {
        const now = Date.now();
        const elapsedMs = now - lastAuthCheck;

        if (input.run.companyId) {
          await assertCompanyRunReadAccess(getDb(), input.userId, input.run.id);
        } else {
          if (input.run.projectId) {
            await requireProjectRoleForUser(
              input.userId,
              input.run.projectId,
              "viewer",
            );
          } else {
            await requireActiveUserById(input.userId);
          }
          await assertRunKnowledgeDisclosure(
            getDb(),
            { kind: "user", userId: input.userId },
            input.run.id,
          );
        }
        lastAuthCheck = now;
        authChecks += 1;
        log.debug(
          { runId: input.run.id, governed, elapsedMs },
          "stream auth recheck",
        );
      };

      try {
        if (!input.replayEvents) {
          cursor = await latestCanonicalRunSequence(input.run.id);
          if (signal.aborted) return;
          controller.enqueue(
            encoder.encode(
              formatSyntheticSseEvent(JSON.stringify(streamReadyEvent())),
            ),
          );
        }

        while (!signal.aborted) {
          const events = await readCanonicalRunEvents(
            input.run.id,
            cursor,
            input.context,
          );
          let context: ContextSnapshot | null = null;
          let attemptContext: ContextSnapshot | null = null;

          if (trackContext) {
            const nowBeforeContext = Date.now();
            const shouldReadContext =
              forceFinalContextRead ||
              lastContextReadAt === null ||
              nowBeforeContext - lastContextReadAt >=
                CONTEXT_SNAPSHOT_COALESCE_MS ||
              (events.length === 0 && pendingContextSettle);

            if (shouldReadContext) {
              const db = getDb();
              const [nextContext, attemptId] = await Promise.all([
                readContextSnapshot(db, input.run.id),
                isFlow
                  ? readCurrentAttemptId(db, input.run.id)
                  : Promise.resolve(null),
              ]);

              context = nextContext;
              attemptContext = attemptId
                ? await readContextSnapshot(db, input.run.id, attemptId)
                : null;
              lastContextReadAt = Date.now();
              contextReads += 1;
              forceFinalContextRead = false;
              pendingContextSettle = events.length > 0;
            } else {
              if (events.length > 0) pendingContextSettle = true;
              log.debug(
                { runId: input.run.id, coalesced: true, changed: false },
                "context snapshot coalesced",
              );
            }
          }

          const nextContextState = serializeContextState(context);
          const nextAttemptContextState = serializeContextState(attemptContext);
          const contextChanged =
            (nextContextState !== null && nextContextState !== lastContext) ||
            (nextAttemptContextState !== null &&
              nextAttemptContextState !== lastAttemptContext);

          if (trackContext && context !== null) {
            log.debug(
              {
                runId: input.run.id,
                coalesced: false,
                changed: contextChanged,
              },
              "context snapshot read",
            );
          }

          let checkedStatus = false;
          let runStatus: {
            status: string;
            currentStepId: string | null;
          } | null = null;

          if (
            terminalProjectionCursor !== null ||
            Date.now() - lastStatusCheck >= STATUS_REFRESH_MS
          ) {
            lastStatusCheck = Date.now();
            runStatus = await refreshRunStatus(input.run.id);
            checkedStatus = true;
            if (!runStatus) break;
          }

          const isTerminal =
            runStatus !== null && TERMINAL_RUN_STATUS.has(runStatus.status);
          const hasOutgoing = events.length > 0 || contextChanged;
          let verifiedThisIteration = false;

          if (!governed && hasOutgoing && (await isRunGoverned(input.run.id))) {
            governed = true;
            log.debug(
              { runId: input.run.id },
              "[FIX:vault-enroll] run promoted to governed mid-stream",
            );
          }

          if (
            (governed && hasOutgoing) ||
            (isTerminal && hasOutgoing) ||
            Date.now() - lastAuthCheck >= AUTH_RECHECK_INTERVAL_MS
          ) {
            await verifyStreamAuth();
            verifiedThisIteration = true;
          }
          if (signal.aborted) break;

          if (
            context &&
            nextContextState !== null &&
            nextContextState !== lastContext
          ) {
            controller.enqueue(
              encoder.encode(formatSyntheticSseEvent(JSON.stringify(context))),
            );
            lastContext = nextContextState;
            lastEventAt = Date.now();
          }
          if (
            attemptContext &&
            nextAttemptContextState !== null &&
            nextAttemptContextState !== lastAttemptContext
          ) {
            controller.enqueue(
              encoder.encode(
                formatSyntheticSseEvent(JSON.stringify(attemptContext)),
              ),
            );
            lastAttemptContext = nextAttemptContextState;
            lastEventAt = Date.now();
          }

          for (const event of events) {
            const sequence = event.runSequence;

            if (typeof sequence !== "bigint") {
              throw new Error(
                "canonical run event is missing a bigint run sequence",
              );
            }
            cursor = sequence;
            if (input.run.runKind === "librarian" && event.payloadIsNull)
              continue;
            controller.enqueue(
              encoder.encode(
                formatSseEvent(
                  sequence.toString(),
                  JSON.stringify(
                    buildCanonicalBrowserEvent(event, input.context),
                  ),
                ),
              ),
            );
            eventsSent += 1;
            lastEventAt = Date.now();
          }

          if (checkedStatus && isTerminal) {
            if (!trackContext) {
              if (!verifiedThisIteration) await verifyStreamAuth();
              break;
            }
            terminalDeadline ??= Date.now() + 3_000;
            if (
              events.length < 500 &&
              (await contextProjectionThrough(getDb(), input.run.id, cursor))
            ) {
              if (terminalProjectionCursor === cursor) {
                if (!verifiedThisIteration) await verifyStreamAuth();
                break;
              }
              // Read once after observing the committed projection watermark.
              terminalProjectionCursor = cursor;
              forceFinalContextRead = true;
              continue;
            }
            if (Date.now() >= terminalDeadline) {
              log.warn(
                { runId: input.run.id },
                "context stream closed with pending projection",
              );
              if (!verifiedThisIteration) await verifyStreamAuth();
              break;
            }
          }
          if (Date.now() - lastEventAt > maxQuietMs) {
            if (signal.aborted) break;
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
          const remainingAuthMs = Math.max(
            1,
            AUTH_RECHECK_INTERVAL_MS - (Date.now() - lastAuthCheck),
          );
          const wakeTimeoutMs = Math.min(
            CANONICAL_WAKE_TIMEOUT_MS,
            remainingAuthMs,
          );

          await runEventWakeBus.wait(input.run.id, wakeTimeoutMs, signal);
        }
      } catch (error) {
        log.warn(
          {
            runId: input.run.id,
            code: isMaisterError(error) ? error.code : "CRASH",
            reason: isMaisterError(error)
              ? error.details?.reason
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
            authChecks,
            contextReads,
            durationMs: Date.now() - input.startedAt,
            source: "canonical_events",
          },
          "stream disconnect",
        );
      }
    },
    cancel(reason: unknown) {
      cancellation.abort(reason);
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

  // Derive ownership from the retained Run; company reads require explicit current grants.
  try {
    if (run.companyId) {
      await assertCompanyRunReadAccess(getDb(), sessionUser.id, runId);
    } else if (run.projectId) {
      await requireProjectRoleForUser(sessionUser.id, run.projectId, "viewer");
    } else {
      await assertLocalPackageAssistantActor(run, sessionUser.id, {
        requireLock: false,
      });
    }
    await assertRunKnowledgeDisclosure(
      getDb(),
      { kind: "user", userId: sessionUser.id },
      runId,
    );
  } catch (err) {
    if (isMaisterError(err)) {
      const status =
        (err.details?.reason === "run_unavailable" ? 404 : null) ??
        httpStatusForAuthz(err.code) ??
        (isRunKnowledgeUnavailable(err) ? 409 : 500);

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
    userId: sessionUser.id,
    run,
    replayEvents,
    replayCursor,
    startedAt,
    context: new URL(req.url).searchParams.get("context") === "1",
  });
}
