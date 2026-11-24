import "server-only";

import type { Db } from "../db";
import type { ExecutionCommand, ExecutionEvent } from "@/lib/db/schema";

import { and, eq, isNull, lte, or } from "drizzle-orm";

import {
  isWorkspaceTerminalPayload,
  WORKSPACE_TERMINAL_EVENT,
  workspaceEvidenceDigest,
  workspaceCommandRequestDigest,
  workspacePrepareRequestDigest,
  workspaceTerminalOutcome,
  type WorkspaceCommandBinding,
  type WorkspacePublishBinding,
  type WorkspacePublishReceipt,
} from "../../../../runtime/workspace-prepare";

import {
  releaseAssignmentForRun,
  setAssignmentWorkspace,
} from "../assignments";
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
  retainedWorkspaceMaterializeRequest,
  retainedWorkspaceWorkloadRequest,
  retainedWorkspaceCancellation,
  retainedWorkspaceGitRequest,
  retainedWorkspacePublishRequest,
} from "../workspace-prepare-delivery";
import { WorkspaceCommandReceiptSchema } from "../workspace-prepare-schema";

import { ExecutionEventProjectionError } from "./projector";

import {
  emitDomainEvent,
  runDomainEventScope,
} from "@/lib/domain-events/outbox";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";

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

const matchingCommandKind = {
  stageCPrepare: "workspace.prepare",
  stageCMaterialize: "workspace.materialize",
  stageCRunWorkload: "workspace.run",
  stageCCancelWorkload: "workspace.cancel",
  stageCCheckpoint: "workspace.checkpoint",
  stageCRestore: "workspace.restore",
  stageCPublish: "workspace.publish",
} as const satisfies Record<(WorkspaceCommandBinding | WorkspacePublishBinding)["operationId"], string>;

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
    command.kind !== matchingCommandKind[payload.operationId] ||
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
  let expectedDigest: string;
  if (payload.operationId === "stageCPrepare") {
    expectedDigest = workspacePrepareRequestDigest(
      retainedWorkspacePrepareRequest(command, host.hostKey),
    );
  } else if (payload.operationId === "stageCPublish") {
    const request = retainedWorkspacePublishRequest(command, host.hostKey);
    expectedDigest = workspaceCommandRequestDigest(request, {
      operationId: "stageCPublish",
      target: { kind: "workspace", handle: request.owner.workspaceHandle, generation: request.owner.workspaceGeneration },
    });
    if (workspaceEvidenceDigest(request.owner) !== workspaceEvidenceDigest(payload.owner)) throw inconsistent();
  } else {
    if (!command.targetSessionId) throw inconsistent();
    if (payload.operationId === "stageCCancelWorkload") {
      const { request, targetCommandId } = retainedWorkspaceCancellation(
        command,
        host.hostKey,
      );
      expectedDigest = workspaceCommandRequestDigest(request, {
        operationId: payload.operationId,
        target: {
          kind: "cancelWorkload",
          handle: command.targetSessionId,
          generation: request.payload.generation,
          commandId: targetCommandId,
        },
      });
    } else {
      const request =
        payload.operationId === "stageCMaterialize"
          ? retainedWorkspaceMaterializeRequest(command, host.hostKey)
          : payload.operationId === "stageCRunWorkload"
            ? retainedWorkspaceWorkloadRequest(command, host.hostKey)
            : retainedWorkspaceGitRequest(command, host.hostKey);
      expectedDigest = workspaceCommandRequestDigest(request, {
        operationId: payload.operationId,
        target: {
          kind: "workspace",
          handle: command.targetSessionId,
          generation: request.payload.generation,
        },
      });
    }
  }
  signal.throwIfAborted();
  const receipt = await transport.getWorkspaceCommandReceipt?.(command.id);
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
    receipt.operationId !== payload.operationId ||
    workspaceEvidenceDigest(receipt.target) !==
      workspaceEvidenceDigest(payload.target) ||
    receipt.requestSha256 !== payload.requestSha256 ||
    receipt.requestSha256 !== expectedDigest ||
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

