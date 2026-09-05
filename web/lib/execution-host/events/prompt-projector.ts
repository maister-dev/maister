import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { isDeepStrictEqual } from "node:util";

import { and, eq } from "drizzle-orm";

import {
  ExecutionEventProjectionError,
  projectExecutionEvents,
  type ExecutionEventProjectorSummary,
} from "./projector";

import { commandSignals } from "@/lib/execution-host/signals";
import {
  markAccepted,
  markFailed,
  markFenced,
  markSucceeded,
} from "@/lib/execution-host/commands";
import {
  executionAssignments,
  executionCommands,
  runs,
  type ExecutionEvent,
} from "@/lib/db/schema";

type PromptCommandPayload = {
  commandId: string;
  kind: "session.prompt";
  phase: "accepted" | "completed";
  status?: "succeeded" | "failed" | "fenced";
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
};

const COMMAND_CONSUMER_NAME = "canonical-prompt-command-v1";

function projectionError(reason: string): ExecutionEventProjectionError {
  return new ExecutionEventProjectionError(reason, true);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw projectionError(`session.command ${field} must be an object`);
  }

  return value as Record<string, unknown>;
}

function parsePromptCommandPayload(
  payload: Record<string, unknown> | null,
): PromptCommandPayload | null {
  if (!payload) throw projectionError("session.command payload is missing");
  if (payload.kind !== "session.prompt") return null;
  if (typeof payload.commandId !== "string" || payload.commandId.length === 0) {
    throw projectionError("session.prompt event is missing commandId");
  }
  if (payload.phase !== "accepted" && payload.phase !== "completed") {
    throw projectionError("session.prompt event has an invalid phase");
  }
  if (
    payload.status !== undefined &&
    payload.status !== "succeeded" &&
    payload.status !== "failed" &&
    payload.status !== "fenced"
  ) {
    throw projectionError("session.prompt event has an invalid status");
  }

  return {
    commandId: payload.commandId,
    kind: "session.prompt",
    phase: payload.phase,
    ...(payload.status ? { status: payload.status } : {}),
    ...(payload.result === undefined
      ? {}
      : { result: record(payload.result, "result") }),
    ...(payload.error === undefined
      ? {}
      : { error: record(payload.error, "error") }),
  };
}

function sameJson(
  left: Record<string, unknown> | null,
  right: Record<string, unknown> | null,
): boolean {
  return isDeepStrictEqual(left, right);
}

async function hasCanonicalCommandFence(
  tx: Db,
  event: ExecutionEvent,
): Promise<boolean> {
  if (event.source !== "host") return false;
  if (
    !event.executionAssignmentId ||
    !event.executionHostId ||
    event.assignmentEpoch === null
  ) {
    throw projectionError(
      "host session.command event is missing its assignment fence",
    );
  }
  const runRows = await tx
    .select({ executionDataPlaneMode: runs.executionDataPlaneMode })
    .from(runs)
    .where(eq(runs.id, event.runId))
    .limit(1);
  const run = runRows[0];

  if (!run)
    throw projectionError("session.command event references a missing run");

  const assignments = await tx
    .select({ id: executionAssignments.id })
    .from(executionAssignments)
    .where(
      and(
        eq(executionAssignments.id, event.executionAssignmentId),
        eq(executionAssignments.runId, event.runId),
        eq(executionAssignments.executionHostId, event.executionHostId),
        eq(executionAssignments.epoch, event.assignmentEpoch),
      ),
    )
    .limit(1);

  // Ingest accepts a released-assignment command event only when it is bound
  // to an exact durable command identity. Re-check the immutable assignment
  // boundary here; the command row check below prevents the event from
  // addressing any command owned by a newer epoch.
  return Boolean(assignments[0]);
}

