import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type {
  SupervisorEvent,
  SupervisorPermissionOption,
} from "@/lib/supervisor-client";

import { and, asc, eq, gt } from "drizzle-orm";

import { runEventWakeBus } from "./run-wake";

import { executionEvents } from "@/lib/db/schema";

const REPLAY_BATCH_SIZE = 200;
const WAKE_TIMEOUT_MS = 1_000;

function stringField(
  payload: Record<string, unknown> | null,
  name: string,
): string | null {
  const value = payload?.[name];

  return typeof value === "string" ? value : null;
}

function integerField(
  payload: Record<string, unknown> | null,
  name: string,
): number | null {
  const value = payload?.[name];

  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}

function optionsField(
  payload: Record<string, unknown> | null,
): ReadonlyArray<SupervisorPermissionOption> | null {
  const value = payload?.options;

  if (!Array.isArray(value)) return null;
  const options: SupervisorPermissionOption[] = [];

  for (const option of value) {
    if (!option || typeof option !== "object" || Array.isArray(option)) {
      return null;
    }
    const candidate = option as Record<string, unknown>;

    if (typeof candidate.optionId !== "string") return null;
    options.push({
      optionId: candidate.optionId,
      ...(typeof candidate.kind === "string" ? { kind: candidate.kind } : {}),
      ...(typeof candidate.name === "string" ? { name: candidate.name } : {}),
    });
  }

  return options;
}

type CanonicalSessionEventRow = {
  eventType: string;
  hostSessionId: string | null;
  payload: Record<string, unknown> | null;
  runSequence: bigint | null;
};

// `SupervisorEvent.monotonicId` was a host-local per-session value. Canonical
// consumers use the manager-owned run sequence instead: it is durable across
// reconnects and remains an integer within the browser-safe replay horizon.
function canonicalMonotonicId(row: CanonicalSessionEventRow): number | null {
  if (
    row.runSequence === null ||
    row.runSequence < 0n ||
    row.runSequence > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return null;
  }

  return Number(row.runSequence);
}

export function supervisorEventFromCanonicalRow(
  row: CanonicalSessionEventRow,
): SupervisorEvent | null {
  const sessionId = row.hostSessionId;
  const monotonicId = canonicalMonotonicId(row);

  if (!sessionId || monotonicId === null) return null;

  switch (row.eventType) {
    case "session.line": {
      const line = stringField(row.payload, "line");

      return line === null
        ? null
        : { type: "session.line", sessionId, monotonicId, line };
    }
    case "session.update":
      return row.payload?.update === undefined
        ? null
        : {
            type: "session.update",
            sessionId,
            monotonicId,
            update: row.payload.update,
          };
    case "session.permission_request": {
      const requestId = stringField(row.payload, "requestId");
      const options = optionsField(row.payload);

      if (
        requestId === null ||
        options === null ||
        row.payload?.toolCall === undefined
      )
        return null;

      return {
        type: "session.permission_request",
        sessionId,
        monotonicId,
        requestId,
        options,
        toolCall: row.payload.toolCall,
      };
    }
    case "session.exited": {
      const exitCode = integerField(row.payload, "exitCode");
      const reason = row.payload?.reason;

      if (
        exitCode === null ||
        (reason !== undefined &&
          reason !== "checkpoint" &&
          reason !== "intentional" &&
          reason !== "fenced")
      )
        return null;

      return {
        type: "session.exited",
        sessionId,
        monotonicId,
        exitCode,
        ...(reason ? { reason } : {}),
      };
    }
    case "session.crashed": {
      const exitCode = row.payload?.exitCode;
      const signal = row.payload?.signal;

      if (
        (exitCode !== null && !Number.isSafeInteger(exitCode)) ||
        (signal !== null && typeof signal !== "string")
      )
        return null;

      return {
        type: "session.crashed",
        sessionId,
        monotonicId,
        exitCode: exitCode as number | null,
        signal: signal as string | null,
      };
    }
    case "session.chat_turn": {
      const hitlRequestId = stringField(row.payload, "hitlRequestId");
      const role = row.payload?.role;
      const body = stringField(row.payload, "body");
      const seq = integerField(row.payload, "seq");

      if (
        hitlRequestId === null ||
        (role !== "user" && role !== "agent") ||
        body === null
      )
        return null;

      return {
        type: "session.chat_turn",
        sessionId,
        monotonicId,
        hitlRequestId,
        role,
        body,
        ...(seq === null ? {} : { seq }),
        ...(typeof row.payload?.mutationReverted === "boolean"
          ? { mutationReverted: row.payload.mutationReverted }
          : {}),
      };
    }
    case "session.hook_trip": {
      const rule = row.payload?.rule;
      const lifecycle = row.payload?.lifecycle;
      const disposition = row.payload?.disposition;

      if (
        (rule !== "path_guard" &&
          rule !== "repetition" &&
          rule !== "no_progress" &&
          rule !== "capability_guard") ||
        (lifecycle !== "pre_tool_call" && lifecycle !== "post_turn") ||
        (disposition !== "deny" && disposition !== "halt") ||
        row.payload?.toolCall === undefined
      )
        return null;

      return {
        type: "session.hook_trip",
        sessionId,
        monotonicId,
        rule,
        lifecycle,
        disposition,
        toolCall: row.payload.toolCall,
      };
    }
    case "session.command": {
      const commandId = stringField(row.payload, "commandId");
      const kind = row.payload?.kind;
      const phase = row.payload?.phase;
      const status = row.payload?.status;

      if (
        commandId === null ||
        (kind !== "session.prompt" &&
          kind !== "session.input" &&
          kind !== "session.cancel" &&
          kind !== "session.checkpoint" &&
          kind !== "session.delete") ||
        (phase !== "accepted" && phase !== "completed") ||
        (status !== undefined &&
          status !== "succeeded" &&
          status !== "failed" &&
          status !== "fenced")
      )
        return null;
      const error = row.payload?.error;

      if (
        error !== undefined &&
        (!error || typeof error !== "object" || Array.isArray(error))
      )
        return null;

      return {
        type: "session.command",
        sessionId,
        monotonicId,
        commandId,
        kind,
        phase,
        ...(status ? { status } : {}),
        ...(row.payload?.result &&
        typeof row.payload.result === "object" &&
        !Array.isArray(row.payload.result)
          ? { result: row.payload.result as Record<string, unknown> }
          : {}),
        ...(error
          ? {
              error: error as {
                code: string;
                message: string;
                details?: Record<string, unknown>;
              },
            }
          : {}),
      };
    }
    default:
      return null;
  }
}

