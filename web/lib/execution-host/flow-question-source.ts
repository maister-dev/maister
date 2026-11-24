import "server-only";

import type { ActiveRunSession } from "@/lib/runs/active-run-session";
import type { SQL } from "drizzle-orm";
import type { Db } from "./db";
import type { z } from "zod";

import { and, eq, isNull, sql } from "drizzle-orm";

import { nodePermissionSourceSchema } from "./flow-permission-source";

import {
  hitlRequests,
  nodeAttempts,
  runs,
  runSessionIncarnations,
  runSessions,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

export type FlowQuestionSource = Readonly<{
  supervisorSessionId: string;
  flowQuestion: z.infer<typeof nodePermissionSourceSchema>;
}>;

export type FlowQuestionPrompt = Readonly<{
  state: "ready" | "pending";
  source: FlowQuestionSource;
}>;

/** The Run lock serializes transitions, while attempt numbers distinguish visits to the same graph node. */
export function latestFlowQuestionAttempt() {
  return sql`NOT EXISTS (SELECT 1 FROM node_attempts newer WHERE newer.run_id=${nodeAttempts.runId} AND newer.node_id=${nodeAttempts.nodeId} AND newer.attempt>${nodeAttempts.attempt})`;
}

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
  credentialAttemptId?: string,
): Promise<FlowQuestionSource> {
  const proof = await readFlowQuestionPrompt(
    tx,
    runId,
    credentialAttemptId === undefined
      ? sql`attempt.node_id=execution.current_step_id`
      : sql`attempt.id=${credentialAttemptId}`,
    credentialAttemptId === undefined
      ? sql`command.state='accepted'`
      : sql`command.state='accepted' AND incarnation.state='active'`,
  );

  return proof.source;
}

/** An immediate callback can precede the manager's prompt ACK or session activation. */
export function readScopedFlowQuestionPrompt(
  tx: Db,
  runId: string,
  credentialAttemptId: string,
): Promise<FlowQuestionPrompt> {
  return readFlowQuestionPrompt(
    tx,
    runId,
    sql`attempt.id=${credentialAttemptId}`,
    sql`command.state IN ('delivering','accepted')
      AND command.completed_at IS NULL AND command.retired_at IS NULL
      AND command.application_state='pending' AND command.application_error IS NULL
      AND incarnation.state IN ('created','active') AND incarnation.ended_at IS NULL
      AND command.execution_host_id=fence.execution_host_id
      AND command.owner_ref->>'runId'=execution.id
      AND command.owner_ref->>'assignmentId'=fence.id
      AND command.owner_ref->'assignmentEpoch'=to_jsonb(fence.epoch)
      AND command.owner_ref->>'runSessionId'=incarnation.run_session_id
      AND command.owner_ref->'version'='1'::jsonb`,
  );
}

