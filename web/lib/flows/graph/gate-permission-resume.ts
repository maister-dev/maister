import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionAssignment } from "@/lib/db/schema";
import type { FlowActionCompletion } from "./action-completion";

import { createHash } from "node:crypto";

import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import pino from "pino";

import { canonicalCommandJson } from "../../../../runtime/command-json";

import { gatePermissionSourceSchema } from "./permission-source";

import {
  executionAssignments,
  executionCommands,
  gateResults,
  hitlRequests,
  nodeAttempts,
  runSessionIncarnations,
  runs,
} from "@/lib/db/schema";
import { PromptOwnerInvariantError } from "@/lib/execution-host/prompt-owners";

export type GatePermissionResume = Readonly<{
  version: 1;
  kind: "permission";
  sourceCommandId: string;
  sourceAssignmentId: string;
  sourceIncarnationId: string;
  assignmentId: string;
  promptOrdinal: number;
  resumeSessionId: string;
  hitlRequestId: string;
  sourceRequestId: string;
  optionId: string;
  parentActionSha256: string;
}>;

const sourceSchema = z.object({
  requestId: z.string().min(1),
  supervisorSessionId: z.string().min(1),
  options: z.array(z.object({ optionId: z.string().min(1) })),
  flowPrompt: gatePermissionSourceSchema,
});
const log = pino({
  name: "flow-gate-permission-resume",
  level: process.env.LOG_LEVEL ?? "info",
});

function actionDigest(completion: FlowActionCompletion | null): string {
  return createHash("sha256")
    .update(canonicalCommandJson(completion))
    .digest("hex");
}

/** Only the normal capacity claim can advance a checkpointed gate turn. The
 * existing evaluation and parent action survive; no new node visit is minted.
 */
export async function authorizeGatePermissionResume(
  tx: Db,
  assignment: ExecutionAssignment,
): Promise<boolean> {
  const candidates = await tx
    .select()
    .from(hitlRequests)
    .where(
      and(
        eq(hitlRequests.runId, assignment.runId),
        eq(hitlRequests.kind, "permission"),
        isNull(hitlRequests.respondedAt),
        sql`${hitlRequests.schema}->'flowPrompt'->>'variant' in ('gate_ai', 'gate_skill')`,
      ),
    )
    .for("update");

  if (candidates.length === 0) return false;
  if (candidates.length !== 1)
    throw new PromptOwnerInvariantError("gate_permission_source_count");
  const hitl = candidates[0];
  const parsed = sourceSchema.safeParse(hitl.schema);
  const response = hitl.response as {
    optionId?: string;
    _delivery?: unknown;
  } | null;

  if (!parsed.success || typeof response?.optionId !== "string")
    throw new PromptOwnerInvariantError("gate_permission_source_shape");
  if (response._delivery !== undefined)
    throw new PromptOwnerInvariantError("gate_permission_input_unclassified");
  const source = parsed.data;
  const [run] = await tx
    .select()
    .from(runs)
    .where(eq(runs.id, assignment.runId));
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
  const [evaluation] = await tx
    .select()
    .from(gateResults)
    .where(
      and(
        eq(gateResults.runId, assignment.runId),
        eq(gateResults.nodeAttemptId, source.flowPrompt.nodeAttemptId),
        eq(gateResults.gateId, source.flowPrompt.gateId),
      ),
    )
    .orderBy(desc(gateResults.createdAt), desc(gateResults.id))
    .limit(1)
    .for("update");
  const [incarnation] = await tx
    .select()
    .from(runSessionIncarnations)
    .where(eq(runSessionIncarnations.id, source.flowPrompt.incarnationId))
    .for("update");
  const ref = command?.ownerRef;

  if (
    run?.runKind !== "flow" ||
    run.status !== "NeedsInput" ||
    run.executionAssignmentId !== assignment.id ||
    assignment.state !== "active" ||
    assignment.placementReason !== "resume" ||
    !attempt ||
    attempt.runId !== run.id ||
    attempt.nodeId !== run.currentStepId ||
    !["Running", "Succeeded"].includes(attempt.status) ||
    attempt.finishContinuation !== null ||
    attempt.executionAssignmentId !== prior?.id ||
    !evaluation ||
    evaluation.id !== source.flowPrompt.evaluationId ||
    evaluation.kind !==
      (source.flowPrompt.variant === "gate_skill"
        ? "skill_check"
        : "ai_judgment") ||
    !["running", "passed", "failed"].includes(evaluation.status) ||
    evaluation.promptOrdinal !== source.flowPrompt.promptOrdinal ||
    hitl.stepId !== evaluation.gateId ||
    !command ||
    command.kind !== "session.prompt" ||
    command.ownerKind !== "flow_node_attempt" ||
    command.runId !== run.id ||
    (ref?.variant !== "gate_ai" && ref?.variant !== "gate_skill") ||
    ref.variant !== source.flowPrompt.variant ||
    ref.runId !== run.id ||
    ref.nodeAttemptId !== attempt.id ||
    ref.gateId !== evaluation.gateId ||
    ref.evaluationId !== evaluation.id ||
    ref.promptOrdinal !== evaluation.promptOrdinal ||
    ref.assignmentId !== prior?.id ||
    ref.incarnationId !== incarnation?.id ||
    command.executionAssignmentId !== prior?.id ||
    command.executionHostId !== assignment.executionHostId ||
    command.assignmentEpoch !== prior?.epoch ||
    ref.assignmentEpoch !== prior?.epoch ||
    command.targetSessionId !== source.supervisorSessionId ||
    prior?.runId !== run.id ||
    prior.state !== "released" ||
    prior.releasedReason !== "checkpointed" ||
    prior.epoch >= assignment.epoch ||
    prior.executionHostId !== assignment.executionHostId ||
    incarnation?.executionAssignmentId !== prior.id ||
    incarnation.executionHostId !== prior.executionHostId ||
    incarnation.assignmentEpoch !== prior.epoch ||
    incarnation.hostSessionId !== source.supervisorSessionId ||
    !incarnation.acpSessionId ||
    !source.options.some((option) => option.optionId === response.optionId)
  )
    throw new PromptOwnerInvariantError("gate_permission_resume_generation");

  const promptOrdinal = evaluation.promptOrdinal + 1;

  await tx
    .update(gateResults)
    .set({
      promptOrdinal,
      status: "running",
      verdict: null,
      endedAt: null,
      permissionResume: {
        version: 1,
        kind: "permission",
        sourceCommandId: command.id,
        sourceAssignmentId: prior.id,
        sourceIncarnationId: incarnation.id,
        assignmentId: assignment.id,
        promptOrdinal,
        resumeSessionId: incarnation.acpSessionId,
        hitlRequestId: hitl.id,
        sourceRequestId: source.requestId,
        optionId: response.optionId,
        parentActionSha256: actionDigest(attempt.actionCompletion),
      },
    })
    .where(eq(gateResults.id, evaluation.id));
  // The gate claim inherits the parent action, not its obsolete action-turn
  // authorization. Its digest below fences every resumed graph read.
  await tx
    .update(nodeAttempts)
    .set({ executionAssignmentId: assignment.id, actionResume: null })
    .where(eq(nodeAttempts.id, attempt.id));
  log.info(
    {
      runId: run.id,
      nodeAttemptId: attempt.id,
      evaluationId: evaluation.id,
      sourceCommandId: command.id,
      assignmentId: assignment.id,
      promptOrdinal,
    },
    "gate-permission-resume-authorized",
  );

  return true;
}

