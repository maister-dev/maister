import "server-only";

import type {
  WorkspaceAssignmentOwner,
  WorkspaceMaterializeRequest,
  WorkspacePrepareRequest,
  WorkspaceWorkloadRequest,
  WorkspaceCancelWorkloadRequest,
  WorkspaceCheckpointRequest,
  WorkspaceRestoreRequest,
  WorkspaceRetainedRequest,
} from "../../../runtime/workspace-prepare";
import type {
  ExecutionAssignment,
  ExecutionCommand,
  ExecutionHost,
} from "@/lib/db/schema";
import type { Db } from "./db";
import { transportForExecutionHost } from "./default-transport";
import { reserveRunHostCapacity } from "./host-capacity";
import type { ExecutionHostTransport } from "./contracts";

import { and, eq, isNull, lte, or } from "drizzle-orm";

import { getAssignmentById } from "./assignments";
import { casTransition, claimDelivering, markAccepted } from "./commands";
import { hostForAssignment } from "./resolver";
import { assertWorkspaceRunAuthority } from "./workspace-input-authority";
import { usesHostWorkspacePreparation } from "./workspace-preparation";
import {
  WorkspaceMaterializationPayloadSchema,
  WorkspacePreparePayloadSchema,
  WorkspaceWorkloadPayloadSchema,
  WorkspaceCancelWorkloadPayloadSchema,
  WorkspaceCheckpointPayloadSchema,
  WorkspaceRestorePayloadSchema,
  RetainedWorkspacePublishSchema,
  RetainedWorkspaceSyncSchema,
  RetainedWorkspacePreserveSchema,
  RetainedWorkspaceReleaseSchema,
} from "./workspace-prepare-schema";
import { z } from "zod";

import { executionCommands } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { takeSchedulerLock } from "@/lib/scheduler";

function retainedOwner(
  command: ExecutionCommand,
  hostKey: string,
): WorkspaceAssignmentOwner {
  return {
    kind: "assignment",
    hostKey,
    runId: command.runId,
    assignmentId: command.executionAssignmentId,
    assignmentEpoch: command.assignmentEpoch,
  };
}

export function retainedWorkspaceGitRequest(command: ExecutionCommand, hostKey: string): WorkspaceCheckpointRequest | WorkspaceRestoreRequest {
  const owner = retainedOwner(command, hostKey);
  const issuedAt = command.createdAt.toISOString();
  if (command.kind === "workspace.checkpoint") {
    const payload = WorkspaceCheckpointPayloadSchema.safeParse(command.payload);
    if (payload.success) return { workspaceProtocol: 1, owner, payload: payload.data,
      command: { id: command.id, kind: command.kind, issuedAt } };
  }
  if (command.kind === "workspace.restore") {
    const payload = WorkspaceRestorePayloadSchema.safeParse(command.payload);
    if (payload.success) return { workspaceProtocol: 1, owner, payload: payload.data,
      command: { id: command.id, kind: command.kind, issuedAt } };
  }
  throw new MaisterError("ACP_PROTOCOL", "Stored workspace Git operation is invalid");
}

export function isAddressedRetainedWorkspaceCommand(command: ExecutionCommand): boolean {
  return command.kind === "workspace.publish" || command.kind === "workspace.preserve" || command.kind === "workspace.sync" ||
    (command.kind === "workspace.release" && typeof command.payload.claimId === "string");
}

function retainedWorkspaceEnvelope(
  command: ExecutionCommand,
  hostKey: string,
  identity: { generation: number; claimId: string; fence: number },
) {
  if (!command.targetSessionId)
    throw new MaisterError("ACP_PROTOCOL", "Stored workspace operation lacks a retained handle");
  const { claimId, fence, generation } = identity;

  return {
    workspaceProtocol: 1,
    owner: {
      kind: "workspaceOperation",
      hostKey,
      workspaceHandle: command.targetSessionId,
      workspaceGeneration: generation,
      claimId,
      fence,
    },
  } as const;
}