async function applyPublicationReceipt(
  tx: Db,
  event: ExecutionEvent,
  command: ExecutionCommand,
  receipt: Exclude<WorkspacePublishReceipt, { phase: "accepted" }>,
): Promise<void> {
  const { owner, target } = receipt;
  const request = retainedWorkspacePublishRequest(command, owner.hostKey);
  const [workspace] = await tx.select({ id: workspaces.id }).from(workspaces).where(and(
    eq(workspaces.runId, event.runId), eq(workspaces.ownershipKind, "host_owned"),
    eq(workspaces.executionHostId, command.executionHostId), eq(workspaces.executionWorkspaceId, target.handle),
    eq(workspaces.workspaceGeneration, target.generation), isNull(workspaces.removedAt),
    or(
      and(eq(workspaces.promotionState, "claiming"), eq(workspaces.promotionAttemptId, owner.claimId)),
      and(eq(workspaces.lifecycleOperationState, "claiming"), eq(workspaces.lifecycleOperationAttemptId, owner.claimId)),
    ),
  ));
  if (!workspace || command.executionHostId !== event.executionHostId ||
    workspaceEvidenceDigest(request.owner) !== workspaceEvidenceDigest(owner))
    throw inconsistent();

  if (receipt.phase === "rejected") {
    await markFailed(tx, command.id, null, { ...receipt.refusal, eventId: event.id });

    return;
  }
  if (receipt.phase === "indeterminate") {
    await casTransition(tx, command.id, [command.state], command.attempts, {
      transportState: "reconciliation_required",
      lastError: { reason: receipt.condition, eventId: event.id },
    });

    return;
  }
  const { expected, publication } = request.payload;
  const { result } = receipt;
  if (result.publication !== publication || result.git.generation !== target.generation ||
    result.git.head !== expected.head || result.git.priorTarget !== expected.priorTarget || result.git.observedTarget !== expected.head)
    throw inconsistent();
  const transition = await markSucceeded(tx, command.id, null, {
    ...result, eventId: event.id, outcomeSha256: receipt.outcomeSha256,
  });
  if (!transition.changed) throw inconsistent();
}

