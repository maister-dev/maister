import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionAssignment } from "@/lib/db/schema";

import { and, desc, eq } from "drizzle-orm";

import {
  executionAssignments,
  executionCommands,
  nodeAttempts,
  runs,
} from "@/lib/db/schema";
import { PromptOwnerInvariantError } from "@/lib/execution-host/prompt-owners";

export type FlowActionResume = Readonly<{
  version: 1;
  kind: "orchestrator";
  sourceCommandId: string;
  sourceAssignmentId: string;
  assignmentId: string;
  promptOrdinal: number;
  resumeSessionId: string;
}>;

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
        eq(
          executionCommands.logicalOperationKey,
          `flow_node_attempt:node:${attempt.id}:${attempt.actionPromptOrdinal}`,
        ),
      ),
    );
  const pendingResume =
    !attempt.actionCompletion && !currentPrompt ? attempt.actionResume : null;
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

  if (
    run.status !== "Running" ||
    run.executionAssignmentId !== assignment.id ||
    assignment.state !== "active" ||
    assignment.placementReason !== "wait_resume" ||
    attempt.status !== "NeedsInput" ||
    attempt.finishContinuation !== null ||
    !source ||
    source.command.runId !== run.id ||
    source.command.ownerKind !== "flow_node_attempt" ||
    !ref ||
    !("nodeAttemptId" in ref) ||
    ref.variant !== "node" ||
    ref.nodeAttemptId !== attempt.id ||
    source.command.state !== "succeeded" ||
    source.command.applicationState !== "applied" ||
    (attempt.actionCompletion !== null &&
      !attempt.actionCompletion.result.ok) ||
    source.assignment.state !== "released" ||
    source.assignment.releasedReason !== "waiting_on_children" ||
    source.assignment.epoch >= assignment.epoch ||
    (!pendingResume &&
      (ref.promptOrdinal !== attempt.actionPromptOrdinal ||
        source.assignment.id !== attempt.executionAssignmentId)) ||
    (pendingResume &&
      (pendingResume.assignmentId !== attempt.executionAssignmentId ||
        pendingResume.sourceAssignmentId !== source.assignment.id ||
        pendingResume.promptOrdinal !== ref.promptOrdinal + 1 ||
        previousAssignment?.state !== "released" ||
        previousAssignment.releasedReason !== "wait_resume_rollback")) ||
    !resumeSessionId
  )
    throw new PromptOwnerInvariantError("orchestrator_resume_generation");
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
      },
    })
    .where(eq(nodeAttempts.id, attempt.id));
}
