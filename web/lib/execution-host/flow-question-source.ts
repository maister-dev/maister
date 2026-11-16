import "server-only";

import type { ActiveRunSession } from "@/lib/runs/active-run-session";
import type { Db } from "./db";
import type { z } from "zod";

import { and, eq, isNull, sql } from "drizzle-orm";

import { nodePermissionSourceSchema } from "./flow-permission-source";

import {
  hitlRequests,
  runSessionIncarnations,
  runSessions,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

export type FlowQuestionSource = Readonly<{
  supervisorSessionId: string;
  flowQuestion: z.infer<typeof nodePermissionSourceSchema>;
}>;

/** Current appointment resolution also works while its exact source is parked; it grants no new prompt proof. */
export async function selectCurrentFlowQuestionNode(
  tx: Db,
  runId: string,
): Promise<string> {
  const rows = (
    await tx.execute(sql`
    SELECT node.id FROM runs execution JOIN node_attempts node ON node.run_id=execution.id AND node.node_id=execution.current_step_id
    WHERE execution.id=${runId} AND execution.run_kind='flow' AND node.status IN ('Running','NeedsInput','Succeeded')
      AND node.node_type IN ('ai_coding','orchestrator')
      AND NOT EXISTS(SELECT 1 FROM node_attempts newer WHERE newer.run_id=execution.id AND newer.node_id=node.node_id AND newer.attempt>node.attempt)
    FOR SHARE OF node
  `)
  ).rows;

  if (rows.length !== 1 || typeof rows[0]?.id !== "string")
    throw new MaisterError(
      "CONFLICT",
      "Clarification requires its exact current Flow node appointment",
    );

  return rows[0].id;
}

/** Derive the current node's actually accepted owned prompt and session; caller selectors supply no source proof. */
export async function captureFlowQuestionSource(
  tx: Db,
  runId: string,
): Promise<FlowQuestionSource> {
  const rows = (
    await tx.execute(sql`
    SELECT command.id AS command_id,command.owner_ref,command.target_session_id,
      attempt.id AS node_attempt_id,attempt.action_prompt_ordinal,
      fence.id AS assignment_id,incarnation.id AS incarnation_id
    FROM runs execution
    JOIN node_attempts attempt ON attempt.run_id=execution.id AND attempt.node_id=execution.current_step_id
      AND attempt.status='Running' AND attempt.execution_assignment_id=execution.execution_assignment_id
    JOIN execution_assignments fence ON fence.id=execution.execution_assignment_id AND fence.run_id=execution.id AND fence.state='active'
    JOIN execution_commands command ON command.run_id=execution.id AND command.execution_assignment_id=fence.id
      AND command.assignment_epoch=fence.epoch AND command.kind='session.prompt' AND command.owner_kind='flow_node_attempt'
      AND command.owner_ref->>'nodeAttemptId'=attempt.id AND command.owner_ref->'promptOrdinal'=to_jsonb(attempt.action_prompt_ordinal)
      AND command.owner_ref->>'variant' IN ('node','permission_resume') AND command.state='accepted'
    JOIN run_session_incarnations incarnation ON incarnation.id=command.owner_ref->>'incarnationId'
      AND incarnation.run_id=execution.id AND incarnation.execution_assignment_id=fence.id
      AND incarnation.execution_host_id=command.execution_host_id AND incarnation.assignment_epoch=fence.epoch
      AND incarnation.host_session_id=command.target_session_id AND incarnation.acp_session_id IS NOT NULL
    WHERE execution.id=${runId} AND execution.run_kind='flow' AND execution.status='Running'
      AND NOT EXISTS(SELECT 1 FROM node_attempts newer WHERE newer.run_id=execution.id AND newer.node_id=attempt.node_id AND newer.attempt>attempt.attempt)
    FOR UPDATE OF attempt
  `)
  ).rows;
  const source = rows[0];

  if (
    rows.length !== 1 ||
    !source ||
    typeof source.target_session_id !== "string"
  )
    throw new MaisterError(
      "CONFLICT",
      "Flow clarification requires one current accepted node prompt and its exact live session",
      { details: { reason: "assignment_flow_question_source_unavailable" } },
    );
  const owner = source.owner_ref as Readonly<{
    variant?: unknown;
    hitlRequestId?: unknown;
  }>;
  const parsed = nodePermissionSourceSchema.safeParse({
    version: 1,
    commandId: source.command_id,
    nodeAttemptId: source.node_attempt_id,
    promptOrdinal: source.action_prompt_ordinal,
    assignmentId: source.assignment_id,
    incarnationId: source.incarnation_id,
    ...(owner.variant === "permission_resume"
      ? { variant: "permission_resume", hitlRequestId: owner.hitlRequestId }
      : {}),
  });

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "The current Flow question prompt proof is invalid",
    );

  return {
    supervisorSessionId: source.target_session_id,
    flowQuestion: parsed.data,
  };
}

/** Recovery addresses the question's exact incarnation, never whichever named Flow session currently ranks newest. */
export async function loadFlowQuestionSession(
  db: Db,
  runId: string,
): Promise<ActiveRunSession> {
  const rows = await db
    .select({
      id: runSessions.id,
      executionAssignmentId: runSessionIncarnations.executionAssignmentId,
      sessionName: runSessions.sessionName,
      acpSessionId: runSessionIncarnations.acpSessionId,
      hostSessionId: runSessionIncarnations.hostSessionId,
      runnerSnapshot: runSessions.runnerSnapshot,
      capabilityAgent: runSessions.capabilityAgent,
      runnerId: runSessions.runnerId,
      runnerResolutionTier: runSessions.runnerResolutionTier,
    })
    .from(hitlRequests)
    .innerJoin(
      runSessionIncarnations,
      eq(
        runSessionIncarnations.id,
        sql`${hitlRequests.schema}->'flowQuestion'->>'incarnationId'`,
      ),
    )
    .innerJoin(
      runSessions,
      eq(runSessions.id, runSessionIncarnations.runSessionId),
    )
    .where(
      and(
        eq(hitlRequests.runId, runId),
        eq(hitlRequests.kind, "agent_question"),
        eq(hitlRequests.activationState, "pending_termination"),
        isNull(hitlRequests.respondedAt),
        isNull(hitlRequests.supersededAt),
        sql`${hitlRequests.specialistAssignmentId} IS NOT NULL`,
        eq(runSessionIncarnations.runId, runId),
        eq(runSessions.runId, runId),
      ),
    )
    .limit(2);

  if (rows.length !== 1)
    throw new MaisterError(
      "CONFLICT",
      "Flow question checkpoint requires its exact retained source incarnation",
    );

  return rows[0];
}