async function projectPromptCommand(
  tx: Db,
  event: ExecutionEvent,
): Promise<void> {
  if (event.eventType !== "session.command") return;
  const payload = parsePromptCommandPayload(event.payload);

  if (!payload) return;
  if (!(await hasCanonicalCommandFence(tx, event))) return;

  const commands = await tx
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.id, payload.commandId))
    .for("update")
    .limit(1);
  const command = commands[0];

  if (!command) {
    throw projectionError(
      `session.prompt event references unknown command ${payload.commandId}`,
    );
  }
  if (
    command.runId !== event.runId ||
    command.executionAssignmentId !== event.executionAssignmentId ||
    command.executionHostId !== event.executionHostId ||
    command.assignmentEpoch !== event.assignmentEpoch ||
    command.kind !== "session.prompt"
  ) {
    throw projectionError(
      `session.prompt command fence mismatch for ${payload.commandId}`,
    );
  }

  if (payload.phase === "accepted") {
    if (
      command.state === "succeeded" ||
      command.state === "failed" ||
      command.state === "fenced"
    ) {
      return;
    }
    await markAccepted(tx, command.id, null);

    return;
  }

  if (!payload.status) {
    throw projectionError(
      `session.prompt terminal event has no status for ${command.id}`,
    );
  }
  if (payload.status === "succeeded") {
    const result = payload.result ?? null;

    if (!result || typeof result.stopReason !== "string") {
      throw projectionError(
        `session.prompt success event has no stopReason for ${command.id}`,
      );
    }
    if (command.state === "succeeded") {
      if (!sameJson(command.result, result)) {
        throw projectionError(`prompt_terminal_conflict for ${command.id}`);
      }

      return;
    }
    if (command.state === "failed" || command.state === "fenced") {
      throw projectionError(`prompt_terminal_conflict for ${command.id}`);
    }
    await markSucceeded(tx, command.id, null, result);

    return;
  }

  const error = payload.error ?? {
    code: "ACP_PROTOCOL",
    message: "prompt failed",
  };
  const target = payload.status === "fenced" ? "fenced" : "failed";

  if (command.state === target) {
    if (!sameJson(command.lastError, error)) {
      throw projectionError(`prompt_terminal_conflict for ${command.id}`);
    }

    return;
  }
  if (
    command.state === "succeeded" ||
    command.state === "failed" ||
    command.state === "fenced"
  ) {
    throw projectionError(`prompt_terminal_conflict for ${command.id}`);
  }
  if (target === "fenced") {
    await markFenced(tx, command.id, null, error);
  } else {
    await markFailed(tx, command.id, null, error);
  }
}

// The sole terminal authority for canonical prompt commands. The consumer
// cursor, command transition, and conflict detection share one transaction;
// the post-commit wake carries no result payload and cannot be authoritative.
export async function projectCanonicalPromptCommands(input: {
  db: Db;
  runId: string;
  now?: Date;
  batchSize?: number;
}): Promise<ExecutionEventProjectorSummary> {
  return projectExecutionEvents({
    db: input.db,
    runId: input.runId,
    now: input.now,
    batchSize: input.batchSize,
    projector: {
      consumerName: COMMAND_CONSUMER_NAME,
      project: projectPromptCommand,
      afterCommit: (events) => {
        for (const event of events) {
          if (event.eventType !== "session.command") continue;
          const commandId = event.payload?.commandId;

          if (typeof commandId === "string") commandSignals.wake(commandId);
        }
      },
    },
  });
}

// Boot/reconnect reconciliation reads the durable event ledger once. It is not
// filesystem polling and it is safe to repeat: each run owns a cursor.
export async function projectPendingCanonicalPromptCommands(input: {
  db: Db;
  batchSize?: number;
}): Promise<number> {
  const runRows = await input.db.select({ id: runs.id }).from(runs);
  let projected = 0;

  for (const run of runRows) {
    const summary = await projectCanonicalPromptCommands({
      db: input.db,
      runId: run.id,
      batchSize: input.batchSize,
    });

    projected += summary.projected;
  }

  return projected;
}
