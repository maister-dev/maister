import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionAssignment } from "@/lib/db/schema";

import { and, desc, eq, inArray } from "drizzle-orm";

import { assertPermissionHandoffSource } from "@/lib/execution-host/permission-handoff-source";
import {
  executionAssignments,
  executionCommands,
  nodeAttempts,
  runs,
} from "@/lib/db/schema";
import { PromptOwnerInvariantError } from "@/lib/execution-host/prompt-owners";

type ActionResumeIdentity = Readonly<{
  version: 1;
  sourceCommandId: string;
  sourceAssignmentId: string;
  assignmentId: string;
  promptOrdinal: number;
  resumeSessionId: string;
}>;

export type FlowPermissionResultResume = ActionResumeIdentity &
  Readonly<{
    kind: "permission_result";
    hitlRequestId: string;
    sourceRequestId: string;
    optionId: string;
    inputCommandId: string;
    checkpointCommandId: string;
    sourceIncarnationId: string;
  }>;

export type FlowPermissionContinueResume = Omit<
  FlowPermissionResultResume,
  "kind"
> &
  Readonly<{ kind: "permission_continue" }>;

export type FlowActionResume =
  | FlowPermissionResultResume
  | FlowPermissionContinueResume
  | (ActionResumeIdentity &
      (
        | Readonly<{
            kind: "orchestrator";
            permissionResult?: FlowPermissionResultResume;
          }>
        | Readonly<{
            kind: "permission";
            hitlRequestId: string;
            sourceRequestId: string;
            optionId: string;
          }>
      ));

/** Advance only inside the normal, capacity-checked WaitingOnChildren claim.
 * A process restart reads this authorization; it cannot create one. A spawn
 * rollback without a prompt retains the same turn number on its next claim.
 */
