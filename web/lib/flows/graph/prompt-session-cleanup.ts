import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { BoundClient } from "@/lib/execution-host/client";
import type { ExecutionCommand } from "@/lib/db/schema";

import { and, eq } from "drizzle-orm";

import {
  executionAssignments,
  executionCommands,
  hitlRequests,
  nodeAttempts,
  runs,
  runSessionIncarnations,
} from "@/lib/db/schema";
import { PromptOwnerInvariantError } from "@/lib/execution-host/prompt-owners";

/** Resume the post-application cleanup lost with a caller's stack. The exact
 * source incarnation is authoritative; never delete today's logical session
 * by looking up only the run/session name after a successor has replaced it.
 */
export async function closeAppliedFlowPromptSession(
  db: Db,
  client: BoundClient,
  commandId: string,
): Promise<void> {
  const [command] = await db
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.id, commandId));

  if (command && command.executionAssignmentId !== client.assignment.id) {
    await assertCheckpointedPermissionResult(db, client, command);

    return;
  }

  if (
    !command ||
    command.runId !== client.assignment.runId ||
    command.executionAssignmentId !== client.assignment.id ||
    command.ownerKind !== "flow_node_attempt" ||
    command.applicationState !== "applied" ||
    !command.completionAppliedAt ||
    !command.targetSessionId ||
    !command.ownerRef
  )
    throw new PromptOwnerInvariantError("flow_prompt_cleanup_generation");
  const [incarnation] = await db
    .select()
    .from(runSessionIncarnations)
    .where(
      and(
        eq(runSessionIncarnations.id, command.ownerRef.incarnationId),
        eq(runSessionIncarnations.hostSessionId, command.targetSessionId),
        eq(runSessionIncarnations.executionAssignmentId, client.assignment.id),
      ),
    );

  if (!incarnation)
    throw new PromptOwnerInvariantError("flow_prompt_cleanup_incarnation");
  if (["exited", "crashed", "lost", "deleted"].includes(incarnation.state))
    return;
  await client.deleteSession(command.targetSessionId);
}

/** A verified result may cross a checkpoint; its old session cannot be
 * addressed by the successor client. Validate durable handoff authority before
 * skipping cleanup, without reviving the historical owner's write authority.
 */
async function assertCheckpointedPermissionResult(
  db: Db,
  client: BoundClient,
  command: ExecutionCommand,
): Promise<void> {
  const ref = command.ownerRef;

  if (command.ownerKind !== "flow_node_attempt" || ref?.variant !== "node")
    throw new PromptOwnerInvariantError("permission_result_cleanup_source");
  const [binding] = await db
    .select({
      attempt: nodeAttempts,
      run: runs,
      prior: executionAssignments,
      incarnation: runSessionIncarnations,
    })
    .from(nodeAttempts)
    .innerJoin(runs, eq(runs.id, nodeAttempts.runId))
    .innerJoin(
      executionAssignments,
      eq(executionAssignments.id, command.executionAssignmentId),
    )
    .innerJoin(
      runSessionIncarnations,
      eq(runSessionIncarnations.id, ref.incarnationId),
    )
    .where(eq(nodeAttempts.id, ref.nodeAttemptId));
  const resume = binding?.attempt.actionResume;

  if (!binding || resume?.kind !== "permission_result")
    throw new PromptOwnerInvariantError("permission_result_cleanup_authority");
  const { run, attempt, prior, incarnation } = binding;
  const [hitl] = await db
    .select()
    .from(hitlRequests)
    .where(eq(hitlRequests.id, resume.hitlRequestId));
  const [input] = await db
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.id, resume.inputCommandId));
  const [checkpoint] = await db
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.id, resume.checkpointCommandId));
  const receipt = input?.receiptEvidence;

  if (
    run.id !== client.assignment.runId ||
    run.executionAssignmentId !== client.assignment.id ||
    command.runId !== run.id ||
    command.state !== "succeeded" ||
    command.executionHostId !== client.assignment.executionHostId ||
    command.executionAssignmentId !== prior.id ||
    prior.state !== "released" ||
    prior.releasedReason !== "checkpointed" ||
    prior.epoch >= client.assignment.epoch ||
    ref.assignmentId !== prior.id ||
    ref.assignmentEpoch !== prior.epoch ||
    attempt.executionAssignmentId !== client.assignment.id ||
    run.currentStepId !== attempt.nodeId ||
    attempt.status !== "Running" ||
    resume.assignmentId !== client.assignment.id ||
    resume.sourceAssignmentId !== prior.id ||
    resume.sourceCommandId !== command.id ||
    resume.sourceIncarnationId !== incarnation.id ||
    resume.promptOrdinal !== ref.promptOrdinal ||
    attempt.actionPromptOrdinal !== ref.promptOrdinal ||
    attempt.actionCompletion?.commandId !== command.id ||
    !attempt.actionCompletion.result.ok ||
    incarnation.executionAssignmentId !== prior.id ||
    incarnation.hostSessionId !== command.targetSessionId ||
    !checkpoint ||
    checkpoint.kind !== "session.checkpoint" ||
    checkpoint.state !== "succeeded" ||
    checkpoint.runId !== run.id ||
    checkpoint.executionAssignmentId !== prior.id ||
    checkpoint.executionHostId !== prior.executionHostId ||
    checkpoint.assignmentEpoch !== prior.epoch ||
    checkpoint.targetSessionId !== command.targetSessionId ||
    checkpoint.result?.sessionId !== command.targetSessionId ||
    !hitl?.respondedAt ||
    hitl.runId !== run.id ||
    !input ||
    input.kind !== "session.input" ||
    input.state !== "succeeded" ||
    input.runId !== run.id ||
    input.executionAssignmentId !== prior.id ||
    input.targetSessionId !== command.targetSessionId ||
    input.payload.requestId !== resume.sourceRequestId ||
    input.payload.optionId !== resume.optionId ||
    receipt?.commandId !== input.id ||
    receipt.phase !== "completed" ||
    receipt.body?.ok !== true
  )
    throw new PromptOwnerInvariantError("permission_result_cleanup_generation");
}
