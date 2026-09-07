import "server-only";
import type { Db } from "./db";
import type { CommandReceipt } from "./contracts";
import type {
  AgentTurn,
  ExecutionAssignment,
  ExecutionCommand,
  HitlRequest,
  RunSessionIncarnation,
} from "@/lib/db/schema";

import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import { z } from "zod";

import { canonicalCommandJson } from "../../../runtime/command-json";

import { agentPermissionEnvelopeSchema } from "./agent-permission-source";
import {
  isPermissionResultCommand,
  isPermissionCheckpointInterruption,
  permissionCheckpointOrder,
  isRejectedPermissionInputReceipt,
} from "./permission-handoff-evidence";
import { PromptOwnerInvariantError } from "./prompt-owners";

import {
  agentTurns,
  executionAssignments,
  executionCommands,
  hitlRequests,
  runSessionIncarnations,
} from "@/lib/db/schema";

const id = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const agentPermissionResumeSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(["result", "continue"]),
    assignmentId: id,
    turnId: id,
    sourceCommandId: id,
    sourceRequestSha256: digest,
    sourceTerminalEvidenceSha256: digest,
    checkpointCommandId: id,
    inputCommandId: id.nullable(),
    resumeSessionId: id,
    optionId: id,
    reissuedHitlRequestId: id.optional(),
    applied: z.literal(true).optional(),
  })
  .strict();

export type AgentPermissionResume = z.infer<typeof agentPermissionResumeSchema>;
export type Source = Readonly<{
  hitl: HitlRequest;
  response: Record<string, unknown> & { optionId: string };
  command: ExecutionCommand;
  turn: AgentTurn;
  prior: ExecutionAssignment;
  incarnation: RunSessionIncarnation & { acpSessionId: string };
  checkpoint: ExecutionCommand;
  input: ExecutionCommand | null;
  kind: "result" | "continue" | "rejected";
}>;
export type Readiness =
  | Readonly<{ kind: "pending"; reason: string }>
  | Readonly<{ kind: "ready"; source: Source }>
  | null;

export function checkInputReceipt(
  command: ExecutionCommand,
  receipt: CommandReceipt,
): void {
  if (
    receipt.commandId !== command.id ||
    receipt.runId !== command.runId ||
    receipt.kind !== "session.input" ||
    receipt.assignmentEpoch !== command.assignmentEpoch
  )
    throw new PromptOwnerInvariantError("agent_permission_receipt_identity");
}

export function checkInput(
  source: z.infer<typeof agentPermissionEnvelopeSchema>,
  response: Record<string, unknown>,
  command: ExecutionCommand,
  input: ExecutionCommand,
): void {
  const payload = {
    kind: "permission",
    action: "select",
    requestId: source.requestId,
    optionId: response.optionId,
  };

  if (
    input.kind !== "session.input" ||
    input.runId !== command.runId ||
    input.executionAssignmentId !== command.executionAssignmentId ||
    input.assignmentEpoch !== command.assignmentEpoch ||
    input.executionHostId !== command.executionHostId ||
    input.targetSessionId !== command.targetSessionId ||
    canonicalCommandJson(input.payload) !== canonicalCommandJson(payload) ||
    canonicalCommandJson(response._delivery) !==
      canonicalCommandJson({
        commandId: input.id,
        hostSessionId: command.targetSessionId,
        payload,
      })
  )
    throw new PromptOwnerInvariantError(
      "agent_permission_resume_input_identity",
    );
}