export function retainedWorkspaceOperationRequest(command: ExecutionCommand, hostKey: string): WorkspaceRetainedRequest {
  const identity = { id: command.id, issuedAt: command.createdAt.toISOString() };
  if (command.kind === "workspace.sync") {
    const { claimId, fence, resolverIntent: _intent, resolverProbeId: _probe, ...payload } = RetainedWorkspaceSyncSchema.parse(command.payload);
    return { ...retainedWorkspaceEnvelope(command, hostKey, { ...payload, claimId, fence }),
      command: { ...identity, kind: command.kind }, payload };
  }
  if (command.kind === "workspace.publish") {
    const { claimId, fence, ...payload } = RetainedWorkspacePublishSchema.parse(command.payload);
    return { ...retainedWorkspaceEnvelope(command, hostKey, { ...payload, claimId, fence }),
      command: { ...identity, kind: command.kind }, payload };
  }
  if (command.kind === "workspace.preserve") {
    const { claimId, fence, ...payload } = RetainedWorkspacePreserveSchema.parse(command.payload);
    return { ...retainedWorkspaceEnvelope(command, hostKey, { ...payload, claimId, fence }),
      command: { ...identity, kind: command.kind }, payload };
  }
  if (command.kind === "workspace.release") {
    const { claimId, fence, ...payload } = RetainedWorkspaceReleaseSchema.parse(command.payload);
    return { ...retainedWorkspaceEnvelope(command, hostKey, { ...payload, claimId, fence }),
      command: { ...identity, kind: command.kind }, payload };
  }
  throw new MaisterError("ACP_PROTOCOL", "Stored retained workspace operation is invalid");
}

export function retainedWorkspacePrepareRequest(
  command: ExecutionCommand,
  hostKey: string,
): WorkspacePrepareRequest {
  const payload = WorkspacePreparePayloadSchema.safeParse(command.payload);
  if (!payload.success || command.kind !== "workspace.prepare")
    throw new MaisterError(
      "ACP_PROTOCOL",
      "Stored workspace preparation request is invalid",
    );

  return {
    workspaceProtocol: 1,
    command: {
      id: command.id,
      kind: command.kind,
      issuedAt: command.createdAt.toISOString(),
    },
    owner: retainedOwner(command, hostKey),
    payload: payload.data,
  };
}

export function retainedWorkspaceMaterializeRequest(
  command: ExecutionCommand,
  hostKey: string,
): WorkspaceMaterializeRequest {
  const payload = WorkspaceMaterializationPayloadSchema.safeParse(
    command.payload,
  );
  if (!payload.success || command.kind !== "workspace.materialize")
    throw new MaisterError(
      "ACP_PROTOCOL",
      "Stored workspace materialization request is invalid",
    );

  return {
    workspaceProtocol: 1,
    command: {
      id: command.id,
      kind: command.kind,
      issuedAt: command.createdAt.toISOString(),
    },
    owner: retainedOwner(command, hostKey),
    payload: payload.data,
  };
}

export async function resolveWorkspacePreparationPeer(
  db: Db,
  command: ExecutionCommand,
  transport: ExecutionHostTransport,
): Promise<{ host: ExecutionHost; assignment: ExecutionAssignment; transport: ExecutionHostTransport }> {
  const peer = await readWorkspaceCommandPeer(db, command, transport);
  if (!isAddressedRetainedWorkspaceCommand(command) && peer.assignment.state !== "active")
    throw workspaceAssignmentFenced(command.id);
  return peer;
}

function workspaceAssignmentFenced(commandId: string): MaisterError {
  return new MaisterError("CONFLICT", "Workspace preparation assignment changed", {
    details: { reason: "assignment_fenced", commandId },
  });
}

/** A released workload can still return its terminal proof to the original owner. */
export async function resolveWorkspaceReceiptPeer(
  db: Db,
  command: ExecutionCommand,
  transport: ExecutionHostTransport,
): Promise<{ host: ExecutionHost; assignment: ExecutionAssignment; transport: ExecutionHostTransport }> {
  const peer = await readWorkspaceCommandPeer(db, command, transport);
  if (peer.assignment.state === "superseded" ||
    (peer.assignment.state === "released" && command.kind !== "workspace.run" &&
      command.kind !== "workspace.cancel" && !isAddressedRetainedWorkspaceCommand(command)))
    throw workspaceAssignmentFenced(command.id);
  return peer;
}