export function pendingGatePermissionResumeExists(): SQL {
  return sql`exists (
    select 1 from gate_results resumed_gate
    join node_attempts gate_parent on gate_parent.id = resumed_gate.node_attempt_id
    where resumed_gate.run_id = ${runs.id}
      and gate_parent.run_id = ${runs.id} and gate_parent.node_id = ${runs.currentStepId}
      and gate_parent.execution_assignment_id = ${runs.executionAssignmentId}
      and gate_parent.status in ('Running', 'Succeeded') and gate_parent.finish_continuation is null
      and resumed_gate.kind in ('ai_judgment', 'skill_check')
      and resumed_gate.status in ('running', 'passed', 'failed')
      and resumed_gate.permission_resume->>'assignmentId' = ${runs.executionAssignmentId}
      and resumed_gate.permission_resume->'promptOrdinal' = to_jsonb(resumed_gate.prompt_ordinal)
      and not exists (select 1 from gate_results newer_gate
        where newer_gate.run_id = resumed_gate.run_id and newer_gate.node_attempt_id = resumed_gate.node_attempt_id
          and newer_gate.gate_id = resumed_gate.gate_id
          and (newer_gate.created_at, newer_gate.id) > (resumed_gate.created_at, resumed_gate.id))
  )`;
}

/** Recover only the gate-authorized parent action under the current claim. */
export async function loadGatePermissionContinuation(
  db: Db,
  input: Readonly<{
    runId: string;
    assignmentId: string;
    nodeAttemptId: string;
  }>,
): Promise<GatePermissionResume | null> {
  const candidates = await db
    .select({ attempt: nodeAttempts, evaluation: gateResults })
    .from(runs)
    .innerJoin(
      nodeAttempts,
      and(
        eq(nodeAttempts.runId, runs.id),
        eq(nodeAttempts.nodeId, runs.currentStepId),
      ),
    )
    .innerJoin(
      gateResults,
      and(
        eq(gateResults.runId, runs.id),
        eq(gateResults.nodeAttemptId, nodeAttempts.id),
      ),
    )
    .where(
      and(
        eq(runs.id, input.runId),
        eq(runs.executionAssignmentId, input.assignmentId),
        eq(nodeAttempts.id, input.nodeAttemptId),
        pendingGatePermissionResumeExists(),
        sql`${gateResults.permissionResume}->>'assignmentId' = ${input.assignmentId}`,
      ),
    );

  if (candidates.length === 0) return null;
  if (candidates.length !== 1)
    throw new PromptOwnerInvariantError("gate_permission_continuation_count");
  const { attempt, evaluation } = candidates[0];
  const resume = evaluation.permissionResume;

  if (
    !resume ||
    attempt.executionAssignmentId !== input.assignmentId ||
    resume.promptOrdinal !== evaluation.promptOrdinal ||
    resume.parentActionSha256 !== actionDigest(attempt.actionCompletion)
  )
    throw new PromptOwnerInvariantError(
      "gate_permission_parent_action_changed",
    );

  return resume;
}
