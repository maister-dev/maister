import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type {
  ExecutionAssignment,
  ExecutionCommand,
  HitlRequest,
  NodeAttempt,
  Run,
  RunSessionIncarnation,
} from "@/lib/db/schema";
import type { ExecutionHostTransport } from "@/lib/execution-host/contracts";
import type { FlowActionCompletion } from "./action-completion";
import type { GatePromptCompletion } from "./gate-prompt-completion";
import type { PreparedPermissionEvidence } from "./permission-result-evidence";
import type { PromptOwnerOutcome } from "@/lib/execution-host/prompt-owners";

import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import pino from "pino";

import { canonicalCommandJson } from "../../../../runtime/command-json";

import {
  pendingGatePermissionResumeExists,
  gateParentActionDigest,
} from "./gate-permission-resume";
import { decodeGatePromptCompletion } from "./gate-prompt-completion";
import {
  lockPermissionResultEvidence,
  completePermissionResultHandoff,
  isPermissionResultCommand,
} from "./permission-result-evidence";
import {
  nodePermissionSourceSchema,
  flowPermissionSourceSchema,
  gatePermissionSourceSchema,
} from "./permission-source";
import { decodeNodePromptCompletion } from "./node-prompt-owner";

import {
  executionAssignments,
  executionCommands,
  hitlRequests,
  nodeAttempts,
  runSessionIncarnations,
  runs,
} from "@/lib/db/schema";
import { PromptOwnerInvariantError } from "@/lib/execution-host/prompt-owners";
import { reconcilePromptCommand } from "@/lib/execution-host/prompt-reconciliation";
import { readPromptOutput } from "@/lib/execution-host/prompt-output";

export const PERMISSION_RESUME_PROMPT =
  "Resuming after operator response — please continue with the prior tool call.";

const log = pino({
  name: "flow-permission-resume",
  level: process.env.LOG_LEVEL ?? "info",
});

const sourceSchema = z.object({
  requestId: z.string().min(1),
  supervisorSessionId: z.string().min(1),
  options: z.array(z.object({ optionId: z.string().min(1) })),
  flowPrompt: nodePermissionSourceSchema,
});

const flowSourceSchema = sourceSchema.extend({
  flowPrompt: flowPermissionSourceSchema,
});

export type PreparedPermissionResult = PreparedPermissionEvidence &
  Readonly<{ kind: "completed" }> &
  (
    | Readonly<{ domain: "node"; completion: FlowActionCompletion }>
    | Readonly<{
        domain: "gate";
        completion: GatePromptCompletion;
        parentActionSha256: string;
      }>
  );

type PermissionResultPreflight =
  | PreparedPermissionResult
  | Readonly<{ kind: "pending"; reason: string }>
  | null;

/** Historical input evidence and full output are read before capacity/run
 * locks. Missing evidence cannot authorize a replacement paid turn.
 */