async function readWorkspaceCommandPeer(
  db: Db,
  command: ExecutionCommand,
  transport: ExecutionHostTransport,
): Promise<{ host: ExecutionHost; assignment: ExecutionAssignment; transport: ExecutionHostTransport }> {
  const assignment = await getAssignmentById(db, command.executionAssignmentId);
  if (
    !assignment ||
    assignment.runId !== command.runId ||
    assignment.epoch !== command.assignmentEpoch ||
    assignment.executionHostId !== command.executionHostId
  )
    throw workspaceAssignmentFenced(command.id);
  const host = await hostForAssignment(db, assignment, { transport });
  if (!usesHostWorkspacePreparation(host))
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "Assigned host cannot prepare workspaces",
      {
        details: { reason: "workspace_protocol_unsupported", hostId: host.id },
      },
    );

  return { host, assignment, transport: transportForExecutionHost(host, transport) };
}

export function retainedWorkspaceWorkloadRequest(
  command: ExecutionCommand,
  hostKey: string,
): WorkspaceWorkloadRequest {
  const payload = WorkspaceWorkloadPayloadSchema.safeParse(command.payload);
  if (command.kind !== "workspace.run" || !payload.success)
    throw new MaisterError(
      "ACP_PROTOCOL",
      "Stored workspace workload payload is invalid",
    );

  return {
    workspaceProtocol: 1,
    command: {
      id: command.id,
      kind: command.kind,
      issuedAt: command.createdAt.toISOString(),
    },
    owner: retainedOwner(command, hostKey),
    payload: payload.data,
  };
}

export function retainedWorkspaceCancellation(
  command: ExecutionCommand,
  hostKey: string,
): { request: WorkspaceCancelWorkloadRequest; targetCommandId: string } {
  const parsed = WorkspaceCancelWorkloadPayloadSchema.extend({
    targetCommandId: z.string().uuid(),
  }).safeParse(command.payload);
  if (command.kind !== "workspace.cancel" || !parsed.success)
    throw new MaisterError(
      "ACP_PROTOCOL",
      "Stored workload cancellation payload is invalid",
    );

  return {
    request: {
      workspaceProtocol: 1,
      command: {
        id: command.id,
        kind: command.kind,
        issuedAt: command.createdAt.toISOString(),
      },
      owner: retainedOwner(command, hostKey),
      payload: { generation: parsed.data.generation },
    },
    targetCommandId: parsed.data.targetCommandId,
  };
}

/** The existing recovery sweep can retry the original command after an
 * unknown post-commit outcome. Terminal application belongs to its outbox event. */
