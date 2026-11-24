import "server-only";

import type { Db } from "./db";
import type { ExecutionCommand } from "@/lib/db/schema";

import { and, eq, isNull, notInArray } from "drizzle-orm";
import pino from "pino";

import { workspaceEvidenceDigest } from "../../../runtime/workspace-prepare";

import { markFailed } from "./commands";
import { COMMAND_POLICY } from "./deliverer";
import { issueCommand } from "./ledger";
import { deterministicRuntimeObjectId } from "./runtime-objects";
import { dispatchQueuedWorkspaceCommand } from "./workspace-dispatch";
import { runEventWakeBus } from "./events/run-wake";

import {
  executionAssignments,
  executionCommands,
  executionHosts,
  runs,
  workspaces,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { assertTaskLaunchUserAuthority } from "@/lib/tasks/launch-authority";

const log = pino({
  name: "addressed-workspace-stop",
  level: process.env.LOG_LEVEL ?? "info",
});

export type AddressedStopClaim = Readonly<{
  runId: string;
  projectId: string;
  assignmentId: string;
  commands: readonly string[];
  alreadyStopped: boolean;
}>;

function stopChanged(): MaisterError {
  return new MaisterError(
    "CONFLICT",
    "The addressed Run or its workspace changed before Stop",
    {
      details: { reason: "addressed_stop_owner_changed" },
    },
  );
}

function stopPending(): MaisterError {
  return new MaisterError(
    "EXECUTOR_UNAVAILABLE",
    "Stop is waiting for the selected supervisor to prove process retirement",
    {
      details: { reason: "addressed_stop_pending" },
    },
  );
}

function cancellationProved(command: ExecutionCommand): boolean {
  return (
    command.state === "succeeded" &&
    command.result?.quiescence === "proved" &&
    command.result.targetCommandId === command.payload.targetCommandId
  );
}

/** Claim Stop and queue cancellation before talking to the selected supervisor. */
export async function claimAddressedFlowStop(
  db: Db,
  runId: string,
  userId: string,
): Promise<AddressedStopClaim> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select()
      .from(runs)
      .where(eq(runs.id, runId))
      .for("no key update");
    if (!run?.projectId || run.runKind !== "flow" || !run.executionAssignmentId)
      throw stopChanged();
    const projectId = run.projectId;
    await assertTaskLaunchUserAuthority(tx, projectId, userId, ["recoverRun"]);
    const [assignment] = await tx
      .select()
      .from(executionAssignments)
      .where(
        and(
          eq(executionAssignments.id, run.executionAssignmentId),
          eq(executionAssignments.runId, runId),
        ),
      )
      .for("no key update");
    if (!assignment) throw stopChanged();
    const claim = { runId, projectId, assignmentId: assignment.id };
    if (
      run.status === "Review" &&
      assignment.state === "released" &&
      assignment.releasedReason === "stopped" &&
      assignment.addressedStopRequestedAt
    )
      return { ...claim, commands: [], alreadyStopped: true };
    if (
      assignment.state !== "active" ||
      !assignment.executionWorkspaceId ||
      (run.status !== "Running" && run.status !== "NeedsInput")
    )
      throw stopChanged();
    const [activeChild] = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.parentRunId, runId),
          notInArray(runs.status, ["Done", "Failed", "Crashed", "Abandoned"]),
        ),
      )
      .limit(1);
    if (activeChild)
      throw new MaisterError(
        "CONFLICT",
        "Stop requires retirement of this addressed Run's child first",
        {
          details: { reason: "addressed_stop_child_active" },
        },
      );
    const [workspace] = await tx
      .select({ generation: workspaces.workspaceGeneration })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.runId, runId),
          eq(workspaces.preparationAssignmentId, assignment.id),
          eq(workspaces.executionHostId, assignment.executionHostId),
          eq(workspaces.executionWorkspaceId, assignment.executionWorkspaceId),
          eq(workspaces.ownershipKind, "host_owned"),
          isNull(workspaces.removedAt),
        ),
      )
      .for("share");
    const generation = workspace?.generation;
    if (!generation) throw stopChanged();
    const [host] = await tx
      .select()
      .from(executionHosts)
      .where(eq(executionHosts.id, assignment.executionHostId));
    if (!host || host.retiredAt) throw stopPending();

    if (!assignment.addressedStopRequestedAt) {
      await tx
        .update(executionAssignments)
        .set({
          addressedStopRequestedAt: new Date(),
          addressedStopRequestedBy: userId,
        })
        .where(eq(executionAssignments.id, assignment.id));
      await tx
        .update(runs)
        .set({ flowDriverToken: null, flowDriverLeaseExpiresAt: null })
        .where(eq(runs.id, runId));
      log.info(
        {
          runId,
          assignmentId: assignment.id,
          assignmentEpoch: assignment.epoch,
          userId,
        },
        "addressed-stop-retained",
      );
    }
    const commands = await tx
      .select()
      .from(executionCommands)
      .where(eq(executionCommands.executionAssignmentId, assignment.id))
      .for("no key update");
    const cancellations = new Map(
      commands
        .filter(({ kind }) => kind === "workspace.cancel")
        .map((command) => [command.payload.targetCommandId, command]),
    );
    const pending: string[] = [];
    for (const target of commands) {
      if (
        target.kind === "session.create" &&
        target.state === "queued" &&
        target.attempts === 0
      ) {
        await markFailed(tx, target.id, 0, {
          reason: "addressed_stop_before_session_delivery",
        });
      }
      if (target.kind !== "workspace.run") continue;
      const previous = cancellations.get(target.id);
      if (previous) {
        pending.push(previous.id);
        continue;
      }
      if (
        target.state === "succeeded" &&
        target.result?.quiescence === "proved"
      )
        continue;
      const id = deterministicRuntimeObjectId({
        runId,
        sourceKey: `workspace-stop:${assignment.id}:${target.id}`,
        sha256: workspaceEvidenceDigest("workspace-stop-v1"),
      });
      const { row } = await issueCommand(tx, {
        id,
        kind: "workspace.cancel",
        assignment,
        host,
        payload: { generation, targetCommandId: target.id },
        targetSessionId: assignment.executionWorkspaceId,
        maxAttempts: COMMAND_POLICY["workspace.cancel"].maxAttempts,
      });
      pending.push(row.id);
    }

    return { ...claim, commands: pending, alreadyStopped: false };
  });
}

/** Wait for canonical proof. An unknown or refused effect keeps the assignment pinned. */
export async function settleAddressedWorkloadStops(
  db: Db,
  claim: AddressedStopClaim,
): Promise<void> {
  for (const commandId of claim.commands)
    await dispatchQueuedWorkspaceCommand(db, { runId: claim.runId, commandId });
  const deadline = AbortSignal.timeout(10_000);
  while (!deadline.aborted) {
    const commands = await db
      .select()
      .from(executionCommands)
      .where(eq(executionCommands.executionAssignmentId, claim.assignmentId));
    const pendingCreates = commands.some(
      ({ kind, state }) =>
        kind === "session.create" &&
        (state === "accepted" || state === "delivering" || state === "queued"),
    );
    const cancellations = commands.filter(({ id }) =>
      claim.commands.includes(id),
    );
    if (
      cancellations.some(
        (command) =>
          command.state === "failed" ||
          command.state === "fenced" ||
          command.transportState === "reconciliation_required",
      )
    )
      throw stopPending();
    if (
      !pendingCreates &&
      cancellations.length === claim.commands.length &&
      cancellations.every(cancellationProved)
    )
      return;
    await runEventWakeBus.wait(claim.runId, 500, deadline);
  }
  throw stopPending();
}