export async function readCheckpointSource(
  db: Db,
  hitl: HitlRequest,
): Promise<Exclude<Readiness, null>> {
  const parsed = agentPermissionEnvelopeSchema.safeParse(hitl.schema);
  const response = hitl.response as Record<string, unknown> | null;

  if (!parsed.success)
    throw new PromptOwnerInvariantError("agent_permission_resume_source_shape");
  if (typeof response?.optionId !== "string")
    return { kind: "pending", reason: "choice_missing" };
  const source = parsed.data;

  if (!source.options.some((option) => option.optionId === response.optionId))
    throw new PromptOwnerInvariantError("agent_permission_resume_choice");
  const [command] = await db
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.id, source.agentPrompt.commandId));
  const [turn] = await db
    .select()
    .from(agentTurns)
    .where(eq(agentTurns.id, source.agentPrompt.turnId));
  const [prior] = await db
    .select()
    .from(executionAssignments)
    .where(eq(executionAssignments.id, source.agentPrompt.assignmentId));
  const [incarnation] = await db
    .select()
    .from(runSessionIncarnations)
    .where(eq(runSessionIncarnations.id, source.agentPrompt.incarnationId));
  const ref = command?.ownerRef;

  if (
    !command ||
    command.kind !== "session.prompt" ||
    command.ownerKind !== "agent_turn" ||
    !ref ||
    !("turnId" in ref) ||
    !("promptOrdinal" in ref) ||
    ref.runId !== hitl.runId ||
    ref.turnId !== source.agentPrompt.turnId ||
    ref.promptOrdinal !== source.agentPrompt.promptOrdinal ||
    ref.assignmentId !== prior?.id ||
    ref.incarnationId !== incarnation?.id ||
    command.runId !== hitl.runId ||
    command.executionAssignmentId !== prior?.id ||
    command.targetSessionId !== source.supervisorSessionId ||
    !turn ||
    turn.runId !== hitl.runId ||
    turn.commandId !== command.id ||
    turn.ordinal !== ref.promptOrdinal ||
    turn.variant !== ref.variant ||
    turn.executionAssignmentId !== prior?.id ||
    turn.incarnationId !== incarnation?.id ||
    turn.runSessionId !== ref.runSessionId ||
    !prior ||
    prior.runId !== hitl.runId ||
    prior.epoch !== ref.assignmentEpoch ||
    prior.epoch !== command.assignmentEpoch ||
    prior.epoch !== turn.assignmentEpoch ||
    prior.executionHostId !== command.executionHostId ||
    !incarnation?.acpSessionId ||
    incarnation.executionAssignmentId !== prior.id ||
    incarnation.assignmentEpoch !== prior.epoch ||
    incarnation.executionHostId !== prior.executionHostId ||
    incarnation.hostSessionId !== command.targetSessionId ||
    incarnation.runSessionId !== ref.runSessionId
  )
    throw new PromptOwnerInvariantError("agent_permission_checkpoint_source");
  if (prior.state !== "released" || prior.releasedReason !== "checkpointed")
    return { kind: "pending", reason: "assignment_not_checkpointed" };
  if (!isPermissionResultCommand(command))
    return { kind: "pending", reason: "source_not_settled" };
  const [checkpoint] = await db
    .select()
    .from(executionCommands)
    .where(
      and(
        eq(executionCommands.runId, hitl.runId),
        eq(executionCommands.executionAssignmentId, prior.id),
        eq(executionCommands.targetSessionId, source.supervisorSessionId),
        eq(executionCommands.kind, "session.checkpoint"),
        eq(executionCommands.state, "succeeded"),
      ),
    )
    .orderBy(asc(executionCommands.createdAt), asc(executionCommands.id))
    .limit(1);

  if (
    !checkpoint ||
    checkpoint.result?.sessionId !== source.supervisorSessionId
  )
    return { kind: "pending", reason: "checkpoint_not_confirmed" };
  if (
    checkpoint.executionHostId !== prior.executionHostId ||
    checkpoint.assignmentEpoch !== prior.epoch
  )
    throw new PromptOwnerInvariantError("agent_permission_checkpoint_identity");
  const order = await permissionCheckpointOrder(db, command, checkpoint);

  if (order === "unproven")
    return { kind: "pending", reason: "checkpoint_order_unproven" };
  let input: ExecutionCommand | null = null;

  if (response._delivery !== undefined) {
    const delivery = response._delivery as Record<string, unknown>;

    if (!delivery || typeof delivery.commandId !== "string")
      throw new PromptOwnerInvariantError("agent_permission_delivery_intent");
    const [row] = await db
      .select()
      .from(executionCommands)
      .where(eq(executionCommands.id, delivery.commandId));

    if (!row)
      throw new PromptOwnerInvariantError(
        "agent_permission_resume_input_missing",
      );
    checkInput(source, response, command, row);
    if (!row.receiptEvidence)
      return { kind: "pending", reason: "input_receipt_missing" };
    checkInputReceipt(row, row.receiptEvidence);
    if (
      !isRejectedPermissionInputReceipt(row.receiptEvidence) &&
      (row.state !== "succeeded" ||
        row.receiptEvidence.phase !== "completed" ||
        row.receiptEvidence.httpStatus !== 200 ||
        row.receiptEvidence.body.ok !== true)
    )
      return { kind: "pending", reason: "input_not_confirmed" };
    if (
      isRejectedPermissionInputReceipt(row.receiptEvidence) &&
      row.state !== "failed"
    )
      return { kind: "pending", reason: "input_rejection_unsettled" };
    input = row;
  }

  return {
    kind: "ready",
    source: {
      hitl,
      response: { ...response, optionId: response.optionId },
      command,
      turn,
      prior,
      incarnation: { ...incarnation, acpSessionId: incarnation.acpSessionId },
      checkpoint,
      input,
      kind:
        input?.receiptEvidence &&
        isRejectedPermissionInputReceipt(input.receiptEvidence)
          ? "rejected"
          : order === "after_checkpoint" &&
              isPermissionCheckpointInterruption(command)
            ? "continue"
            : "result",
    },
  };
}