export async function recoverWorkspacePreparation(
  db: Db,
  command: ExecutionCommand,
  defaultHostTransport: ExecutionHostTransport,
  at: Date,
): Promise<boolean> {
  const { host, assignment, transport } = await resolveWorkspacePreparationPeer(
    db,
    command,
    defaultHostTransport,
  );
  if (command.kind === "workspace.prepare" && command.state === "queued" && command.attempts === 0) {
    const reason = await db.transaction(async (tx) => {
      await takeSchedulerLock(tx);
      return reserveRunHostCapacity(tx, command.runId);
    });
    if (reason)
      throw new MaisterError("EXECUTOR_UNAVAILABLE", "Workspace preparation awaits its selected host", {
        details: { reason, runId: command.runId, hostId: host.id },
      });
  }
  if (
    !transport.sendWorkspacePreparation ||
    !transport.getWorkspaceCommandReceipt
  )
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "Transport lacks addressed workspace commands",
      {
        details: { reason: "workspace_protocol_unsupported" },
      },
    );
  const deliver = (): Promise<void> => {
    if (command.kind === "workspace.prepare")
      return transport.sendWorkspacePreparation!(
        retainedWorkspacePrepareRequest(command, host.hostKey),
      );
    const handle = command.targetSessionId;
    if (!handle || handle !== assignment.executionWorkspaceId)
      throw new MaisterError(
        "CONFLICT",
        "Workspace command no longer owns its prepared target",
      );
    if (isAddressedRetainedWorkspaceCommand(command) && transport.sendRetainedWorkspaceCommand)
      return transport.sendRetainedWorkspaceCommand(retainedWorkspaceOperationRequest(command, host.hostKey));
    if (
      command.kind === "workspace.materialize" &&
      transport.sendWorkspaceMaterialization
    )
      return transport.sendWorkspaceMaterialization(
        handle,
        retainedWorkspaceMaterializeRequest(command, host.hostKey),
      );
    if (command.kind === "workspace.run" && transport.sendWorkspaceWorkload)
      return transport.sendWorkspaceWorkload(
        handle,
        retainedWorkspaceWorkloadRequest(command, host.hostKey),
      );
    if ((command.kind === "workspace.checkpoint" || command.kind === "workspace.restore") && transport.sendWorkspaceGitCommand)
      return transport.sendWorkspaceGitCommand(handle, retainedWorkspaceGitRequest(command, host.hostKey));
    if (
      command.kind === "workspace.cancel" &&
      transport.cancelWorkspaceWorkload
    ) {
      const { request, targetCommandId } = retainedWorkspaceCancellation(
        command,
        host.hostKey,
      );

      return transport.cancelWorkspaceWorkload(
        handle,
        targetCommandId,
        request,
      );
    }
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "Transport lacks the addressed operation",
      {
        details: { reason: "workspace_protocol_unsupported" },
      },
    );
  };
  const retained =
    command.state === "queued"
      ? null
      : await transport.getWorkspaceCommandReceipt(command.id);
  if (retained && retained.phase !== "accepted") return false;

  if (
    (command.kind === "workspace.run" || command.kind === "workspace.publish" ||
      command.kind === "workspace.restore") &&
    retained?.phase === "accepted"
  ) {
    // Delivery is already witnessed. Reconcile the same receipt at a bounded
    // cadence without charging new admission attempts. The owner observes the
    // original workload group, publication lease, or restore checkpoint.
    const [retry] = await db
      .update(executionCommands)
      .set({ nextAttemptAt: new Date(at.getTime() + 30_000), updatedAt: at })
      .where(
        and(
          eq(executionCommands.id, command.id),
          eq(executionCommands.state, command.state),
          eq(executionCommands.attempts, command.attempts),
          or(
            isNull(executionCommands.nextAttemptAt),
            lte(executionCommands.nextAttemptAt, at),
          ),
        ),
      )
      .returning({ id: executionCommands.id });
    if (!retry) return false;
    await deliver();
    if (command.state === "delivering")
      await markAccepted(db, command.id, command.attempts, { now: at });

    return true;
  }
  if (
    command.kind === "workspace.materialize" ||
    command.kind === "workspace.run" ||
    command.kind === "workspace.checkpoint" ||
    command.kind === "workspace.restore"
  )
    await assertWorkspaceRunAuthority(db, command.runId);
  if (command.attempts >= command.maxAttempts) {
    if (command.transportState !== "reconciliation_required")
      await casTransition(
        db,
        command.id,
        [command.state],
        command.attempts,
        {
          transportState: "reconciliation_required",
          lastError: { reason: "workspace_preparation_delivery_unconfirmed" },
        },
        { now: at },
      );
    return false;
  }
  let delivery = command;
  if (command.state === "queued") {
    const claim = await claimDelivering(db, command.id, command.attempts, {
      now: at,
    });
    if (!claim.changed || !claim.row) return false;
    delivery = claim.row;
  } else {
    const retryAt = new Date(at.getTime() + 30_000);
    const retry = await casTransition(
      db,
      command.id,
      [command.state],
      command.attempts,
      { attempts: command.attempts + 1, nextAttemptAt: retryAt },
      { now: at },
    );
    if (!retry.changed || !retry.row) return false;
    delivery = retry.row;
  }
  await deliver();
  if (delivery.state === "delivering")
    await markAccepted(db, command.id, delivery.attempts, { now: at });

  return true;
}
