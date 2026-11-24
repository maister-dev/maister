import "server-only";

import type { Db } from "./db";
import type { ExecutionCommand } from "@/lib/db/schema";

import { and, eq, isNull, lte } from "drizzle-orm";

import { workspaceEvidenceDigest } from "../../../runtime/workspace-prepare";

import { COMMAND_POLICY } from "./deliverer";
import { issueCommand } from "./ledger";
import { deterministicRuntimeObjectId } from "./runtime-objects";
import { assertWorkspaceRunAuthority } from "./workspace-input-authority";

import {
  executionAssignments,
  executionCommands,
  executionHosts,
  runs,
  workspaces,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

export type AddressedGitOperation = Readonly<
  {
    runId: string;
    assignmentId: string;
    operationKey: string;
    assertDriver?: (tx: Db) => Promise<void>;
  } & (
    | { kind: "workspace.checkpoint" }
    | {
        kind: "workspace.restore";
        checkpointId: string;
        policy?: "fresh-attempt";
      }
  )
>;

function staleCheckpoint(): MaisterError {
  return new MaisterError(
    "CHECKPOINT",
    "Git operation requires the current owned workspace and checkpoint",
    {
      details: { reason: "workspace_checkpoint_unknown" },
    },
  );
}

/** Journal the exact checkpoint or restore before sending it to the execution host. */
export async function reserveWorkspaceGitOperation(
  db: Db,
  input: AddressedGitOperation,
): Promise<ExecutionCommand> {
  return db.transaction(async (tx) => {
    await input.assertDriver?.(tx);
    const [run] = await tx
      .select({ status: runs.status, assignmentId: runs.executionAssignmentId })
      .from(runs)
      .where(eq(runs.id, input.runId))
      .for("no key update");
    const [assignment] = await tx
      .select()
      .from(executionAssignments)
      .where(
        and(
          eq(executionAssignments.id, input.assignmentId),
          eq(executionAssignments.runId, input.runId),
        ),
      )
      .for("no key update");
    if (
      !run ||
      run.assignmentId !== input.assignmentId ||
      (run.status !== "Running" && run.status !== "NeedsInput") ||
      assignment?.state !== "active" ||
      assignment.addressedStopRequestedAt ||
      !assignment.executionWorkspaceId
    )
      throw staleCheckpoint();
    await assertWorkspaceRunAuthority(tx, input.runId);
    const [workspace] = await tx
      .select({ generation: workspaces.workspaceGeneration })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.runId, input.runId),
          eq(workspaces.ownershipKind, "host_owned"),
          eq(workspaces.executionHostId, assignment.executionHostId),
          eq(workspaces.executionWorkspaceId, assignment.executionWorkspaceId),
          isNull(workspaces.removedAt),
        ),
      )
      .for("share");
    if (!workspace?.generation) throw staleCheckpoint();
    const generation = workspace.generation;
    const payload =
      input.kind === "workspace.restore"
        ? {
            generation,
            checkpointId: input.checkpointId,
            ...(input.policy ? { policy: input.policy } : {}),
          }
        : { generation };
    if (input.kind === "workspace.restore") {
      const [checkpoint] = await tx
        .select({ result: executionCommands.result })
        .from(executionCommands)
        .where(
          and(
            eq(executionCommands.id, input.checkpointId),
            eq(executionCommands.kind, "workspace.checkpoint"),
            eq(executionCommands.runId, input.runId),
            eq(executionCommands.executionHostId, assignment.executionHostId),
            lte(executionCommands.assignmentEpoch, assignment.epoch),
            eq(
              executionCommands.targetSessionId,
              assignment.executionWorkspaceId,
            ),
            eq(executionCommands.state, "succeeded"),
          ),
        );
      if (
        checkpoint?.result?.generation !== generation ||
        typeof checkpoint.result.tree !== "string"
      )
        throw staleCheckpoint();
    }
    const id = deterministicRuntimeObjectId({
      runId: input.runId,
      sourceKey: `workspace-git:${assignment.id}:${input.operationKey}`,
      sha256: workspaceEvidenceDigest("workspace-git-v1"),
    });
    const [existing] = await tx
      .select()
      .from(executionCommands)
      .where(eq(executionCommands.id, id));
    if (existing) {
      if (
        existing.kind !== input.kind ||
        existing.executionAssignmentId !== assignment.id ||
        existing.targetSessionId !== assignment.executionWorkspaceId ||
        workspaceEvidenceDigest(existing.payload) !==
          workspaceEvidenceDigest(payload)
      )
        throw staleCheckpoint();

      return existing;
    }
    const [host] = await tx
      .select()
      .from(executionHosts)
      .where(
        and(
          eq(executionHosts.id, assignment.executionHostId),
          isNull(executionHosts.retiredAt),
        ),
      );
    if (!host) throw staleCheckpoint();
    const { row } = await issueCommand(tx, {
      id,
      host,
      assignment,
      kind: input.kind,
      payload,
      targetSessionId: assignment.executionWorkspaceId,
      maxAttempts: COMMAND_POLICY[input.kind].maxAttempts,
    });

    return row;
  });
}
