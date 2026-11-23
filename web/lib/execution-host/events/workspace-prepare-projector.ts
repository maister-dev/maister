import "server-only";

import type { Db } from "../db";
import type { ExecutionEvent } from "@/lib/db/schema";

import { and, eq, isNull } from "drizzle-orm";

import {
  isWorkspaceTerminalPayload,
  WORKSPACE_TERMINAL_EVENT,
  workspaceEvidenceDigest,
  workspacePrepareRequestDigest,
  workspaceTerminalOutcome,
} from "../../../../runtime/workspace-prepare";

import { setAssignmentWorkspace } from "../assignments";
import {
  casTransition,
  getCommand,
  markFailed,
  markSucceeded,
} from "../commands";
import { defaultTransport } from "../default-transport";
import {
  resolveWorkspacePreparationPeer,
  retainedWorkspacePrepareRequest,
} from "../workspace-prepare-delivery";
import { WorkspacePrepareReceiptSchema } from "../workspace-prepare-schema";

import { ExecutionEventProjectionError } from "./projector";

import {
  executionAssignments,
  executionCommands,
  executionEventStreams,
  runs,
  workspaces,
} from "@/lib/db/schema";

function inconsistent(): ExecutionEventProjectionError {
  return new ExecutionEventProjectionError(
    "Workspace event and retained receipt evidence disagree",
    true,
  );
}

function matchesWorkspaceEvent(event: ExecutionEvent): boolean {
  return (
    event.eventType === WORKSPACE_TERMINAL_EVENT &&
    event.source === "host" &&
    event.ingestDisposition === "accepted"
  );
}

/** Read the receipt outside the projection transaction. Event commit and ACK
 * can finish while the supervisor is unavailable or this application retries. */
export async function prepareWorkspaceEvidence(
  db: Db,
  event: ExecutionEvent,
  signal: AbortSignal,
): Promise<ExecutionEvent> {
  if (!matchesWorkspaceEvent(event)) return event;
  const payload = event.payload;
  if (!isWorkspaceTerminalPayload(payload)) throw inconsistent();
  const command = await getCommand(db, payload.commandId);
  if (
    !command ||
    command.kind !== "workspace.prepare" ||
    command.executionHostId !== event.executionHostId ||
    command.executionAssignmentId !== event.executionAssignmentId ||
    command.assignmentEpoch !== event.assignmentEpoch
  )
    throw inconsistent();
  const transport = defaultTransport();
  const { host } = await resolveWorkspacePreparationPeer(
    db,
    command,
    transport,
  );
  const request = retainedWorkspacePrepareRequest(command, host.hostKey);
  signal.throwIfAborted();
  const receipt = await transport.getWorkspacePreparationReceipt?.(command.id);
  if (!receipt || receipt.phase === "accepted")
    throw new ExecutionEventProjectionError(
      "Workspace terminal receipt is temporarily unavailable",
      false,
    );
  const [stream] =
    event.eventStreamId === null
      ? []
      : await db
          .select({ streamId: executionEventStreams.streamId })
          .from(executionEventStreams)
          .where(eq(executionEventStreams.id, event.eventStreamId));
  if (
    receipt.eventId !== event.id ||
    receipt.streamId !== stream?.streamId ||
    receipt.phase !== payload.phase ||
    receipt.requestSha256 !== payload.requestSha256 ||
    receipt.requestSha256 !== workspacePrepareRequestDigest(request) ||
    receipt.outcomeSha256 !== payload.outcomeSha256 ||
    receipt.outcomeSha256 !==
      workspaceEvidenceDigest(workspaceTerminalOutcome(receipt)) ||
    workspaceEvidenceDigest(receipt.owner) !==
      workspaceEvidenceDigest(payload.owner)
  )
    throw inconsistent();
  signal.throwIfAborted();

  return {
    ...event,
    payload: { ...payload, workspaceReceipt: receipt },
    payloadBytes: Buffer.byteLength(
      JSON.stringify({ ...payload, workspaceReceipt: receipt }),
    ),
  };
}

export async function applyWorkspaceEvidence(
  tx: Db,
  event: ExecutionEvent,
): Promise<void> {
  if (!matchesWorkspaceEvent(event)) return;
  const parsed = WorkspacePrepareReceiptSchema.safeParse(
    event.payload?.workspaceReceipt,
  );
  if (!parsed.success || parsed.data.phase === "accepted") throw inconsistent();
  const receipt = parsed.data;
  const [run] = await tx
    .select()
    .from(runs)
    .where(eq(runs.id, event.runId))
    .for("update");
  if (
    run?.status !== "Pending" ||
    run.executionAssignmentId !== receipt.owner.assignmentId
  )
    return;
  const [command] = await tx
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.id, receipt.commandId))
    .for("update");
  if (
    !command ||
    command.kind !== "workspace.prepare" ||
    !command.targetSessionId
  )
    throw inconsistent();
  if (command.state === "succeeded" || command.state === "failed") return;
  const [assignment] = await tx
    .select()
    .from(executionAssignments)
    .where(eq(executionAssignments.id, receipt.owner.assignmentId))
    .for("update");
  if (
    assignment?.state !== "active" ||
    assignment.epoch !== receipt.owner.assignmentEpoch ||
    assignment.executionHostId !== event.executionHostId
  )
    return;

  if (receipt.phase === "rejected") {
    await markFailed(tx, command.id, null, {
      ...receipt.refusal,
      eventId: event.id,
    });
    return;
  }
  if (receipt.phase === "indeterminate") {
    await casTransition(tx, command.id, [command.state], command.attempts, {
      transportState: "reconciliation_required",
      lastError: { reason: receipt.condition, eventId: event.id },
    });
    return;
  }

  const request = retainedWorkspacePrepareRequest(
    command,
    receipt.owner.hostKey,
  );
  const { result } = receipt;
  const payload = request.payload;
  if (
    result.inputDigest !== payload.inputDigest ||
    result.workspace.mode !== payload.mode ||
    ("commit" in payload && result.workspace.observedCommit !== payload.commit)
  )
    throw inconsistent();
  const workspaceOwner = and(
    eq(workspaces.id, command.targetSessionId),
    eq(workspaces.runId, run.id),
    eq(workspaces.ownershipKind, "host_owned"),
    eq(workspaces.executionHostId, assignment.executionHostId),
    eq(workspaces.preparationAssignmentId, assignment.id),
    eq(workspaces.workspaceGeneration, result.workspace.generation),
    eq(workspaces.workspaceInputDigest, result.inputDigest),
    isNull(workspaces.executionWorkspaceId),
    isNull(workspaces.removedAt),
  );
  const [candidate] = await tx
    .select()
    .from(workspaces)
    .where(workspaceOwner)
    .for("update");
  if (
    !candidate ||
    (candidate.rootWorkspaceId !== null) !== (payload.mode === "sharedWorktree")
  )
    throw inconsistent();
  if (candidate.rootWorkspaceId === null)
    await tx
      .update(workspaces)
      .set({ executionWorkspaceId: result.workspace.handle })
      .where(eq(workspaces.id, candidate.id));
  await setAssignmentWorkspace(tx, assignment.id, result.workspace.handle);
  const transition = await markSucceeded(tx, command.id, null, {
    ...result,
    eventId: event.id,
    outcomeSha256: receipt.outcomeSha256,
  });
  if (!transition.changed) throw inconsistent();
}
