import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type {
  ExecutionAssignment,
  ExecutionCommand,
  HitlRequest,
  Run,
  RunSessionIncarnation,
} from "@/lib/db/schema";
import type { CommandReceipt } from "@/lib/execution-host/contracts";

import { eq } from "drizzle-orm";
import pino from "pino";

import { canonicalCommandJson } from "../../../../runtime/command-json";

import { executionCommands, hitlRequests, runs } from "@/lib/db/schema";
import { PromptOwnerInvariantError } from "@/lib/execution-host/prompt-owners";
import { markSucceeded } from "@/lib/execution-host/commands";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";
import { completeHitlAssignmentFromCurrentActor } from "@/lib/assignments/service";

const log = pino({
  name: "flow-permission-result-evidence",
  level: process.env.LOG_LEVEL ?? "info",
});

export type PreparedPermissionEvidence = Readonly<{
  hitlRequestId: string;
  sourceJson: string;
  responseJson: string;
  flowRevisionId: string | null;
  requestSha256: string | null;
  terminalEvidenceSha256: string | null;
  sourceState: "succeeded" | "failed";
  inputCommandId: string;
  checkpointCommandId: string;
  inputReceipt: CommandReceipt;
}>;

type PermissionResultCommand = ExecutionCommand &
  (
    | Readonly<{ state: "succeeded" }>
    | Readonly<{
        state: "failed";
        lastError: NonNullable<ExecutionCommand["lastError"]>;
      }>
  );

/** Only agreed terminal evidence can cross a released assignment. Protocol
 * failure is an ordinary failed action/verdict; other failure semantics need
 * their own disposition and must not become a replacement turn here.
 */
export function isPermissionResultCommand(
  command: ExecutionCommand,
): command is PermissionResultCommand {
  return (
    command.requestSha256 !== null &&
    command.terminalEvidenceSha256 !== null &&
    command.applicationError?.reason !== "prompt_terminal_conflict" &&
    (command.state === "succeeded" ||
      (command.state === "failed" &&
        command.lastError?.code === "ACP_PROTOCOL"))
  );
}

export type LockedPermissionResultContext = Readonly<{
  run: Run & { projectId: string };
  hitl: HitlRequest;
  response: Record<string, unknown> & { optionId: string };
  source: Readonly<{ requestId: string; supervisorSessionId: string }>;
  command: ExecutionCommand;
  prior: ExecutionAssignment;
  incarnation: RunSessionIncarnation;
}>;

/** Recheck remote evidence under the receiving capacity claim, after the
 * domain has locked its exact source generation. No stale preflight can apply.
 */
export async function lockPermissionResultEvidence(
  tx: Db,
  context: LockedPermissionResultContext,
  prepared: PreparedPermissionEvidence,
): Promise<
  Readonly<{ input: ExecutionCommand; checkpoint: ExecutionCommand }>
