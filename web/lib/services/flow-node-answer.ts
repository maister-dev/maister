import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type {
  ExecutionAssignment,
  HitlRequest,
  NodeAttempt,
} from "@/lib/db/schema";

import pino from "pino";
import { and, eq, sql } from "drizzle-orm";

import { assertAgentQuestionResponse } from "./agent-question-response";
import {
  nodeQuestionEnvelope,
  nodeQuestionReceipt,
} from "./flow-node-question";

import { latestFlowQuestionAttempt } from "@/lib/execution-host/flow-question-source";
import {
  assignments,
  hitlRequests,
  nodeAttempts,
  projectMembers,
  runs,
  users,
} from "@/lib/db/schema";
import { ensureUserActor, completeAssignment } from "@/lib/assignments/service";
import { contentDigest } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";
import { notifyNodeQuestionChanged } from "@/lib/runs/peek-wake";
import { appendManagerRunStreamEvent } from "@/lib/runs/run-stream-event";
import { runEventWakeBus } from "@/lib/execution-host/events/run-wake";

const log = pino({
  name: "flow-node-answer",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Check live account and role under the same transaction as the disclosure or mutation. */
async function authorizeResponder(
  tx: Db,
  projectId: string,
  userId: string,
): Promise<void> {
  const [user] = await tx
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .for("share");

  if (!user || user.accountStatus !== "active" || user.mustChangePassword)
    throw new MaisterError(
      "UNAUTHORIZED",
      "Question responder is no longer active",
    );
  if (user.role === "admin") return;
  const [member] = await tx
    .select()
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, userId),
      ),
    )
    .for("share");

  if (!member || member.role === "viewer")
    throw new MaisterError(
      "UNAUTHORIZED",
      "Current project membership cannot answer this question",
    );
}

async function assertLatestAttempt(
  tx: Db,
  attempt: NodeAttempt,
): Promise<void> {
  const [current] = await tx
    .select({ id: nodeAttempts.id })
    .from(nodeAttempts)
    .where(and(eq(nodeAttempts.id, attempt.id), latestFlowQuestionAttempt()))
    .limit(1);

  if (!current)
    throw new MaisterError(
      "CONFLICT",
      "Question belongs to a replaced attempt",
      { details: { reason: "node_question_closed" } },
    );
}
function assertQuestionOwner(
  attempt: NodeAttempt,
  question: HitlRequest,
): void {
  const resume = attempt.actionResume;
  const envelope = nodeQuestionEnvelope.parse(question.schema);

  if (
    resume?.kind !== "node_question" ||
    resume.questionId !== question.id ||
    attempt.runId !== question.runId ||
    attempt.id !== question.flowNodeAttemptId ||
    attempt.nodeId !== question.stepId ||
    resume.promptOrdinal !== attempt.actionPromptOrdinal ||
    resume.promptOrdinal !== envelope.flowQuestion.promptOrdinal + 1 ||
    resume.sourceAssignmentId !== envelope.flowQuestion.assignmentId ||
    resume.sourceIncarnationId !== envelope.flowQuestion.incarnationId ||
    resume.sourceCommandId !== envelope.flowQuestion.commandId ||
    resume.checkpointCommandId !== envelope.checkpointCommandId
  )
    throw new MaisterError(
      "CONFLICT",
      "Question no longer owns the original checkpointed attempt",
    );
}