async function readFlowQuestionPrompt(
  tx: Db,
  runId: string,
  attemptScope: SQL,
  promptEligibility: SQL,
): Promise<FlowQuestionPrompt> {
  const rows = (
    await tx.execute(sql`
    SELECT command.id AS command_id,command.owner_ref,command.target_session_id,
      attempt.id AS node_attempt_id,attempt.action_prompt_ordinal,
      fence.id AS assignment_id,incarnation.id AS incarnation_id,
      (command.state='accepted' AND incarnation.state='active') AS ready
    FROM runs execution
    JOIN node_attempts attempt ON attempt.run_id=execution.id AND ${attemptScope}
      AND attempt.status='Running' AND attempt.execution_assignment_id=execution.execution_assignment_id
    JOIN execution_assignments fence ON fence.id=execution.execution_assignment_id AND fence.run_id=execution.id AND fence.state='active'
    JOIN execution_commands command ON command.run_id=execution.id AND command.execution_assignment_id=fence.id
      AND command.assignment_epoch=fence.epoch AND command.kind='session.prompt' AND command.owner_kind='flow_node_attempt'
      AND command.owner_ref->>'nodeAttemptId'=attempt.id AND command.owner_ref->'promptOrdinal'=to_jsonb(attempt.action_prompt_ordinal)
      AND command.owner_ref->>'variant' IN ('node','permission_resume')
    JOIN run_session_incarnations incarnation ON incarnation.id=command.owner_ref->>'incarnationId'
      AND incarnation.run_id=execution.id AND incarnation.execution_assignment_id=fence.id
      AND incarnation.execution_host_id=command.execution_host_id AND incarnation.assignment_epoch=fence.epoch
      AND incarnation.host_session_id=command.target_session_id AND incarnation.acp_session_id IS NOT NULL
    WHERE execution.id=${runId} AND execution.run_kind='flow' AND execution.status='Running'
      AND NOT EXISTS(SELECT 1 FROM node_attempts newer WHERE newer.run_id=execution.id AND newer.node_id=attempt.node_id AND newer.attempt>attempt.attempt)
      AND ${promptEligibility}
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
    state: source.ready === true ? "ready" : "pending",
    source: {
      supervisorSessionId: source.target_session_id,
      flowQuestion: parsed.data,
    },
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

/** The Run pointer selects a parked attempt; the recorded incarnation selects its exact logical session. */
export async function loadCurrentFlowNodeQuestionSession(
  db: Db,
  runId: string,
) {
  const [row] = await db
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
    .from(runs)
    .innerJoin(
      nodeAttempts,
      and(
        eq(nodeAttempts.runId, runs.id),
        eq(nodeAttempts.nodeId, runs.currentStepId),
      ),
    )
    .innerJoin(
      hitlRequests,
      and(
        eq(hitlRequests.flowNodeAttemptId, nodeAttempts.id),
        sql`${hitlRequests.id}=${nodeAttempts.actionResume}->>'questionId'`,
      ),
    )
    .innerJoin(
      runSessionIncarnations,
      sql`${runSessionIncarnations.id}=${nodeAttempts.actionResume}->>'sourceIncarnationId'`,
    )
    .innerJoin(
      runSessions,
      eq(runSessions.id, runSessionIncarnations.runSessionId),
    )
    .where(
      and(
        eq(runs.id, runId),
        sql`${nodeAttempts.actionResume}->>'kind'='node_question'
      AND ${nodeAttempts.status} IN ('Running','NeedsInput') AND ${hitlRequests.flowAnswerAcceptedAt} IS NOT NULL
      AND ${hitlRequests.supersededAt} IS NULL AND ${runSessionIncarnations.runId}=${runs.id}
      AND NOT EXISTS (SELECT 1 FROM node_attempts newer WHERE newer.run_id=${runs.id} AND newer.node_id=${nodeAttempts.nodeId} AND newer.attempt>${nodeAttempts.attempt})`,
      ),
    );

  return row ?? null;
}

/** Current accepted answers for the correlated Run. Callers order them by first acceptance. */
function eligibleFlowQuestionAnswers() {
  return sql`SELECT q.step_id,q.flow_answer_accepted_at,q.id FROM hitl_requests q
    JOIN node_attempts n ON n.id=q.flow_node_attempt_id AND n.run_id=q.run_id
    JOIN users u ON u.id=q.flow_answer_user_id
    WHERE q.run_id=${runs.id} AND q.activation_state='active' AND q.responded_at IS NULL AND q.superseded_at IS NULL
      AND q.flow_answer_accepted_at IS NOT NULL AND n.action_resume->>'questionId'=q.id AND n.status='NeedsInput'
      AND NOT EXISTS (SELECT 1 FROM node_attempts newer WHERE newer.run_id=n.run_id AND newer.node_id=n.node_id AND newer.attempt>n.attempt)
      AND u.account_status='active' AND NOT u.must_change_password AND
      (u.role='admin' OR EXISTS(SELECT 1 FROM project_members m WHERE m.project_id=${runs.projectId} AND m.user_id=u.id AND m.role IN ('owner','admin','member')))`;
}

/** An obsolete or unauthorized node answer cannot occupy the first capacity-queue position. */
export function currentFlowQuestionResumeEligible() {
  return sql`(NOT EXISTS (SELECT 1 FROM hitl_requests q WHERE q.run_id=${runs.id} AND q.step_id=${runs.currentStepId}
    AND q.flow_node_attempt_id IS NOT NULL AND q.activation_state='active' AND q.responded_at IS NULL AND q.superseded_at IS NULL)
    OR EXISTS (${eligibleFlowQuestionAnswers()} AND q.step_id=${runs.currentStepId}))`;
}

/** A revoked responder or replaced visit must not prevent an already accepted sibling from resuming. */
export async function recoverEligibleFlowQuestionHeads(db: Db): Promise<void> {
  await db.execute(sql`WITH replacements AS (
    SELECT runs.id,candidate.step_id FROM runs
    CROSS JOIN LATERAL (${eligibleFlowQuestionAnswers()} ORDER BY q.flow_answer_accepted_at,q.id LIMIT 1) AS candidate
    WHERE runs.status='NeedsInputIdle' AND runs.resume_requested_at IS NOT NULL AND NOT ${currentFlowQuestionResumeEligible()}
    ORDER BY runs.resume_requested_at,runs.id LIMIT 30 FOR NO KEY UPDATE OF runs SKIP LOCKED
  ) UPDATE runs SET current_step_id=replacements.step_id FROM replacements WHERE runs.id=replacements.id`);
}
