import "server-only";

import type { Db } from "./db";
import type { ExecutionCommand } from "@/lib/db/schema";
import type { CommandReceipt } from "./contracts";

import { and, eq, sql } from "drizzle-orm";

import { executionEvents } from "@/lib/db/schema";

function isPermissionInputTimeout(receipt: CommandReceipt): boolean {
  return (
    receipt.kind === "session.input" &&
    receipt.phase === "rejected" &&
    receipt.httpStatus === 410 &&
    receipt.body?.code === "HITL_TIMEOUT"
  );
}

/** ADR-180: the 410 that says the SESSION was parked with its deferreds
 * cancelled — NOT that the answer expired.
 *
 * The stored answer is still good: the resumed session re-issues the
 * permission and the driver delivers the same intent against the new request
 * id. Reading this receipt as a rejection is precisely the defect ADR-180
 * removes — it routes an answered permission into `Failed`.
 */
export function isCheckpointedPermissionInputReceipt(
  receipt: CommandReceipt,
): boolean {
  return (
    isPermissionInputTimeout(receipt) &&
    (receipt.body as { details?: { reason?: string } }).details?.reason ===
      "session_checkpointed"
  );
}

export function isRejectedPermissionInputReceipt(
  receipt: CommandReceipt,
): boolean {
  return (
    isPermissionInputTimeout(receipt) &&
    !isCheckpointedPermissionInputReceipt(receipt)
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

/** Which witness proved the ordering. A test that cannot tell the two apart
 * cannot tell a working extension from a coincidence, so the resolved order
 * carries it (ADR-180 D5). The two are NOT collapsed behind one "find any
 * checkpoint" helper: they are different witnesses with different trust.
 */
export type CheckpointBoundary = "command" | "terminal";

export type PermissionCheckpointOrder =
  | Readonly<{
      order: "before_checkpoint" | "after_checkpoint";
      boundary: CheckpointBoundary;
    }>
  | "unproven";

type BoundaryEvent = {
  eventStreamId: string | null;
  hostSequence: string | number | bigint | null;
};

function hostIdentity(command: ExecutionCommand) {
  return and(
    eq(executionEvents.source, "host"),
    eq(executionEvents.runId, command.runId),
    eq(executionEvents.executionHostId, command.executionHostId),
    eq(executionEvents.executionAssignmentId, command.executionAssignmentId),
    eq(executionEvents.assignmentEpoch, command.assignmentEpoch),
    eq(executionEvents.hostSessionId, command.targetSessionId as string),
    eq(executionEvents.ingestDisposition, "accepted"),
  );
}

function usable(witness: BoundaryEvent, terminal: BoundaryEvent): boolean {
  return (
    witness.eventStreamId !== null &&
    witness.eventStreamId === terminal.eventStreamId &&
    witness.hostSequence !== null
  );
}

/** The checkpoint COMMAND's own admission event — preferred when it exists. */
async function commandWitness(
  db: Db,
  command: ExecutionCommand,
  checkpoint: ExecutionCommand,
): Promise<BoundaryEvent | null> {
  const rows = await db
    .select()
    .from(executionEvents)
    .where(
      and(
        hostIdentity(command),
        eq(executionEvents.eventType, "session.command"),
        sql`${executionEvents.payload}->>'commandId' = ${checkpoint.id}`,
        sql`${executionEvents.payload}->>'kind' = 'session.checkpoint'`,
        sql`${executionEvents.payload}->>'phase' = 'accepted'`,
      ),
    )
    .limit(2);

  return rows.length === 1 ? rows[0] : null;
}

/** The SESSION's own terminal, for a checkpoint the manager did not command.
 *
 * A host-initiated checkpoint mints no command at all, and a sweeper checkpoint
 * arriving after the registry's 30 s terminal grace produces a command row with
 * no admission event — `persistReceipt` is gated on a live entry and the sweep
 * tick is 60 s. So the command witness is normally ABSENT on this path, not
 * occasionally.
 */
async function terminalWitness(
  db: Db,
  command: ExecutionCommand,
): Promise<BoundaryEvent | null> {
  const rows = await db
    .select()
    .from(executionEvents)
    .where(
      and(
        hostIdentity(command),
        eq(executionEvents.eventType, "session.exited"),
        sql`${executionEvents.payload}->>'reason' = 'checkpoint'`,
      ),
    )
    .limit(2);

  return rows.length === 1 ? rows[0] : null;
}

/** Teardown can itself cause a protocol failure. Compare durable host positions
 * to distinguish that interruption from an earlier failure. A complete response
 * or explicit adapter error retains its result even during checkpoint teardown.
 *
 * `checkpoint` is nullable: a host-initiated park has no command to pass. The
 * ABSENCE of both witnesses is never read as proof of anything — it returns
 * `"unproven"` and every caller keeps its conservative arm.
 */
export async function permissionCheckpointOrder(
  db: Db,
  command: ExecutionCommand,
  checkpoint: ExecutionCommand | null,
): Promise<PermissionCheckpointOrder> {
  if (!command.terminalEventId || !command.targetSessionId) return "unproven";
  const [terminal] = await db
    .select()
    .from(executionEvents)
    .where(
      and(
        hostIdentity(command),
        eq(executionEvents.eventType, "session.command"),
        eq(executionEvents.id, command.terminalEventId),
      ),
    );

  if (
    !(
      terminal &&
      terminal.payload?.commandId === command.id &&
      terminal.payload.kind === "session.prompt" &&
      terminal.payload.phase ===
        (command.state === "succeeded" ? "completed" : "rejected") &&
      terminal.eventStreamId !== null &&
      terminal.hostSequence !== null
    )
  )
    return "unproven";

  const commanded = checkpoint
    ? await commandWitness(db, command, checkpoint)
    : null;
  const boundary: CheckpointBoundary = commanded ? "command" : "terminal";
  const witness = commanded ?? (await terminalWitness(db, command));

  if (!witness || !usable(witness, terminal)) return "unproven";

  return {
    order:
      BigInt(terminal.hostSequence!) < BigInt(witness.hostSequence!)
        ? "before_checkpoint"
        : "after_checkpoint",
    boundary,
  };
}

/** Narrow a resolved order without repeating the `"unproven"` arm at every
 * call site. It deliberately does NOT hide WHICH witness proved it — callers
 * that need the discriminator read `resolved.boundary`.
 */
export function isAfterCheckpoint(
  resolved: PermissionCheckpointOrder,
): boolean {
  return resolved !== "unproven" && resolved.order === "after_checkpoint";
}

export async function isPermissionResultHandoff(
  db: Db,
  command: ExecutionCommand,
  checkpoint: ExecutionCommand | null,
): Promise<boolean> {
  const resolved = await permissionCheckpointOrder(db, command, checkpoint);

  if (resolved === "unproven") return false;

  return (
    isPermissionResultCommand(command) &&
    (resolved.order === "before_checkpoint" ||
      (resolved.order === "after_checkpoint" &&
        !isPermissionCheckpointInterruption(command)))
  );
}
