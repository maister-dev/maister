import "server-only";

import type { WorkspaceInputObject, WorkspaceWorkloadKind } from "../../../runtime/workspace-prepare";
import type { Db } from "./db";
import type { ExecutionCommand } from "@/lib/db/schema";

import { and, eq, isNull } from "drizzle-orm";

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

function workloadConflict(message: string): MaisterError {
  return new MaisterError("CONFLICT", message, {
    details: { reason: "workspace_preparation_changed" },
  });
}

/** Retain one workload per caller-owned operation within the current assignment. */
export async function reserveWorkspaceWorkload(
  db: Db,
  input: Readonly<{
    runId: string;
    assignmentId: string;
    operationKey: string;
    declarationId: string;
    workload: WorkspaceWorkloadKind;
    templateContext?: WorkspaceInputObject;
    assertDriver?: (tx: Db) => Promise<void>;
  }>,
): Promise<ExecutionCommand> {
  return db.transaction(async (tx) => {
    await input.assertDriver?.(tx);
    const [run] = await tx
      .select({ assignmentId: runs.executionAssignmentId, status: runs.status })
      .from(runs)
      .where(eq(runs.id, input.runId))
      .for("update");
    const [assignment] = await tx
      .select()
      .from(executionAssignments)
      .where(eq(executionAssignments.id, input.assignmentId))
      .for("update");
    const permittedStatus =
      run?.status === "Running" ||
      (input.workload === "requirementProbe" && run?.status === "Pending");
    if (
      !permittedStatus ||
      run?.assignmentId !== input.assignmentId ||
      assignment?.state !== "active" ||
      !assignment.executionWorkspaceId ||
      assignment.runId !== input.runId
    )
      throw workloadConflict(
        "Workload requires its current active assignment and Run",
      );
    await assertWorkspaceRunAuthority(tx, input.runId);
    const [owned] = await tx
      .select({
        generation: workspaces.workspaceGeneration,
        inputGeneration: workspaces.workspaceMaterializationGeneration,
      })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.runId, input.runId),
          eq(workspaces.ownershipKind, "host_owned"),
          eq(workspaces.preparationAssignmentId, assignment.id),
          eq(workspaces.executionHostId, assignment.executionHostId),
          isNull(workspaces.removedAt),
        ),
      )
      .for("share");
    const [materialization] = await tx
      .select({ result: executionCommands.result })
      .from(executionCommands)
      .where(
        and(
          eq(executionCommands.executionAssignmentId, assignment.id),
          eq(executionCommands.kind, "workspace.materialize"),
          eq(executionCommands.state, "succeeded"),
        ),
      );
    const inputDigest = materialization?.result?.manifestDigest;
    if (
      !owned?.generation ||
      !owned.inputGeneration ||
      typeof inputDigest !== "string"
    )
      throw workloadConflict(
        "Workload inputs have no applied materialization receipt",
      );
    const [host] = await tx
      .select()
      .from(executionHosts)
      .where(
        and(
          eq(executionHosts.id, assignment.executionHostId),
          isNull(executionHosts.retiredAt),
        ),
      );
    if (!host) throw workloadConflict("Workload host retired before admission");

    const payload = {
      declarationId: input.declarationId,
      workload: input.workload,
      generation: owned.generation,
      inputGeneration: owned.inputGeneration,
      inputDigest,
      ...(input.templateContext ? { templateContext: input.templateContext } : {}),
    };
    const commandId = workspaceWorkloadCommandId(input);
    const [existing] = await tx
      .select()
      .from(executionCommands)
      .where(eq(executionCommands.id, commandId));
    if (existing) {
      if (
        existing.kind !== "workspace.run" ||
        existing.executionAssignmentId !== assignment.id ||
        existing.targetSessionId !== assignment.executionWorkspaceId ||
        workspaceEvidenceDigest(existing.payload) !==
          workspaceEvidenceDigest(payload)
      )
        throw workloadConflict(
          "Workload operation was already reserved with different inputs",
        );

      return existing;
    }
    const { row } = await issueCommand(tx, {
      id: commandId,
      assignment,
      host,
      kind: "workspace.run",
      payload,
      targetSessionId: assignment.executionWorkspaceId,
      maxAttempts: COMMAND_POLICY["workspace.run"].maxAttempts,
    });

    return row;
  });
}

export function workspaceWorkloadCommandId(input: Readonly<{
  runId: string;
  assignmentId: string;
  operationKey: string;
}>): string {
  return deterministicRuntimeObjectId({
    runId: input.runId,
    sourceKey: `workspace-workload:${input.assignmentId}:${input.operationKey}`,
    sha256: workspaceEvidenceDigest("workspace-workload-v1"),
  });
}
