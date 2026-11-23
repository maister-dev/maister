import "server-only";

import type {
  WorkspaceAssignmentOwner,
  WorkspaceMaterializeRequest,
  WorkspacePrepareRequest,
} from "../../../runtime/workspace-prepare";
import type {
  ExecutionAssignment,
  ExecutionCommand,
  ExecutionHost,
} from "@/lib/db/schema";
import type { Db } from "./db";
import type { ExecutionHostTransport } from "./contracts";

import { getAssignmentById } from "./assignments";
import { casTransition, claimDelivering, markAccepted } from "./commands";
import { hostForAssignment } from "./resolver";
import { assertWorkspaceRunAuthority } from "./workspace-input-authority";
import { usesHostWorkspacePreparation } from "./workspace-preparation";
import {
  WorkspaceMaterializationPayloadSchema,
  WorkspacePreparePayloadSchema,
} from "./workspace-prepare-schema";

import { MaisterError } from "@/lib/errors";

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
): Promise<{ host: ExecutionHost; assignment: ExecutionAssignment }> {
  const assignment = await getAssignmentById(db, command.executionAssignmentId);
  if (
    assignment?.state !== "active" ||
    assignment.runId !== command.runId ||
    assignment.epoch !== command.assignmentEpoch ||
    assignment.executionHostId !== command.executionHostId
  )
    throw new MaisterError(
      "CONFLICT",
      "Workspace preparation assignment changed",
      {
        details: { reason: "assignment_fenced", commandId: command.id },
      },
    );
  const host = await hostForAssignment(db, assignment, { transport });
  if (!usesHostWorkspacePreparation(host))
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "Assigned host cannot prepare workspaces",
      {
        details: { reason: "workspace_protocol_unsupported", hostId: host.id },
      },
    );

  return { host, assignment };
}

/** The existing recovery sweep can retry the original command after an
 * unknown post-commit outcome. Terminal application belongs to its outbox event. */
export async function recoverWorkspacePreparation(
  db: Db,
  command: ExecutionCommand,
  transport: ExecutionHostTransport,
  at: Date,
): Promise<boolean> {
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
  const { host, assignment } = await resolveWorkspacePreparationPeer(
    db,
    command,
    transport,
  );
  const deliver =
    command.kind === "workspace.materialize"
      ? () => {
          if (
            !command.targetSessionId ||
            !transport.sendWorkspaceMaterialization ||
            command.targetSessionId !== assignment.executionWorkspaceId
          )
            throw new MaisterError(
              "EXECUTOR_UNAVAILABLE",
              "Workspace materialization no longer has its prepared target",
            );
          return transport.sendWorkspaceMaterialization(
            command.targetSessionId,
            retainedWorkspaceMaterializeRequest(command, host.hostKey),
          );
        }
      : () =>
          transport.sendWorkspacePreparation!(
            retainedWorkspacePrepareRequest(command, host.hostKey),
          );
  if (command.state !== "queued") {
    const receipt = await transport.getWorkspaceCommandReceipt(command.id);
    if (receipt && receipt.phase !== "accepted") return false;
  }
  if (command.kind === "workspace.materialize")
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
