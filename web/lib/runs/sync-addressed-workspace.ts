import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { SyncRunInput, SyncRunOutcome, SyncStrategy } from "./sync-target";
import type { SyncRef } from "./sync-ref";

import { randomUUID } from "node:crypto";

import { and, eq, max, sql } from "drizzle-orm";
import { z } from "zod";

import { GIT_OBJECT_ID } from "../../../runtime/wait-head";
import { isWorkspaceSourceRef } from "../../../runtime/workspace-prepare";
import {
  executionCommands,
  runSyncAttempts,
  runs,
  workspaces,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { promotionClaimTimeoutSeconds } from "@/lib/instance-config";
import { getAssignmentById } from "@/lib/execution-host/assignments";
import { insertCommand } from "@/lib/execution-host/commands";
import { requireReworkClaimOwner } from "@/lib/runs/rework-claim";
import {
  readAddressedWorkspacePublicationTarget,
  readAddressedWorkspaceStatus,
} from "@/lib/execution-host/workspace-preparation";
import {
  nextRetainedWorkspaceFence,
  settleRetainedWorkspaceCommand,
} from "@/lib/execution-host/workspace-retained-operation";

const syncReceipt = z.object({
  head: z.string().regex(GIT_OBJECT_ID),
  behind: z.int().nonnegative(),
});

/** Sync a parked owned checkout through its durable manager claim and original supervisor. */
export async function syncAddressedWorkspace(input: {
  db: Db;
  operation: SyncRunInput;
  expectedStatus: string;
  strategy: SyncStrategy;
  target: SyncRef;
}): Promise<SyncRunOutcome> {
  const { db, operation, expectedStatus, strategy, target } = input;
  const { runId, actor } = operation;
  if (
    actor.type !== "user" ||
    !actor.id ||
    operation.agent === true ||
    operation.push === true ||
    operation.autoFinalize ||
    (target.kind === "published" && target.remote !== "origin")
  )
    throw new MaisterError(
      "PRECONDITION",
      "Selected supervisor sync requires a human mechanical checkout update on the approved source",
      {
        details: { reason: "workspace_protocol_unsupported" },
      },
    );
  const targetRef = `refs/heads/${target.branch}`;
  if (!isWorkspaceSourceRef(targetRef))
    throw new MaisterError(
      "PRECONDITION",
      "The selected sync target is not an approved branch",
    );

  const command = await db.transaction(async (tx) => {
    const [run] = await tx
      .select()
      .from(runs)
      .where(eq(runs.id, runId))
      .for("update");
    const [workspace] = await tx
      .select()
      .from(workspaces)
      .where(eq(workspaces.runId, runId))
      .for("update");
    if (
      !run?.projectId ||
      !run.executionAssignmentId ||
      run.status !== expectedStatus ||
      workspace?.ownershipKind !== "host_owned" ||
      workspace.removedAt ||
      !workspace.executionHostId ||
      !workspace.executionWorkspaceId ||
      !workspace.workspaceGeneration ||
      workspace.promotionState === "claiming" ||
      workspace.promotionState === "done"
    )
      throw new MaisterError(
        "CONFLICT",
        "The retained workspace changed before sync",
      );
    if (run.status === "HumanWorking")
      await requireReworkClaimOwner(runId, actor.id, tx);
    const hostId = workspace.executionHostId;
    const handle = workspace.executionWorkspaceId;
    const generation = workspace.workspaceGeneration;
    const assignment = await getAssignmentById(tx, run.executionAssignmentId);
    if (
      assignment?.state !== "released" ||
      assignment.executionHostId !== hostId ||
      assignment.executionWorkspaceId !== handle ||
      assignment.runId !== runId
    )
      throw new MaisterError(
        "CONFLICT",
        "Sync requires the original workspace owner to have stopped",
      );

    if (workspace.lifecycleOperationState === "claiming") {
      const [pending] =
        workspace.lifecycleOperationName === "sync"
          ? await tx
              .select({
                command: executionCommands,
                actorId: runSyncAttempts.actorId,
              })
              .from(executionCommands)
              .innerJoin(
                runSyncAttempts,
                eq(
                  runSyncAttempts.id,
                  sql`${executionCommands.payload}->>'claimId'`,
                ),
              )
              .where(
                and(
                  eq(executionCommands.kind, "workspace.sync"),
                  eq(executionCommands.executionHostId, hostId),
                  eq(executionCommands.targetSessionId, handle),
                  eq(
                    runSyncAttempts.id,
                    workspace.lifecycleOperationAttemptId ?? "",
                  ),
                  eq(runSyncAttempts.strategy, strategy),
                  eq(runSyncAttempts.targetRef, target.label),
                ),
              )
          : [];
      if (pending && pending.actorId === actor.id) return pending.command;
      throw new MaisterError(
        "CONFLICT",
        "Another operation owns the retained workspace",
      );
    }

    const status = await readAddressedWorkspaceStatus(tx, workspace);
    const head = status.workspace.observedCommit;
    if (
      !head ||
      status.workspace.mode !== "ownWorktree" ||
      status.workingTree !== "clean"
    )
      throw new MaisterError(
        "PRECONDITION",
        "Sync requires a clean owned workspace",
        { details: { reason: "dirty_worktree" } },
      );
    const { priorTarget } = await readAddressedWorkspacePublicationTarget(
      tx,
      workspace,
      {
        remoteId: run.projectId,
        targetRef,
      },
    );
    if (!priorTarget)
      throw new MaisterError(
        "PRECONDITION",
        "The approved sync target does not exist",
        { details: { reason: "source_ref_unapproved" } },
      );
    const [latest] = await tx
      .select({ attempt: max(runSyncAttempts.attempt) })
      .from(runSyncAttempts)
      .where(eq(runSyncAttempts.runId, runId));
    const claimId = randomUUID();
    const now = operation.now?.() ?? new Date();
    await tx.insert(runSyncAttempts).values({
      id: claimId,
      runId,
      workspaceId: workspace.id,
      attempt: (latest?.attempt ?? 0) + 1,
      strategy,
      mode: "mechanical",
      actorType: "user",
      actorId: actor.id,
      targetRef: target.label,
      targetSha: priorTarget,
      headShaBefore: head,
      createdAt: now,
      updatedAt: now,
    });
    await tx
      .update(workspaces)
      .set({
        lifecycleOperationState: "claiming",
        lifecycleOperationName: "sync",
        lifecycleOperationAttemptId: claimId,
        lifecycleOperationExpectedRunStatus: run.status,
        lifecycleOperationClaimedAt: now,
        lifecycleOperationLeaseExpiresAt: new Date(
          now.getTime() + promotionClaimTimeoutSeconds() * 1_000,
        ),
      })
      .where(eq(workspaces.id, workspace.id));
    return insertCommand(tx, {
      runId,
      hostId,
      targetSessionId: handle,
      assignmentId: assignment.id,
      assignmentEpoch: assignment.epoch,
      kind: "workspace.sync",
      driverless: true,
      maxAttempts: 3,
      payload: {
        claimId,
        generation,
        fence: await nextRetainedWorkspaceFence(tx, hostId, handle),
        strategy,
        expected: { head, remoteId: run.projectId, targetRef, priorTarget },
      },
    });
  });
  const settled = await settleRetainedWorkspaceCommand(db, command);
  if (settled.state === "failed") {
    const refusal = settled.lastError as {
      code?: string;
      details?: { reason?: string };
    } | null;
    throw new MaisterError(
      refusal?.code === "CONFLICT" ? "CONFLICT" : "PRECONDITION",
      "The original supervisor refused the checkout update",
      { details: refusal?.details },
    );
  }
  const result = syncReceipt.safeParse(settled.result);
  if (!result.success || typeof command.payload.claimId !== "string")
    throw new MaisterError(
      "ACP_PROTOCOL",
      "The retained sync receipt is incomplete",
    );

  return {
    attemptId: command.payload.claimId,
    outcome: result.data.behind ? "synced" : "noop",
    behind: result.data.behind,
    pushed: false,
    conflictedFiles: [],
  };
}