/** Recheck the same immutable evidence at dispatch/application, after the
 * original request has been acknowledged or its successor has started.
 */
export async function assertAgentPermissionResumeSource(
  db: Db,
  hitl: HitlRequest,
  assignment: ExecutionAssignment,
): Promise<Source> {
  const response = hitl.response as Record<string, unknown> | null;
  const parsed = agentPermissionResumeSchema.safeParse(response?._agentResume);

  if (!parsed.success)
    throw new PromptOwnerInvariantError("agent_permission_resume_grant_shape");
  const grant = parsed.data;
  const ready = await readCheckpointSource(db, hitl);

  if (ready.kind !== "ready")
    throw new PromptOwnerInvariantError(
      "agent_permission_resume_evidence_changed",
    );
  const source = ready.source;

  if (
    grant.assignmentId !== assignment.id ||
    assignment.runId !== hitl.runId ||
    assignment.executionHostId !== source.prior.executionHostId ||
    assignment.epoch <= source.prior.epoch ||
    grant.kind !== source.kind ||
    grant.sourceCommandId !== source.command.id ||
    grant.sourceRequestSha256 !== source.command.requestSha256 ||
    grant.sourceTerminalEvidenceSha256 !==
      source.command.terminalEvidenceSha256 ||
    grant.checkpointCommandId !== source.checkpoint.id ||
    grant.inputCommandId !== (source.input?.id ?? null) ||
    grant.resumeSessionId !== source.incarnation.acpSessionId ||
    grant.optionId !== source.response.optionId
  )
    throw new PromptOwnerInvariantError(
      "agent_permission_resume_grant_identity",
    );

  return source;
}

export async function assertAgentResumeTurn(
  db: Db,
  turn: AgentTurn,
  assignment: ExecutionAssignment,
): Promise<void> {
  if (turn.variant !== "resume") return;
  const grants = await db
    .select()
    .from(hitlRequests)
    .where(
      and(
        eq(hitlRequests.runId, turn.runId),
        sql`${hitlRequests.response}->'_agentResume'->>'turnId' = ${turn.id}`,
      ),
    )
    .limit(2);

  if (grants.length === 0) {
    const [previous] = await db
      .select()
      .from(agentTurns)
      .where(
        and(
          eq(agentTurns.runId, turn.runId),
          lt(agentTurns.ordinal, turn.ordinal),
        ),
      )
      .orderBy(desc(agentTurns.ordinal))
      .limit(1);
    const [prior] = previous?.executionAssignmentId
      ? await db
          .select()
          .from(executionAssignments)
          .where(eq(executionAssignments.id, previous.executionAssignmentId))
      : [];

    if (
      !previous ||
      previous.state !== "applied" ||
      previous.prompt !== turn.prompt ||
      !prior ||
      prior.state !== "released" ||
      prior.releasedReason !== "parked" ||
      prior.executionHostId !== assignment.executionHostId ||
      prior.epoch >= assignment.epoch
    )
      throw new PromptOwnerInvariantError(
        "agent_resume_original_source_missing",
      );

    return;
  }
  if (grants.length !== 1)
    throw new PromptOwnerInvariantError("agent_permission_resume_grant_count");
  const hitl = grants[0];
  const source = await assertAgentPermissionResumeSource(db, hitl, assignment);

  if (
    source.kind !== "continue" ||
    source.turn.state !== "superseded" ||
    turn.runId !== assignment.runId ||
    turn.executionAssignmentId !== assignment.id ||
    turn.assignmentEpoch !== assignment.epoch ||
    turn.runSessionId !== source.turn.runSessionId ||
    turn.prompt !== source.turn.prompt
  )
    throw new PromptOwnerInvariantError(
      "agent_permission_resume_turn_identity",
    );
}

/** The frozen create must resume the ACP handle named by the source proof. */
export async function assertAgentResumeCreateRequest(
  db: Db,
  turnId: string,
  payload: Readonly<{ resumeSessionId?: unknown }>,
): Promise<void> {
  const [hitl] = await db
    .select()
    .from(hitlRequests)
    .where(
      sql`${hitlRequests.response}->'_agentResume'->>'turnId' = ${turnId}`,
    );

  if (!hitl) return;
  const grant = agentPermissionResumeSchema.safeParse(
    (hitl.response as Record<string, unknown> | null)?._agentResume,
  );

  if (
    !grant.success ||
    grant.data.kind !== "continue" ||
    payload.resumeSessionId !== grant.data.resumeSessionId
  )
    throw new PromptOwnerInvariantError(
      "agent_permission_create_resume_identity",
    );
}