export async function authorizeOrchestratorActionResume(
  tx: Db,
  assignment: ExecutionAssignment,
): Promise<void> {
  const [run] = await tx
    .select()
    .from(runs)
    .where(eq(runs.id, assignment.runId));

  if (run?.runKind !== "flow" || !run.currentStepId) return;
  const [attempt] = await tx
    .select()
    .from(nodeAttempts)
    .where(
      and(
        eq(nodeAttempts.runId, run.id),
        eq(nodeAttempts.nodeId, run.currentStepId),
      ),
    )
    .orderBy(desc(nodeAttempts.attempt))
    .limit(1)
    .for("update");

  if (attempt?.nodeType !== "orchestrator") return;
  const [currentPrompt] = await tx
    .select()
    .from(executionCommands)
    .where(
      and(
        eq(executionCommands.runId, run.id),
        inArray(executionCommands.logicalOperationKey, [
          `flow_node_attempt:node:${attempt.id}:${attempt.actionPromptOrdinal}`,
          `flow_node_attempt:permission_resume:${attempt.id}:${attempt.actionPromptOrdinal}`,
        ]),
      ),
    );
  const pendingResume =
    !attempt.actionCompletion &&
    !currentPrompt &&
    attempt.actionResume?.kind === "orchestrator"
      ? attempt.actionResume
      : null;
  const permissionResult =
    attempt.actionResume?.kind === "permission_result"
      ? attempt.actionResume
      : pendingResume?.permissionResult;
  const sourceCommandId =
    attempt.actionCompletion?.commandId ?? pendingResume?.sourceCommandId;

  // Pre-owner rows retain their existing resume path until S2.12 drain.
  if (!sourceCommandId && !currentPrompt && !attempt.actionResume) return;
  if (!sourceCommandId)
    throw new PromptOwnerInvariantError("orchestrator_resume_source_missing");
  const [source] = await tx
    .select({ command: executionCommands, assignment: executionAssignments })
    .from(executionCommands)
    .innerJoin(
      executionAssignments,
      eq(executionAssignments.id, executionCommands.executionAssignmentId),
    )
    .where(eq(executionCommands.id, sourceCommandId));
  const ref = source?.command.ownerRef;
  const resumeSessionId =
    attempt.actionCompletion?.result.acpSessionId ??
    pendingResume?.resumeSessionId;
  const [previousAssignment] = attempt.executionAssignmentId
    ? await tx
        .select()
        .from(executionAssignments)
        .where(eq(executionAssignments.id, attempt.executionAssignmentId))
    : [];

  const parkedAssignmentId =
    permissionResult?.assignmentId ?? source?.assignment.id;
  const [parkedAssignment] = parkedAssignmentId
    ? await tx
        .select()
        .from(executionAssignments)
        .where(eq(executionAssignments.id, parkedAssignmentId))
    : [];

  if (
    run.status !== "Running" ||
    run.executionAssignmentId !== assignment.id ||
    assignment.state !== "active" ||
    assignment.placementReason !== "wait_resume" ||
    attempt.status !== "NeedsInput" ||
    attempt.finishContinuation !== null ||
    !source ||
    source.command.runId !== run.id ||
    source.command.kind !== "session.prompt" ||
    source.command.ownerKind !== "flow_node_attempt" ||
    !ref ||
    !("nodeAttemptId" in ref) ||
    (ref.variant !== "node" && ref.variant !== "permission_resume") ||
    ref.nodeAttemptId !== attempt.id ||
    ref.runId !== run.id ||
    ref.assignmentId !== source.assignment.id ||
    ref.assignmentEpoch !== source.assignment.epoch ||
    source.command.assignmentEpoch !== source.assignment.epoch ||
    source.command.executionHostId !== assignment.executionHostId ||
    source.command.state !== "succeeded" ||
    (!permissionResult && source.command.applicationState !== "applied") ||
    (attempt.actionCompletion !== null &&
      (!attempt.actionCompletion.result.ok ||
        attempt.actionCompletion.promptOrdinal !== ref.promptOrdinal)) ||
    source.assignment.runId !== run.id ||
    source.assignment.state !== "released" ||
    source.assignment.executionHostId !== assignment.executionHostId ||
    source.assignment.epoch >= assignment.epoch ||
    !parkedAssignment ||
    parkedAssignment.runId !== run.id ||
    parkedAssignment.executionHostId !== assignment.executionHostId ||
    parkedAssignment.state !== "released" ||
    parkedAssignment.releasedReason !== "waiting_on_children" ||
    parkedAssignment.epoch >= assignment.epoch ||
    (!pendingResume &&
      (ref.promptOrdinal !== attempt.actionPromptOrdinal ||
        parkedAssignment.id !== attempt.executionAssignmentId)) ||
    (pendingResume &&
      (pendingResume.assignmentId !== attempt.executionAssignmentId ||
        pendingResume.sourceAssignmentId !== source.assignment.id ||
        pendingResume.promptOrdinal !== attempt.actionPromptOrdinal ||
        pendingResume.promptOrdinal !== ref.promptOrdinal + 1 ||
        previousAssignment?.runId !== run.id ||
        previousAssignment.executionHostId !== assignment.executionHostId ||
        previousAssignment.epoch <= parkedAssignment.epoch ||
        previousAssignment.epoch >= assignment.epoch ||
        previousAssignment.state !== "released" ||
        previousAssignment.releasedReason !== "wait_resume_rollback")) ||
    !resumeSessionId
  )
    throw new PromptOwnerInvariantError("orchestrator_resume_generation");
  if (permissionResult) {
    if (
      permissionResult.resumeSessionId !== resumeSessionId ||
      permissionResult.promptOrdinal !== ref.promptOrdinal
    )
      throw new PromptOwnerInvariantError(
        "orchestrator_resume_handoff_generation",
      );
    await assertPermissionHandoffSource(tx, {
      command: source.command,
      resume: permissionResult,
      assignment: parkedAssignment,
    });
  }
  const promptOrdinal =
    pendingResume?.promptOrdinal ?? attempt.actionPromptOrdinal + 1;

  await tx
    .update(nodeAttempts)
    .set({
      executionAssignmentId: assignment.id,
      actionPromptOrdinal: promptOrdinal,
      actionCompletion: null,
      actionResume: {
        version: 1,
        kind: "orchestrator",
        sourceCommandId,
        sourceAssignmentId: source.assignment.id,
        assignmentId: assignment.id,
        promptOrdinal,
        resumeSessionId,
        ...(permissionResult ? { permissionResult } : {}),
      },
    })
    .where(eq(nodeAttempts.id, attempt.id));
}
