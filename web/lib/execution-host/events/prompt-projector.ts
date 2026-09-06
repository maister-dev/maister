import "server-only";

import type { CommandReceipt } from "@/lib/execution-host/contracts";
import type { Db } from "@/lib/execution-host/db";

import { and, eq } from "drizzle-orm";

import { CANONICAL_PROJECTION_CONSUMERS } from "./projection-consumers";
import { preparePromptContent } from "./session-content";
import {
  projectExecutionEvents,
  type ExecutionEventProjectorSummary,
  type ExecutionEventProjector,
} from "./projector";
import { ExecutionEventProjectionError } from "./projector";

import { commandSignals } from "@/lib/execution-host/signals";
import { getCommand } from "@/lib/execution-host/commands";
import { defaultTransport } from "@/lib/execution-host/default-transport";
import {
  depositPromptReceipt,
  recordPromptEvent,
} from "@/lib/execution-host/prompt-evidence";
import { isMaisterError } from "@/lib/errors";
import {
  executionAssignments,
  runs,
  type ExecutionEvent,
} from "@/lib/db/schema";

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
    throw new ExecutionEventProjectionError(
      "host session.command event is missing its assignment fence",
      true,
    );
  }
  const runRows = await tx
    .select({ executionDataPlaneMode: runs.executionDataPlaneMode })
    .from(runs)
    .where(eq(runs.id, event.runId))
    .limit(1);
  const run = runRows[0];

  if (!run)
    throw new ExecutionEventProjectionError(
      "session.command event references a missing run",
      true,
    );

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
  if (event.payload?.kind !== "session.prompt") return;
  if (!(await hasCanonicalCommandFence(tx, event))) return;
  await recordPromptEvent(tx, event);
}

async function preparePromptEvidence(
  db: Db,
  event: ExecutionEvent,
  signal: AbortSignal,
): Promise<ExecutionEvent> {
  const prepared = await preparePromptContent(db, event, signal);
  const commandId = prepared.payload?.commandId;

  if (
    prepared.eventType !== "session.command" ||
    prepared.payload?.kind !== "session.prompt" ||
    prepared.payload.phase === "accepted" ||
    typeof commandId !== "string"
  )
    return prepared;
  const command = await getCommand(db, commandId);

  if (!command || command.receiptEvidence) return prepared;
  let receipt: CommandReceipt | null;

  try {
    receipt = await defaultTransport().getCommandReceipt(commandId);
  } catch (error) {
    if (signal.aborted) throw error;
    if (!isMaisterError(error) || error.code !== "EXECUTOR_UNAVAILABLE")
      throw error;

    return prepared;
  }
  if (receipt) await depositPromptReceipt(db, commandId, receipt);

  return prepared;
}

export const canonicalPromptProjector: ExecutionEventProjector = {
  prepare: preparePromptEvidence,
  consumerName: CANONICAL_PROJECTION_CONSUMERS.prompt,
  project: projectPromptCommand,
  afterCommit: (events) => {
    for (const event of events) {
      if (event.eventType !== "session.command") continue;
      const commandId = event.payload?.commandId;

      if (typeof commandId === "string") commandSignals.wake(commandId);
    }
  },
};

// The projector records canonical evidence through the shared reducer. The
// cursor, evidence identity and any agreed transition share one transaction;
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
    projector: canonicalPromptProjector,
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