export async function prepareFlowPermissionResult(
  db: Db,
  runId: string,
  transport: ExecutionHostTransport,
): Promise<PermissionResultPreflight> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));

  if (run?.runKind !== "flow") return null;
  const candidates = await db
    .select()
    .from(hitlRequests)
    .where(
      and(
        eq(hitlRequests.runId, runId),
        eq(hitlRequests.kind, "permission"),
        isNull(hitlRequests.respondedAt),
        sql`${hitlRequests.schema}->'flowPrompt' IS NOT NULL`,
      ),
    );

  if (candidates.length === 0) return null;
  if (candidates.length !== 1)
    throw new PromptOwnerInvariantError("permission_resume_source_count");
  const hitl = candidates[0];
  const response = hitl.response as Record<string, unknown> | null;

  if (response?._delivery === undefined) return null;
  const source = flowSourceSchema.safeParse(hitl.schema);
  const delivery = z
    .object({ commandId: z.string().min(1) })
    .safeParse(response._delivery);

  if (
    !source.success ||
    !delivery.success ||
    typeof response.optionId !== "string"
  )
    throw new PromptOwnerInvariantError("permission_resume_source_shape");
  const [input] = await db
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.id, delivery.data.commandId));
  const expectedPayload = {
    kind: "permission",
    action: "select",
    requestId: source.data.requestId,
    optionId: response.optionId,
  };

  if (
    !input ||
    input.runId !== runId ||
    input.kind !== "session.input" ||
    input.executionAssignmentId !== source.data.flowPrompt.assignmentId ||
    input.targetSessionId !== source.data.supervisorSessionId ||
    canonicalCommandJson(input.payload) !==
      canonicalCommandJson(expectedPayload) ||
    canonicalCommandJson(response._delivery) !==
      canonicalCommandJson({
        commandId: input.id,
        hostSessionId: input.targetSessionId,
        payload: expectedPayload,
      })
  )
    throw new PromptOwnerInvariantError("permission_result_input_identity");
  const receipt = await transport.getCommandReceipt(input.id);

  if (!receipt) return { kind: "pending", reason: "input_receipt_missing" };
  if (
    receipt.commandId !== input.id ||
    receipt.runId !== runId ||
    receipt.kind !== input.kind ||
    receipt.assignmentEpoch !== input.assignmentEpoch
  )
    throw new PromptOwnerInvariantError("permission_result_receipt_identity");
  if (
    receipt.phase !== "completed" ||
    receipt.httpStatus !== 200 ||
    receipt.body?.ok !== true
  )
    return { kind: "pending", reason: "input_not_confirmed" };
  const signal = AbortSignal.timeout(30_000);
  const evidence = await reconcilePromptCommand({
    db,
    commandId: source.data.flowPrompt.commandId,
    signal,
    lookupReceipt: (id) => transport.getCommandReceipt(id),
  });
  const command = evidence.command;

  if (evidence.disposition !== "settled" || !isPermissionResultCommand(command))
    return { kind: "pending", reason: "source_not_completed" };
  const [incarnation] = await db
    .select()
    .from(runSessionIncarnations)
    .where(eq(runSessionIncarnations.id, source.data.flowPrompt.incarnationId));

  if (
    command.executionHostId !== input.executionHostId ||
    command.executionAssignmentId !== input.executionAssignmentId ||
    command.assignmentEpoch !== input.assignmentEpoch ||
    !incarnation?.acpSessionId
  )
    throw new PromptOwnerInvariantError("permission_result_source_identity");
  // A checkpoint event arriving after release is historical and cannot update
  // the current lifecycle projection. Its exact acknowledged command proves
  // teardown even when the old incarnation still displays its last live state.
  const [checkpoint] = await db
    .select()
    .from(executionCommands)
    .where(
      and(
        eq(executionCommands.runId, runId),
        eq(
          executionCommands.executionAssignmentId,
          input.executionAssignmentId,
        ),
        eq(executionCommands.targetSessionId, source.data.supervisorSessionId),
        eq(executionCommands.kind, "session.checkpoint"),
        eq(executionCommands.state, "succeeded"),
      ),
    )
    .limit(1);

  if (
    !checkpoint ||
    checkpoint.result?.sessionId !== source.data.supervisorSessionId
  )
    return { kind: "pending", reason: "source_checkpoint_pending" };
  const outcome: PromptOwnerOutcome =
    command.state === "succeeded"
      ? {
          state: "succeeded",
          ...(await readPromptOutput({ db, commandId: command.id, signal })),
        }
      : { state: "failed", error: command.lastError };
  const prepared: PreparedPermissionEvidence = {
    hitlRequestId: hitl.id,
    sourceJson: canonicalCommandJson(hitl.schema),
    responseJson: canonicalCommandJson(response),
    flowRevisionId: run.flowRevisionId,
    requestSha256: command.requestSha256,
    terminalEvidenceSha256: command.terminalEvidenceSha256,
    sourceState: command.state,
    inputCommandId: input.id,
    checkpointCommandId: checkpoint.id,
    inputReceipt: receipt,
  };
  const gateSource = gatePermissionSourceSchema.safeParse(
    source.data.flowPrompt,
  );

  if (gateSource.success) {
    const ref = command.ownerRef;

    if (
      command.ownerKind !== "flow_node_attempt" ||
      (ref?.variant !== "gate_ai" && ref?.variant !== "gate_skill")
    )
      throw new PromptOwnerInvariantError(
        "gate_permission_result_source_owner",
      );
    const [parent] = await db
      .select()
      .from(nodeAttempts)
      .where(eq(nodeAttempts.id, ref.nodeAttemptId));

    if (!parent || parent.runId !== runId)
      throw new PromptOwnerInvariantError(
        "gate_permission_result_parent_missing",
      );
    const completion = await decodeGatePromptCompletion({
      db,
      ref,
      outcome,
    });

    signal.throwIfAborted();
    if (completion.flowRevisionId !== run.flowRevisionId)
      throw new PromptOwnerInvariantError(
        "gate_permission_result_revision_changed",
      );

    return {
      ...prepared,
      kind: "completed",
      domain: "gate",
      completion,
      parentActionSha256: gateParentActionDigest(parent.actionCompletion),
    };
  }
  const completion = await decodeNodePromptCompletion({
    commandId: command.id,
    promptOrdinal: source.data.flowPrompt.promptOrdinal,
    acpSessionId: incarnation.acpSessionId,
    outcome,
  });

  signal.throwIfAborted();

  return { ...prepared, kind: "completed", domain: "node", completion };
}

