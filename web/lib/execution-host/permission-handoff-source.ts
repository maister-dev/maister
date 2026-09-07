import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type {
  ExecutionAssignment,
  ExecutionCommand,
  NodeAttempt,
  GateResult,
} from "@/lib/db/schema";
import type {
  FlowPermissionResultResume,
  FlowPermissionContinueResume,
} from "@/lib/flows/graph/action-resume";
import type { FlowActionCompletion } from "@/lib/flows/graph/action-completion";

import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";

import { canonicalCommandJson } from "../../../runtime/command-json";

import {
  isPermissionResultCommand,
  permissionResultPrecedesCheckpoint,
  permissionCheckpointOrder,
} from "./permission-handoff-evidence";

import { flowPermissionSourceSchema } from "@/lib/execution-host/flow-permission-source";
import {
  executionAssignments,
  executionCommands,
  hitlRequests,
  runSessionIncarnations,
  nodeAttempts,
} from "@/lib/db/schema";
import { PromptOwnerInvariantError } from "@/lib/execution-host/prompt-owners";

/** Validate the historical evidence admitted by an explicit permission-result
 * handoff. The receiving assignment may later park; this proof never grants
 * the original command permission to apply to a successor assignment.
 */
export async function assertPermissionHandoffSource(
  db: Db,
  input: Readonly<{
    command: ExecutionCommand;
    resume: FlowPermissionResultResume | FlowPermissionContinueResume;
    assignment: ExecutionAssignment;
  }>,
): Promise<void> {
  const { command, resume, assignment } = input;
  const ref = command.ownerRef;

  if (
    command.ownerKind !== "flow_node_attempt" ||
    (ref?.variant !== "node" &&
      ref?.variant !== "permission_resume" &&
      ref?.variant !== "gate_ai" &&
      ref?.variant !== "gate_skill")
  )
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
  const source = flowPermissionSourceSchema.safeParse(
    (hitl?.schema as { flowPrompt?: unknown } | null)?.flowPrompt,
  );

  const receipt = inputCommand?.receiptEvidence;
  const response = hitl?.response as Readonly<{
    optionId?: string;
    _audit?: Readonly<{
      resultHandoffAssignmentId?: string;
      continuationAssignmentId?: string;
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
    !isPermissionResultCommand(command) ||
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
    resume.promptOrdinal !==
      ref.promptOrdinal + (resume.kind === "permission_continue" ? 1 : 0) ||
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
    !source.success ||
    source.data.commandId !== command.id ||
    source.data.nodeAttemptId !== ref.nodeAttemptId ||
    source.data.promptOrdinal !== ref.promptOrdinal ||
    source.data.assignmentId !== prior.id ||
    source.data.incarnationId !== incarnation.id ||
    ("variant" in source.data
      ? source.data.variant === "permission_resume"
        ? ref.variant !== "permission_resume" ||
          ref.hitlRequestId !== source.data.hitlRequestId
        : (ref.variant !== "gate_ai" && ref.variant !== "gate_skill") ||
          ref.variant !== source.data.variant ||
          ref.gateId !== source.data.gateId ||
          ref.evaluationId !== source.data.evaluationId
      : ref.variant !== "node") ||
    !hitl?.respondedAt ||
    hitl.runId !== assignment.runId ||
    response?.optionId !== resume.optionId ||
    (resume.kind === "permission_result"
      ? response._audit?.resultHandoffAssignmentId !== assignment.id
      : response._audit?.continuationAssignmentId !== assignment.id) ||
    response._audit?.deliveryCommandId !== resume.inputCommandId ||
    response._audit?.sourceCommandId !== command.id ||
    response._audit?.assignmentId !== prior.id ||
    response._audit?.incarnationId !== incarnation.id ||
    response._audit?.requestId !== resume.sourceRequestId ||
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
  if (
    resume.kind === "permission_continue"
      ? command.state !== "failed" ||
        (await permissionCheckpointOrder(db, command, checkpoint)) !==
          "interrupted"
      : !(await permissionResultPrecedesCheckpoint(db, command, checkpoint))
  )
    throw new PromptOwnerInvariantError("permission_result_checkpoint_order");
}

/** A persisted continuation is checked again before creation/admission and
 * application. Restart consumes the same grant; it cannot mint another turn.
 */
export async function assertNodePermissionContinuation(
  db: Db,
  attempt: NodeAttempt,
  assignment: ExecutionAssignment,
): Promise<void> {
  const resume = attempt.actionResume;

  if (resume?.kind !== "permission_continue") return;
  const [command] = await db
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.id, resume.sourceCommandId));
  const ref = command?.ownerRef;

  if (
    !command ||
    (ref?.variant !== "node" && ref?.variant !== "permission_resume") ||
    ref.nodeAttemptId !== attempt.id ||
    attempt.runId !== assignment.runId ||
    attempt.executionAssignmentId !== assignment.id ||
    resume.promptOrdinal !== attempt.actionPromptOrdinal
  )
    throw new PromptOwnerInvariantError("permission_continue_generation");
  await assertPermissionHandoffSource(db, { command, resume, assignment });
}

export function gateParentActionDigest(
  completion: FlowActionCompletion | null,
): string {
  return createHash("sha256")
    .update(canonicalCommandJson(completion))
    .digest("hex");
}

export async function assertGatePermissionContinuation(
  db: Db,
  evaluation: GateResult,
  assignmentId: string,
): Promise<void> {
  const resume = evaluation.permissionResume;

  if (resume?.kind !== "permission_continue") return;
  const [command] = await db
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.id, resume.sourceCommandId));
  const [assignment] = await db
    .select()
    .from(executionAssignments)
    .where(eq(executionAssignments.id, assignmentId));
  const [parent] = evaluation.nodeAttemptId
    ? await db
        .select()
        .from(nodeAttempts)
        .where(eq(nodeAttempts.id, evaluation.nodeAttemptId))
    : [];
  const ref = command?.ownerRef;

  if (
    !command ||
    !assignment ||
    !parent ||
    parent.executionAssignmentId !== assignment.id ||
    evaluation.runId !== assignment.runId ||
    parent.runId !== assignment.runId ||
    resume.assignmentId !== assignment.id ||
    resume.promptOrdinal !== evaluation.promptOrdinal ||
    resume.parentActionSha256 !==
      gateParentActionDigest(parent.actionCompletion) ||
    (ref?.variant !== "gate_ai" && ref?.variant !== "gate_skill") ||
    ref.nodeAttemptId !== parent.id ||
    ref.evaluationId !== evaluation.id ||
    ref.gateId !== evaluation.gateId ||
    evaluation.kind !==
      (ref.variant === "gate_ai" ? "ai_judgment" : "skill_check")
  )
    throw new PromptOwnerInvariantError("gate_permission_continue_generation");
  await assertPermissionHandoffSource(db, { command, resume, assignment });
}
