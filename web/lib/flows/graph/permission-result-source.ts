import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionAssignment, ExecutionCommand } from "@/lib/db/schema";
import type { FlowPermissionResultResume } from "./action-resume";

import { eq } from "drizzle-orm";

import {
  executionAssignments,
  executionCommands,
  hitlRequests,
  runSessionIncarnations,
} from "@/lib/db/schema";
import { PromptOwnerInvariantError } from "@/lib/execution-host/prompt-owners";

/** Validate the historical evidence admitted by an explicit permission-result
 * handoff. The receiving assignment may later park; this proof never grants
 * the original command permission to apply to a successor assignment.
 */
export async function assertPermissionResultSource(
  db: Db,
  input: Readonly<{
    command: ExecutionCommand;
    resume: FlowPermissionResultResume;
    assignment: ExecutionAssignment;
  }>,
): Promise<void> {
  const { command, resume, assignment } = input;
  const ref = command.ownerRef;

  if (command.ownerKind !== "flow_node_attempt" || ref?.variant !== "node")
    throw new PromptOwnerInvariantError("permission_result_source_owner");
  const [prior] = await db
    .select()
    .from(executionAssignments)
    .where(eq(executionAssignments.id, command.executionAssignmentId));
  const [incarnation] = await db
    .select()
    .from(runSessionIncarnations)
    .where(eq(runSessionIncarnations.id, ref.incarnationId));
  const [hitl] = await db
    .select()
    .from(hitlRequests)
    .where(eq(hitlRequests.id, resume.hitlRequestId));
  const [inputCommand] = await db
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.id, resume.inputCommandId));
  const [checkpoint] = await db
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.id, resume.checkpointCommandId));
  const receipt = inputCommand?.receiptEvidence;
  const response = hitl?.response as Readonly<{
    optionId?: string;
    _audit?: Readonly<{
      resultHandoffAssignmentId?: string;
      deliveryCommandId?: string;
      sourceCommandId?: string;
      assignmentId?: string;
      incarnationId?: string;
      requestId?: string;
    }>;
  }> | null;

  if (
    command.runId !== assignment.runId ||
    command.kind !== "session.prompt" ||
    command.state !== "succeeded" ||
    command.executionHostId !== assignment.executionHostId ||
    !prior ||
    prior.runId !== assignment.runId ||
    prior.state !== "released" ||
    prior.releasedReason !== "checkpointed" ||
    prior.epoch >= assignment.epoch ||
    prior.executionHostId !== assignment.executionHostId ||
    ref.runId !== assignment.runId ||
    ref.assignmentId !== prior.id ||
    ref.assignmentEpoch !== prior.epoch ||
    command.assignmentEpoch !== prior.epoch ||
    resume.assignmentId !== assignment.id ||
    resume.sourceAssignmentId !== prior.id ||
    resume.sourceCommandId !== command.id ||
    resume.promptOrdinal !== ref.promptOrdinal ||
    !incarnation ||
    resume.sourceIncarnationId !== incarnation.id ||
    resume.resumeSessionId !== incarnation.acpSessionId ||
    incarnation.executionAssignmentId !== prior.id ||
    incarnation.executionHostId !== prior.executionHostId ||
    incarnation.assignmentEpoch !== prior.epoch ||
    incarnation.hostSessionId !== command.targetSessionId ||
    !checkpoint ||
    checkpoint.kind !== "session.checkpoint" ||
    checkpoint.state !== "succeeded" ||
    checkpoint.runId !== assignment.runId ||
    checkpoint.executionAssignmentId !== prior.id ||
    checkpoint.executionHostId !== prior.executionHostId ||
    checkpoint.assignmentEpoch !== prior.epoch ||
    checkpoint.targetSessionId !== command.targetSessionId ||
    checkpoint.result?.sessionId !== command.targetSessionId ||
    !hitl?.respondedAt ||
    hitl.runId !== assignment.runId ||
    response?.optionId !== resume.optionId ||
    response._audit?.resultHandoffAssignmentId !== assignment.id ||
    response._audit.deliveryCommandId !== resume.inputCommandId ||
    response._audit.sourceCommandId !== command.id ||
    response._audit.assignmentId !== prior.id ||
    response._audit.incarnationId !== incarnation.id ||
    response._audit.requestId !== resume.sourceRequestId ||
    !inputCommand ||
    inputCommand.kind !== "session.input" ||
    inputCommand.state !== "succeeded" ||
    inputCommand.runId !== assignment.runId ||
    inputCommand.executionAssignmentId !== prior.id ||
    inputCommand.executionHostId !== prior.executionHostId ||
    inputCommand.assignmentEpoch !== prior.epoch ||
    inputCommand.targetSessionId !== command.targetSessionId ||
    inputCommand.payload.requestId !== resume.sourceRequestId ||
    inputCommand.payload.optionId !== resume.optionId ||
    receipt?.commandId !== inputCommand.id ||
    receipt.phase !== "completed" ||
    receipt.kind !== "session.input" ||
    receipt.runId !== assignment.runId ||
    receipt.assignmentEpoch !== prior.epoch ||
    receipt.httpStatus !== 200 ||
    receipt.body?.ok !== true
  )
    throw new PromptOwnerInvariantError("permission_result_source_generation");
}
