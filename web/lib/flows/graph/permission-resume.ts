import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionAssignment } from "@/lib/db/schema";

import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import pino from "pino";

import {
  executionAssignments,
  executionCommands,
  hitlRequests,
  nodeAttempts,
  runSessionIncarnations,
  runs,
} from "@/lib/db/schema";
import { PromptOwnerInvariantError } from "@/lib/execution-host/prompt-owners";

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
  flowPrompt: z
    .object({
      version: z.literal(1),
      commandId: z.string().min(1),
      nodeAttemptId: z.string().min(1),
      promptOrdinal: z.number().int().nonnegative(),
      assignmentId: z.string().min(1),
      incarnationId: z.string().min(1),
    })
    .strict(),
});

/** Only the capacity claim creates a new turn. A checkpoint cancelled an
 * unanswered request; its successful end_turn alone is not delivered input.
 */
export async function authorizeNodePermissionResume(
  tx: Db,
  assignment: ExecutionAssignment,
): Promise<void> {
  const [run] = await tx
    .select()
    .from(runs)
    .where(eq(runs.id, assignment.runId));

  if (run?.runKind !== "flow") return;
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

  if (candidates.length === 0) return;
  if (candidates.length !== 1)
    throw new PromptOwnerInvariantError("permission_resume_source_count");
  const hitl = candidates[0];
  const parsed = sourceSchema.safeParse(hitl.schema);
  const response = hitl.response as Record<string, unknown> | null;

  if (!parsed.success || typeof response?.optionId !== "string")
    throw new PromptOwnerInvariantError("permission_resume_source_shape");
  // An admitted input must be classified from its historical receipt before
  // another paid turn can be authorized. No ACK does not mean no host effect.
  if (response._delivery !== undefined)
    throw new PromptOwnerInvariantError("permission_resume_input_unclassified");
  const source = parsed.data;
  const [command] = await tx
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.id, source.flowPrompt.commandId));
  const [prior] = await tx
    .select()
    .from(executionAssignments)
    .where(eq(executionAssignments.id, source.flowPrompt.assignmentId));
  const [attempt] = await tx
    .select()
    .from(nodeAttempts)
    .where(eq(nodeAttempts.id, source.flowPrompt.nodeAttemptId))
    .for("update");
  const [incarnation] = await tx
    .select()
    .from(runSessionIncarnations)
    .where(eq(runSessionIncarnations.id, source.flowPrompt.incarnationId));
  const ref = command?.ownerRef;

  if (
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
    ref?.variant !== "node" ||
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

export function pendingNodePermissionResumeExists(): SQL {
  return sql`exists (
    select 1 from node_attempts resume_attempt
    where resume_attempt.run_id = ${runs.id}
      and resume_attempt.node_id = ${runs.currentStepId}
      and resume_attempt.execution_assignment_id = ${runs.executionAssignmentId}
      and resume_attempt.status = 'Running' and resume_attempt.ended_at is null
      and resume_attempt.finish_continuation is null
      and resume_attempt.action_resume->>'kind' = 'permission'
      and resume_attempt.action_resume->>'assignmentId' = ${runs.executionAssignmentId}
      and resume_attempt.action_resume->'promptOrdinal' = to_jsonb(resume_attempt.action_prompt_ordinal)
  )`;
}

export async function hasNodePermissionResume(
  db: Db,
  runId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.id, runId), pendingNodePermissionResumeExists()));

  return row !== undefined;
}