type LockedPermissionSource = Readonly<{
  run: Run & { projectId: string };
  hitl: HitlRequest;
  response: Record<string, unknown> & { optionId: string };
  source: z.infer<typeof sourceSchema>;
  command: ExecutionCommand;
  prior: ExecutionAssignment;
  attempt: NodeAttempt;
  incarnation: RunSessionIncarnation & { acpSessionId: string };
}>;

/** Lock the exact checkpointed node generation inside its capacity claim. */
async function lockNodePermissionSource(
  tx: Db,
  assignment: ExecutionAssignment,
): Promise<LockedPermissionSource | null> {
  const [run] = await tx
    .select()
    .from(runs)
    .where(eq(runs.id, assignment.runId));

  if (run?.runKind !== "flow") return null;
  const candidates = await tx
    .select()
    .from(hitlRequests)
    .where(
      and(
        eq(hitlRequests.runId, run.id),
        eq(hitlRequests.kind, "permission"),
        isNull(hitlRequests.respondedAt),
        sql`${hitlRequests.schema}->'flowPrompt' IS NOT NULL`,
      ),
    )
    .for("update");

  if (candidates.length === 0) return null;
  if (candidates.length !== 1)
    throw new PromptOwnerInvariantError("permission_resume_source_count");
  const hitl = candidates[0];
  const parsed = sourceSchema.safeParse(hitl.schema);
  const response = hitl.response as Record<string, unknown> | null;

  if (!parsed.success || typeof response?.optionId !== "string")
    throw new PromptOwnerInvariantError("permission_resume_source_shape");
  const source = parsed.data;
  const [command] = await tx
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.id, source.flowPrompt.commandId))
    .for("update");
  const [prior] = await tx
    .select()
    .from(executionAssignments)
    .where(eq(executionAssignments.id, source.flowPrompt.assignmentId))
    .for("update");
  const [attempt] = await tx
    .select()
    .from(nodeAttempts)
    .where(eq(nodeAttempts.id, source.flowPrompt.nodeAttemptId))
    .for("update");
  const [incarnation] = await tx
    .select()
    .from(runSessionIncarnations)
    .where(eq(runSessionIncarnations.id, source.flowPrompt.incarnationId))
    .for("update");
  const ref = command?.ownerRef;

  if (
    !run.projectId ||
    run.status !== "NeedsInput" ||
    run.executionAssignmentId !== assignment.id ||
    assignment.state !== "active" ||
    assignment.placementReason !== "resume" ||
    !attempt ||
    attempt.runId !== run.id ||
    attempt.nodeId !== run.currentStepId ||
    hitl.stepId !== attempt.nodeId ||
    attempt.status !== "Running" ||
    attempt.endedAt !== null ||
    attempt.finishContinuation !== null ||
    attempt.actionPromptOrdinal !== source.flowPrompt.promptOrdinal ||
    attempt.executionAssignmentId !== prior?.id ||
    !command ||
    command.runId !== run.id ||
    command.kind !== "session.prompt" ||
    command.ownerKind !== "flow_node_attempt" ||
    (ref?.variant !== "node" && ref?.variant !== "permission_resume") ||
    ("variant" in source.flowPrompt
      ? ref.variant !== "permission_resume" ||
        ref.hitlRequestId !== source.flowPrompt.hitlRequestId
      : ref.variant !== "node") ||
    ref.nodeAttemptId !== attempt.id ||
    ref.promptOrdinal !== attempt.actionPromptOrdinal ||
    ref.assignmentId !== prior?.id ||
    ref.incarnationId !== incarnation?.id ||
    command.executionAssignmentId !== prior?.id ||
    command.targetSessionId !== source.supervisorSessionId ||
    prior?.state !== "released" ||
    prior.releasedReason !== "checkpointed" ||
    prior.epoch >= assignment.epoch ||
    prior.executionHostId !== assignment.executionHostId ||
    incarnation?.executionAssignmentId !== prior.id ||
    incarnation.hostSessionId !== source.supervisorSessionId ||
    !incarnation.acpSessionId ||
    !source.options.some((option) => option.optionId === response.optionId)
  )
    throw new PromptOwnerInvariantError("permission_resume_generation");

  return {
    run: { ...run, projectId: run.projectId },
    hitl,
    response: { ...response, optionId: response.optionId },
    source,
    command,
    prior,
    attempt,
    incarnation: { ...incarnation, acpSessionId: incarnation.acpSessionId },
  };
}

/** A checkpoint cancelled an unanswered request. Only the capacity claim
 * authorizes a new turn, after excluding an unclassified admitted input.
 */