// The canonical replacement for host `GET /sessions/:id/stream`. It is a
// manager-owned replay cursor: a restart resumes from durable execution_events
// and an in-process wake only reduces latency. This intentionally does not
// proxy a host SSE connection or inspect any runtime file.
export async function* streamCanonicalSessionEvents(input: {
  db: Db;
  runId: string;
  hostSessionId: string;
  lastEventId?: number;
  signal?: AbortSignal;
}): AsyncGenerator<SupervisorEvent, void, void> {
  let after = BigInt(input.lastEventId ?? -1);

  while (true) {
    const queryStartedAfterAbort = input.signal?.aborted ?? false;
    const rows = await input.db
      .select({
        eventType: executionEvents.eventType,
        hostSessionId: executionEvents.hostSessionId,
        payload: executionEvents.payload,
        runSequence: executionEvents.runSequence,
      })
      .from(executionEvents)
      .where(
        and(
          eq(executionEvents.runId, input.runId),
          eq(executionEvents.hostSessionId, input.hostSessionId),
          eq(executionEvents.ingestDisposition, "accepted"),
          gt(executionEvents.runSequence, after),
        ),
      )
      .orderBy(asc(executionEvents.runSequence))
      .limit(REPLAY_BATCH_SIZE);

    for (const row of rows) {
      if (row.runSequence === null) continue;
      after = row.runSequence;
      const event = supervisorEventFromCanonicalRow(row);

      if (!event) continue;
      yield event;
      if (event.type === "session.exited" || event.type === "session.crashed")
        return;
    }
    if (rows.length === REPLAY_BATCH_SIZE) continue;
    if (input.signal?.aborted) {
      // A prompt completion and its final output event can commit while the
      // reader's previous SELECT is in flight. Always perform one SELECT that
      // starts after cancellation before closing, so persisted output cannot
      // be lost to that race.
      if (queryStartedAfterAbort) return;

      continue;
    }
    await runEventWakeBus.wait(input.runId, WAKE_TIMEOUT_MS, input.signal);
  }
}