export async function applyWorkspaceEvidence(
  tx: Db,
  event: ExecutionEvent,
): Promise<void> {
  if (!matchesWorkspaceEvent(event)) return;
  const parsed = WorkspaceCommandReceiptSchema.safeParse(
    event.payload?.workspaceReceipt,
  );
  if (!parsed.success || parsed.data.phase === "accepted") throw inconsistent();
  const receipt = parsed.data;
  const isPreparation =
    receipt.operationId === "stageCPrepare" ||
    receipt.operationId === "stageCMaterialize";
  const [run] = await tx
    .select()
    .from(runs)
    .where(eq(runs.id, event.runId))
    .for("update");
  if (
    !run ||
    (isPreparation && run.status !== "Pending") ||
    (receipt.operationId !== "stageCPublish" && run.executionAssignmentId !== receipt.owner.assignmentId)
  )
    return;
  const [command] = await tx
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.id, receipt.commandId))
    .for("update");
  if (
    !command ||
    command.kind !== matchingCommandKind[receipt.operationId] ||
    !command.targetSessionId
  )
    throw inconsistent();
  if (command.state === "succeeded" || command.state === "failed") return;
  if (receipt.operationId === "stageCPublish") {
    await applyPublicationReceipt(tx, event, command, receipt);

    return;
  }
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

  if (receipt.operationId === "stageCCheckpoint" || receipt.operationId === "stageCRestore") {
    const { target, result } = receipt;
    const [workspace] = await tx.select({ id: workspaces.id }).from(workspaces).where(and(
      eq(workspaces.runId, run.id), eq(workspaces.ownershipKind, "host_owned"),
      eq(workspaces.executionHostId, assignment.executionHostId),
      eq(workspaces.executionWorkspaceId, target.handle),
      eq(workspaces.workspaceGeneration, target.generation),
      isNull(workspaces.removedAt),
    ));
    if (!workspace || target.handle !== assignment.executionWorkspaceId || result.generation !== target.generation ||
        result.checkpointId !== (receipt.operationId === "stageCCheckpoint" ? command.id : command.payload.checkpointId))
      throw inconsistent();
    if (receipt.operationId === "stageCRestore") {
      const [original] = await tx.select({ result: executionCommands.result }).from(executionCommands)
        .where(and(eq(executionCommands.id, result.checkpointId), eq(executionCommands.kind, "workspace.checkpoint"),
          eq(executionCommands.runId, run.id), eq(executionCommands.executionHostId, assignment.executionHostId),
          lte(executionCommands.assignmentEpoch, assignment.epoch),
          eq(executionCommands.targetSessionId, target.handle), eq(executionCommands.state, "succeeded")));
      if (original?.result?.tree !== result.tree || original.result.generation !== target.generation) throw inconsistent();
    }
    const transition = await markSucceeded(tx, command.id, null, { ...result, eventId: event.id, outcomeSha256: receipt.outcomeSha256 });
    if (!transition.changed) throw inconsistent();

    return;
  }

  if (
    receipt.operationId === "stageCRunWorkload" ||
    receipt.operationId === "stageCCancelWorkload"
  ) {
    if (
      receipt.target.handle !== assignment.executionWorkspaceId ||
      (receipt.operationId === "stageCRunWorkload"
        ? receipt.result.generation !== receipt.target.generation
        : receipt.result.targetCommandId !== receipt.target.commandId)
    )
      throw inconsistent();
    if (receipt.result.quiescence !== "proved") {
      await casTransition(tx, command.id, [command.state], command.attempts, {
        transportState: "reconciliation_required",
        lastError: { reason: "quiescence_unconfirmed", eventId: event.id },
      });

      return;
    }
    const transition = await markSucceeded(tx, command.id, null, {
      ...receipt.result,
      eventId: event.id,
      outcomeSha256: receipt.outcomeSha256,
    });
    if (!transition.changed) throw inconsistent();
    if (
      receipt.operationId === "stageCRunWorkload" &&
      command.payload.workload === "requirementProbe" &&
      run.status === "Pending" &&
      (receipt.result.processOutcome !== "exited" ||
        receipt.result.exitCode !== 0)
    ) {
      if (!run.projectId) throw inconsistent();
      await tx
        .update(runs)
        .set({ status: "Failed", endedAt: new Date(event.occurredAt) })
        .where(eq(runs.id, run.id));
      await releaseAssignmentForRun(tx, run.id, "workspace_requirement_failed");
      await emitWebhookEvent({
        db: tx,
        type: "run.failed",
        projectId: run.projectId,
        runId: run.id,
        data: { errorCode: "PRECONDITION" },
      });
      await emitDomainEvent({
        db: tx,
        kind: "run.failed",
        ...runDomainEventScope(run),
        runId: run.id,
        taskId: run.taskId,
        actor: { type: "system", id: null },
        parentRunId: run.parentRunId,
        cause: {
          code: "PRECONDITION",
          reason: "workspace_requirement_failed",
          source: "reconcile",
        },
        payload: {
          runId: run.id,
          taskId: run.taskId,
          flowId: run.flowId,
          runKind: run.runKind,
          reason: "PRECONDITION",
        },
      });
    }

    return;
  }

  if (receipt.operationId === "stageCMaterialize") {
    const request = retainedWorkspaceMaterializeRequest(
      command,
      receipt.owner.hostKey,
    );
    const result = receipt.result;
    if (
      receipt.target.handle !== assignment.executionWorkspaceId ||
      result.generation !== request.payload.generation ||
      result.manifestDigest !== request.payload.manifestDigest
    )
      throw inconsistent();
    const [applied] = await tx
      .update(workspaces)
      .set({ workspaceMaterializationGeneration: result.inputGeneration })
      .where(
        and(
          eq(workspaces.runId, run.id),
          eq(workspaces.ownershipKind, "host_owned"),
          eq(workspaces.executionHostId, assignment.executionHostId),
          eq(workspaces.preparationAssignmentId, assignment.id),
          eq(workspaces.workspaceGeneration, result.generation),
          isNull(workspaces.workspaceMaterializationGeneration),
          isNull(workspaces.removedAt),
        ),
      )
      .returning({ id: workspaces.id });
    if (!applied) throw inconsistent();
    const transition = await markSucceeded(tx, command.id, null, {
      ...result,
      eventId: event.id,
      outcomeSha256: receipt.outcomeSha256,
    });
    if (!transition.changed) throw inconsistent();
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