export async function authorizeNodePermissionResume(
  tx: Db,
  assignment: ExecutionAssignment,
): Promise<void> {
  const context = await lockNodePermissionSource(tx, assignment);

  if (!context) return;
  const { run, hitl, response, source, command, prior, attempt, incarnation } =
    context;

  if (response._delivery !== undefined)
    throw new PromptOwnerInvariantError("permission_resume_input_unclassified");
  const promptOrdinal = attempt.actionPromptOrdinal + 1;

  await tx
    .update(nodeAttempts)
    .set({
      executionAssignmentId: assignment.id,
      actionPromptOrdinal: promptOrdinal,
      actionCompletion: null,
      actionResume: {
        version: 1,
        kind: "permission",
        sourceCommandId: command.id,
        sourceAssignmentId: prior.id,
        assignmentId: assignment.id,
        promptOrdinal,
        resumeSessionId: incarnation.acpSessionId,
        hitlRequestId: hitl.id,
        sourceRequestId: source.requestId,
        optionId: response.optionId,
      },
    })
    .where(eq(nodeAttempts.id, attempt.id));
  log.info(
    {
      runId: run.id,
      nodeAttemptId: attempt.id,
      hitlRequestId: hitl.id,
      sourceCommandId: command.id,
      sourceAssignmentId: prior.id,
      assignmentId: assignment.id,
      promptOrdinal,
    },
    "permission-resume-authorized",
  );
}

/** Transfer verified historical output under current authority without
 * another prompt. The source owner adapter remains fenced.
 */
export async function authorizeNodePermissionResult(
  tx: Db,
  assignment: ExecutionAssignment,
  prepared: Extract<PreparedPermissionResult, { domain: "node" }>,
): Promise<void> {
  const context = await lockNodePermissionSource(tx, assignment);

  if (!context)
    throw new PromptOwnerInvariantError("permission_result_source_disappeared");
  const { run, hitl, response, source, command, prior, attempt, incarnation } =
    context;

  if (
    prepared.completion.commandId !== command.id ||
    prepared.completion.promptOrdinal !== attempt.actionPromptOrdinal ||
    prepared.completion.result.acpSessionId !== incarnation.acpSessionId
  )
    throw new PromptOwnerInvariantError("permission_result_generation");
  const { input, checkpoint } = await lockPermissionResultEvidence(
    tx,
    context,
    prepared,
  );

  await tx
    .update(nodeAttempts)
    .set({
      executionAssignmentId: assignment.id,
      actionCompletion: prepared.completion,
      actionResume: {
        version: 1,
        kind: "permission_result",
        sourceCommandId: command.id,
        sourceAssignmentId: prior.id,
        assignmentId: assignment.id,
        promptOrdinal: attempt.actionPromptOrdinal,
        resumeSessionId: incarnation.acpSessionId,
        hitlRequestId: hitl.id,
        sourceRequestId: source.requestId,
        optionId: response.optionId,
        inputCommandId: input.id,
        checkpointCommandId: checkpoint.id,
        sourceIncarnationId: incarnation.id,
      },
    })
    .where(eq(nodeAttempts.id, attempt.id));
  await completePermissionResultHandoff(tx, context, prepared, assignment);
  log.info(
    {
      runId: run.id,
      nodeAttemptId: attempt.id,
      sourceCommandId: command.id,
      inputCommandId: input.id,
      sourceAssignmentId: prior.id,
      assignmentId: assignment.id,
      promptOrdinal: attempt.actionPromptOrdinal,
    },
    "permission-result-handoff-authorized",
  );
}

export function pendingNodePermissionResumeExists(): SQL {
  return sql`exists (
    select 1 from node_attempts resume_attempt
    where resume_attempt.run_id = ${runs.id}
      and resume_attempt.node_id = ${runs.currentStepId}
      and resume_attempt.execution_assignment_id = ${runs.executionAssignmentId}
      and resume_attempt.status = 'Running' and resume_attempt.ended_at is null
      and resume_attempt.finish_continuation is null
      and (resume_attempt.action_resume->>'kind' = 'permission'
        or (resume_attempt.action_resume->>'kind' = 'permission_result'
          and resume_attempt.action_completion is not null))
      and resume_attempt.action_resume->>'assignmentId' = ${runs.executionAssignmentId}
      and resume_attempt.action_resume->'promptOrdinal' = to_jsonb(resume_attempt.action_prompt_ordinal)
  )`;
}

export async function hasFlowPermissionResume(
  db: Db,
  runId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.id, runId),
        sql`(${pendingNodePermissionResumeExists()} or ${pendingGatePermissionResumeExists()})`,
      ),
    );

  return row !== undefined;
}