> {
  const { run, hitl, response, source, command, prior } = context;
  const [input] = await tx
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.id, prepared.inputCommandId))
    .for("update");
  const [checkpoint] = await tx
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.id, prepared.checkpointCommandId))
    .for("update");
  const receipt = prepared.inputReceipt;

  if (
    prepared.hitlRequestId !== hitl.id ||
    prepared.sourceJson !== canonicalCommandJson(hitl.schema) ||
    prepared.responseJson !== canonicalCommandJson(response) ||
    prepared.flowRevisionId !== run.flowRevisionId ||
    prepared.requestSha256 !== command.requestSha256 ||
    prepared.terminalEvidenceSha256 !== command.terminalEvidenceSha256 ||
    command.state !== prepared.sourceState ||
    !isPermissionResultCommand(command) ||
    !checkpoint ||
    checkpoint.kind !== "session.checkpoint" ||
    checkpoint.runId !== run.id ||
    checkpoint.executionAssignmentId !== prior.id ||
    checkpoint.executionHostId !== prior.executionHostId ||
    checkpoint.assignmentEpoch !== prior.epoch ||
    checkpoint.targetSessionId !== source.supervisorSessionId ||
    checkpoint.state !== "succeeded" ||
    checkpoint.result?.sessionId !== source.supervisorSessionId ||
    !input ||
    input.kind !== "session.input" ||
    input.runId !== run.id ||
    input.executionAssignmentId !== prior.id ||
    input.executionHostId !== prior.executionHostId ||
    input.assignmentEpoch !== prior.epoch ||
    input.targetSessionId !== source.supervisorSessionId ||
    canonicalCommandJson(input.payload) !==
      canonicalCommandJson({
        kind: "permission",
        action: "select",
        requestId: source.requestId,
        optionId: response.optionId,
      }) ||
    !["delivering", "accepted", "succeeded"].includes(input.state) ||
    receipt.commandId !== input.id ||
    receipt.runId !== run.id ||
    receipt.kind !== input.kind ||
    receipt.assignmentEpoch !== prior.epoch ||
    receipt.phase !== "completed" ||
    receipt.httpStatus !== 200 ||
    receipt.body?.ok !== true ||
    (input.receiptEvidence !== null &&
      canonicalCommandJson(input.receiptEvidence) !==
        canonicalCommandJson(receipt))
  ) {
    log.error(
      {
        runId: run.id,
        sourceCommandId: command.id,
        inputCommandId: prepared.inputCommandId,
        sourceAssignmentId: prior.id,
        inputState: input?.state,
        sourceUnchanged:
          prepared.sourceJson === canonicalCommandJson(hitl.schema),
        responseUnchanged:
          prepared.responseJson === canonicalCommandJson(response),
        revisionUnchanged: prepared.flowRevisionId === run.flowRevisionId,
        requestUnchanged: prepared.requestSha256 === command.requestSha256,
        terminalUnchanged:
          prepared.terminalEvidenceSha256 === command.terminalEvidenceSha256,
      },
      "permission-result-handoff-rejected",
    );
    throw new PromptOwnerInvariantError("permission_result_generation");
  }

  return { input, checkpoint };
}

/** The receiving claim commits the original input, HITL and run state with
 * the domain result. The source assignment receives no new write authority.
 */
export async function completePermissionResultHandoff(
  tx: Db,
  context: LockedPermissionResultContext,
  prepared: PreparedPermissionEvidence,
  assignment: ExecutionAssignment,
): Promise<void> {
  const { run, hitl, response, source, command, prior, incarnation } = context;
  const receipt = prepared.inputReceipt;
  const settled = await markSucceeded(
    tx,
    prepared.inputCommandId,
    null,
    receipt.body,
  );

  if (!settled.changed && settled.row?.state !== "succeeded")
    throw new PromptOwnerInvariantError("permission_result_input_settlement");
  await tx
    .update(executionCommands)
    .set({ receiptEvidence: receipt })
    .where(eq(executionCommands.id, prepared.inputCommandId));
  await tx
    .update(hitlRequests)
    .set({
      respondedAt: new Date(),
      response: {
        ...response,
        _audit: {
          ...(typeof response._audit === "object" && response._audit !== null
            ? response._audit
            : {}),
          deliveryCommandId: prepared.inputCommandId,
          sourceCommandId: command.id,
          assignmentId: prior.id,
          incarnationId: incarnation.id,
          requestId: source.requestId,
          resultHandoffAssignmentId: assignment.id,
        },
      },
    })
    .where(eq(hitlRequests.id, hitl.id));
  await completeHitlAssignmentFromCurrentActor({
    db: tx,
    hitlRequestId: hitl.id,
    eventKind: "responded",
    payload: { optionId: response.optionId },
  });
  await tx
    .update(runs)
    .set({ status: "Running", keepaliveUntil: null, resumeRequestedAt: null })
    .where(eq(runs.id, run.id));
  await emitWebhookEvent({
    db: tx,
    type: "hitl.responded",
    projectId: run.projectId,
    runId: run.id,
    data: { hitlRequestId: hitl.id, kind: "permission", via: "auto" },
  });
}
