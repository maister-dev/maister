import "server-only";

import type { Db } from "./db";
import type { ExecutionCommand } from "@/lib/db/schema";
import type { CommandReceipt } from "./contracts";

import { and, eq, sql } from "drizzle-orm";

import { executionEvents } from "@/lib/db/schema";

export function isRejectedPermissionInputReceipt(
  receipt: CommandReceipt,
): boolean {
  return (
    receipt.kind === "session.input" &&
    receipt.phase === "rejected" &&
    receipt.httpStatus === 410 &&
    receipt.body?.code === "HITL_TIMEOUT"
  );
}

type PermissionResultCommand = ExecutionCommand &
  (
    | Readonly<{ state: "succeeded" }>
    | Readonly<{
        state: "failed";
        lastError: NonNullable<ExecutionCommand["lastError"]>;
      }>
  );

/** Only agreed terminal evidence can cross a released assignment. Protocol and
 * adapter-unavailable failures retain their ordinary action/verdict semantics.
 * A terminal code alone does not authorize an interrupted-turn continuation.
 */
export function isPermissionResultCommand(
  command: ExecutionCommand,
): command is PermissionResultCommand {
  return (
    command.requestSha256 !== null &&
    command.terminalEvidenceSha256 !== null &&
    command.applicationError?.reason !== "prompt_terminal_conflict" &&
    (command.state === "succeeded" ||
      (command.state === "failed" &&
        (command.lastError?.code === "ACP_PROTOCOL" ||
          command.lastError?.code === "EXECUTOR_UNAVAILABLE")))
  );
}

export function isPermissionCheckpointInterruption(
  command: ExecutionCommand,
): boolean {
  return (
    isPermissionResultCommand(command) &&
    command.state === "failed" &&
    command.lastError?.code === "ACP_PROTOCOL"
  );
}

/** Teardown can itself cause a protocol failure. Compare durable host positions
 * to distinguish that interruption from an earlier failure. A complete response
 * or explicit adapter error retains its result even during checkpoint teardown.
 */
export async function permissionCheckpointOrder(
  db: Db,
  command: ExecutionCommand,
  checkpoint: ExecutionCommand,
): Promise<"before_checkpoint" | "after_checkpoint" | "unproven"> {
  if (!command.terminalEventId || !command.targetSessionId) return "unproven";
  const boundary = and(
    eq(executionEvents.source, "host"),
    eq(executionEvents.runId, command.runId),
    eq(executionEvents.executionHostId, command.executionHostId),
    eq(executionEvents.executionAssignmentId, command.executionAssignmentId),
    eq(executionEvents.assignmentEpoch, command.assignmentEpoch),
    eq(executionEvents.hostSessionId, command.targetSessionId),
    eq(executionEvents.eventType, "session.command"),
    eq(executionEvents.ingestDisposition, "accepted"),
  );
  const [terminal] = await db
    .select()
    .from(executionEvents)
    .where(and(boundary, eq(executionEvents.id, command.terminalEventId)));
  const admissions = await db
    .select()
    .from(executionEvents)
    .where(
      and(
        boundary,
        sql`${executionEvents.payload}->>'commandId' = ${checkpoint.id}`,
        sql`${executionEvents.payload}->>'kind' = 'session.checkpoint'`,
        sql`${executionEvents.payload}->>'phase' = 'accepted'`,
      ),
    )
    .limit(2);
  const accepted = admissions[0];

  if (
    !(
      terminal &&
      terminal.payload?.commandId === command.id &&
      terminal.payload.kind === "session.prompt" &&
      terminal.payload.phase ===
        (command.state === "succeeded" ? "completed" : "rejected") &&
      admissions.length === 1 &&
      accepted.eventStreamId !== null &&
      accepted.eventStreamId === terminal.eventStreamId &&
      accepted.hostSequence !== null &&
      terminal.hostSequence !== null
    )
  )
    return "unproven";

  return terminal.hostSequence! < accepted.hostSequence!
    ? "before_checkpoint"
    : "after_checkpoint";
}

export async function isPermissionResultHandoff(
  db: Db,
  command: ExecutionCommand,
  checkpoint: ExecutionCommand,
): Promise<boolean> {
  const order = await permissionCheckpointOrder(db, command, checkpoint);

  return (
    isPermissionResultCommand(command) &&
    (order === "before_checkpoint" ||
      (order === "after_checkpoint" &&
        !isPermissionCheckpointInterruption(command)))
  );
}