/** The shared Inbox/Run route claims one answer and enqueues its original attempt in the same transaction. */
export async function answerFlowNodeQuestion(
  db: Db,
  runId: string,
  questionId: string,
  userId: string,
  answer: unknown,
  audit?: (tx: Db, status: number) => Promise<void>,
) {
  const result = await db.transaction(async (tx) => {
    const [run] = await tx
      .select()
      .from(runs)
      .where(eq(runs.id, runId))
      .for("no key update");

    if (!run?.projectId)
      throw new MaisterError("PRECONDITION", "Question project is unavailable");
    await authorizeResponder(tx, run.projectId, userId);
    const [selector] = await tx
      .select()
      .from(hitlRequests)
      .where(
        and(eq(hitlRequests.id, questionId), eq(hitlRequests.runId, runId)),
      );

    if (!selector?.flowNodeAttemptId)
      throw new MaisterError("PRECONDITION", "Flow question not found");
    const [attempt] = await tx
      .select()
      .from(nodeAttempts)
      .where(eq(nodeAttempts.id, selector.flowNodeAttemptId))
      .for("update");
    const [question] = await tx
      .select()
      .from(hitlRequests)
      .where(eq(hitlRequests.id, questionId))
      .for("update");

    if (!attempt || !question)
      throw new MaisterError("CONFLICT", "Flow question owner disappeared");
    await assertLatestAttempt(tx, attempt);
    assertAgentQuestionResponse(answer, question.schema);
    if (Buffer.byteLength(JSON.stringify(answer), "utf8") > 32768)
      throw new MaisterError("NEEDS_INPUT", "Answer exceeds the 32 KiB limit");
    if (
      question.supersededAt ||
      (!question.respondedAt &&
        !["Running", "NeedsInputIdle", "NeedsInput"].includes(run.status))
    )
      throw new MaisterError("CONFLICT", "The question has closed", {
        details: { reason: "node_question_closed" },
      });
    if (question.flowAnswerAcceptedAt) {
      if (
        question.flowAnswerUserId !== userId ||
        contentDigest(question.response) !== contentDigest(answer)
      )
        throw new MaisterError(
          "CONFLICT",
          "This question already has a different answer",
        );
      const status = question.respondedAt ? 200 : 202;

      await audit?.(tx, status);

      return { receipt: nodeQuestionReceipt(question), status };
    }
    assertQuestionOwner(attempt, question);
    if (
      attempt.status !== "NeedsInput" ||
      question.activationState !== "active"
    )
      throw new MaisterError(
        "CONFLICT",
        "The attempt is not waiting for this answer",
      );
    const actor = await ensureUserActor({
      db: tx,
      projectId: run.projectId,
      userId,
    });
    const [work] = await tx
      .select()
      .from(assignments)
      .where(eq(assignments.hitlRequestId, questionId))
      .for("update");

    if (
      !work ||
      !["open", "claimed"].includes(work.status) ||
      (work.assigneeActorId && work.assigneeActorId !== actor.id)
    )
      throw new MaisterError(
        "CONFLICT",
        "This question's human assignment is closed or claimed by another responder",
      );
    const [updated] = await tx
      .update(hitlRequests)
      .set({
        response: answer,
        flowAnswerUserId: userId,
        flowAnswerAcceptedAt: new Date(),
      })
      .where(eq(hitlRequests.id, questionId))
      .returning();

    await completeAssignment({
      db: tx,
      assignmentId: work.id,
      actorId: actor.id,
      eventKind: "responded",
    });
    if (run.status === "NeedsInputIdle" && run.resumeRequestedAt === null)
      await tx
        .update(runs)
        .set({ resumeRequestedAt: new Date(), currentStepId: attempt.nodeId })
        .where(eq(runs.id, run.id));
    await appendManagerRunStreamEvent(tx, {
      runId,
      sourceKey: `flow-node-question:${questionId}:accepted`,
      event: {
        type: "hitl.responded",
        data: {
          hitlRequestId: questionId,
          nodeId: attempt.nodeId,
          state: "accepted",
        },
      },
    });
    await notifyNodeQuestionChanged(tx, runId);
    log.info(
      {
        runId,
        questionId,
        nodeAttemptId: attempt.id,
        userId,
        state: "accepted",
      },
      "Human answer accepted for the original node",
    );
    await audit?.(tx, 202);

    return { receipt: nodeQuestionReceipt(updated), status: 202 };
  });

  runEventWakeBus.wake(runId);

  return result;
}

/** Capacity-checked idle claim rebinds exactly one answered node; the normal driver dispatches its next ordinal. */
export async function authorizeFlowNodeAnswerResume(
  tx: Db,
  assignment: ExecutionAssignment,
): Promise<void> {
  const [run] = await tx
    .select()
    .from(runs)
    .where(eq(runs.id, assignment.runId));

  if (!run?.projectId || run.runKind !== "flow" || !run.currentStepId) return;
  const [attempt] = await tx
    .select()
    .from(nodeAttempts)
    .where(
      and(
        eq(nodeAttempts.runId, run.id),
        eq(nodeAttempts.nodeId, run.currentStepId),
      ),
    )
    .orderBy(sql`${nodeAttempts.attempt} DESC`)
    .limit(1)
    .for("update");
  const resume = attempt?.actionResume;

  if (resume?.kind !== "node_question") {
    const [obsolete] = await tx
      .select({ id: hitlRequests.id })
      .from(hitlRequests)
      .where(
        and(
          eq(hitlRequests.runId, run.id),
          eq(hitlRequests.stepId, run.currentStepId),
          sql`${hitlRequests.flowNodeAttemptId} IS NOT NULL AND ${hitlRequests.respondedAt} IS NULL
        AND ${hitlRequests.supersededAt} IS NULL AND ${hitlRequests.activationState}='active'`,
        ),
      )
      .limit(1);

    if (obsolete)
      throw new MaisterError(
        "CONFLICT",
        "This question belongs to a replaced node",
        { details: { reason: "node_question_closed" } },
      );

    return;
  }
  const [question] = await tx
    .select()
    .from(hitlRequests)
    .where(eq(hitlRequests.id, resume.questionId))
    .for("update");

  if (
    !question ||
    !question.flowAnswerUserId ||
    !question.flowAnswerAcceptedAt ||
    question.respondedAt ||
    question.supersededAt ||
    question.activationState !== "active" ||
    attempt.status !== "NeedsInput" ||
    assignment.id !== run.executionAssignmentId ||
    assignment.state !== "active"
  )
    throw new MaisterError(
      "CONFLICT",
      "The parked attempt requires its accepted answer before resumption",
    );
  await assertLatestAttempt(tx, attempt);
  assertQuestionOwner(attempt, question);
  await authorizeResponder(tx, run.projectId, question.flowAnswerUserId);
  const proof =
    await tx.execute(sql`SELECT checkpoint.id FROM execution_commands checkpoint
      JOIN execution_assignments prior ON prior.id=checkpoint.execution_assignment_id AND prior.run_id=checkpoint.run_id
      JOIN run_session_incarnations inc ON inc.id=${resume.sourceIncarnationId} AND inc.run_id=prior.run_id AND inc.execution_assignment_id=prior.id
      AND inc.host_session_id=checkpoint.target_session_id AND inc.acp_session_id=${resume.resumeSessionId} AND inc.state IN ('checkpointed','exited')
      WHERE checkpoint.id=${resume.checkpointCommandId} AND checkpoint.kind='session.checkpoint' AND checkpoint.state='succeeded'
        AND prior.id=${resume.sourceAssignmentId} AND prior.run_id=${run.id} AND prior.execution_host_id=${assignment.executionHostId}
        AND prior.state='released' AND prior.released_reason='checkpointed' AND prior.epoch<${assignment.epoch} AND prior.epoch=checkpoint.assignment_epoch`);

  if (!proof.rows.length)
    throw new MaisterError(
      "CONFLICT",
      "The host has no matching prior checkpoint",
    );
  await tx
    .update(nodeAttempts)
    .set({
      executionAssignmentId: assignment.id,
      actionResume: { ...resume, assignmentId: assignment.id },
    })
    .where(eq(nodeAttempts.id, attempt.id));
}

export async function currentFlowNodeAnswer(
  tx: Db,
  runId: string,
  attemptId: string,
): Promise<{ question: HitlRequest; attempt: NodeAttempt } | null> {
  const [attempt] = await tx
    .select()
    .from(nodeAttempts)
    .where(and(eq(nodeAttempts.id, attemptId), eq(nodeAttempts.runId, runId)));

  if (attempt?.actionResume?.kind !== "node_question") return null;
  const [run] = await tx.select().from(runs).where(eq(runs.id, runId));
  const [question] = await tx
    .select()
    .from(hitlRequests)
    .where(eq(hitlRequests.id, attempt.actionResume.questionId));

  if (
    !run?.projectId ||
    !["Running", "NeedsInput"].includes(run.status) ||
    attempt.executionAssignmentId !== run.executionAssignmentId ||
    !question?.flowAnswerUserId ||
    !question.flowAnswerAcceptedAt ||
    question.activationState !== "active" ||
    question.supersededAt
  )
    throw new MaisterError(
      "CONFLICT",
      "Answer delivery no longer owns the live execution",
    );
  await assertLatestAttempt(tx, attempt);
  assertQuestionOwner(attempt, question);
  await authorizeResponder(tx, run.projectId, question.flowAnswerUserId);

  return { question, attempt };
}

/** An accepted successor prompt is the delivery receipt even when the HTTP or host acknowledgement was lost. */
export async function observeFlowNodeAnswerDelivery(
  db: Db,
  commandId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const updated =
      await tx.execute(sql`UPDATE hitl_requests q SET responded_at=clock_timestamp() FROM execution_commands c, node_attempts n
    WHERE c.id=${commandId} AND c.kind='session.prompt' AND c.owner_kind='flow_node_attempt' AND c.owner_ref->>'variant'='node'
    AND c.state IN ('accepted','succeeded') AND c.run_id=q.run_id AND n.run_id=c.run_id
    AND c.owner_ref->>'nodeAttemptId'=q.flow_node_attempt_id AND q.flow_node_attempt_id=n.id
    AND c.owner_ref->'promptOrdinal'=to_jsonb((q.schema->'flowQuestion'->>'promptOrdinal')::int+1)
    AND c.execution_assignment_id=n.execution_assignment_id AND n.action_resume->>'questionId'=q.id
    AND q.flow_answer_accepted_at IS NOT NULL AND q.superseded_at IS NULL AND q.responded_at IS NULL
    RETURNING q.id,q.run_id,q.step_id,q.flow_node_attempt_id,c.execution_host_id`);
    const delivery = updated.rows[0];

    if (!delivery) return;
    await appendManagerRunStreamEvent(tx, {
      runId: String(delivery.run_id),
      sourceKey: `flow-node-question:${delivery.id}:delivered`,
      event: {
        type: "hitl.responded",
        data: {
          hitlRequestId: delivery.id,
          nodeId: delivery.step_id,
          state: "delivered",
        },
      },
    });
    await notifyNodeQuestionChanged(tx, String(delivery.run_id));
    log.info(
      {
        questionId: delivery.id,
        runId: delivery.run_id,
        nodeAttemptId: delivery.flow_node_attempt_id,
        hostId: delivery.execution_host_id,
        commandId,
        state: "delivered",
      },
      "Host accepted the answered node prompt",
    );
  });
}
