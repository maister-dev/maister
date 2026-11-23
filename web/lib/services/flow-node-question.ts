import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHosts } from "@/lib/execution-host/client";
import type { HitlRequest } from "@/lib/db/schema";
import type { ScopedHumanAskBody } from "./agent-question-contract";

import { randomUUID } from "node:crypto";

import { and, eq, isNull, sql } from "drizzle-orm";
import pino from "pino";
import { z } from "zod";

import { flowQuestionTokenPrefix } from "@/lib/agents/tokens";
import { createHitlAssignmentForRun } from "@/lib/assignments/service";
import {
  executionCommands,
  hitlRequests,
  nodeAttempts,
  projectTokens,
  runs,
  runSessionIncarnations,
} from "@/lib/db/schema";
import { MaisterError, isMaisterError } from "@/lib/errors";
import { contentDigest } from "@/lib/evaluations/digest";
import {
  isAfterCheckpoint,
  isPermissionCheckpointInterruption,
  isPermissionResultCommand,
  permissionCheckpointOrder,
} from "@/lib/execution-host/permission-handoff-evidence";
import {
  captureFlowQuestionSource,
  latestFlowQuestionAttempt,
  recoverEligibleFlowQuestionHeads,
} from "@/lib/execution-host/flow-question-source";
import { nodePermissionSourceSchema } from "@/lib/execution-host/flow-permission-source";
import { releaseAssignmentForRun } from "@/lib/execution-host/assignments";
import {
  createHitlRequest,
  emitHitlDecisionOpened,
} from "@/lib/runs/hitl-create";
import { notifyNodeQuestionChanged } from "@/lib/runs/peek-wake";
import { appendManagerRunStreamEvent } from "@/lib/runs/run-stream-event";
import { runEventWakeBus } from "@/lib/execution-host/events/run-wake";

const log = pino({
  name: "flow-node-question",
  level: process.env.LOG_LEVEL ?? "info",
});

export const nodeQuestionEnvelope = z.object({
  flowQuestion: nodePermissionSourceSchema,
  supervisorSessionId: z.string().min(1),
  tokenId: z.string().min(1),
  requestingAgent: z.string().min(1),
  requestDigest: z.string().length(64),
  checkpointCommandId: z.string().optional(),
});

type Receipt = {
  questionId: string;
  state:
    | "checkpoint_pending"
    | "open"
    | "accepted"
    | "delivered"
    | "closed"
    | "failed";
};

export function nodeQuestionReceipt(question: HitlRequest): Receipt {
  const state = question.supersededAt
    ? "closed"
    : question.activationState === "failed"
      ? "failed"
      : question.respondedAt
        ? "delivered"
        : question.flowAnswerAcceptedAt
          ? "accepted"
          : question.activationState === "active"
            ? "open"
            : "checkpoint_pending";

  return { questionId: question.id, state };
}

/** The facade supplies its authenticated token ID. No owner or recipient can be chosen in the body. */
export async function requestFlowNodeQuestion(
  db: Db,
  tokenId: string,
  body: ScopedHumanAskBody,
): Promise<Receipt> {
  const digest = contentDigest(body);
  const result = await db.transaction(async (tx) => {
    const [selector] = await tx
      .select({ runId: projectTokens.bound_run_id })
      .from(projectTokens)
      .where(eq(projectTokens.id, tokenId));

    if (!selector?.runId)
      throw new MaisterError(
        "UNAUTHORIZED",
        "A bound Flow agent token is required",
      );
    const [run] = await tx
      .select()
      .from(runs)
      .where(eq(runs.id, selector.runId))
      .for("no key update");
    const [token] = await tx
      .select()
      .from(projectTokens)
      .where(eq(projectTokens.id, tokenId))
      .for("share");

    if (
      !token ||
      token.revoked_at ||
      !token.expires_at ||
      token.expires_at <= new Date() ||
      token.token_kind !== "project" ||
      token.origin_kind !== "orchestrator_run" ||
      !token.knowledge_node_attempt_id ||
      token.bound_run_id !== run?.id ||
      !run.projectId ||
      token.project_id !== run.projectId ||
      run.runKind !== "flow" ||
      run.companyId ||
      !token.scopes.includes("hitl:request") ||
      token.scopes.some(
        (scope) =>
          !["hitl:request", "agent_memory:read", "agent_memory:write"].includes(
            scope,
          ),
      )
    )
      throw new MaisterError(
        "UNAUTHORIZED",
        "The Flow question requires its exact current attempt credential",
      );
    const [attempt] = await tx
      .select()
      .from(nodeAttempts)
      .where(
        and(
          eq(nodeAttempts.id, token.knowledge_node_attempt_id),
          eq(nodeAttempts.runId, run.id),
          latestFlowQuestionAttempt(),
        ),
      )
      .for("update");

    if (
      !attempt ||
      attempt.nodeType !== "ai_coding" ||
      !["Running", "NeedsInput"].includes(attempt.status) ||
      run.status !== "Running"
    )
      throw new MaisterError(
        "CONFLICT",
        "The requesting node no longer owns a live turn",
      );
    const prefix = flowQuestionTokenPrefix(
      run.id,
      attempt.executionAssignmentId ?? "",
      attempt.actionPromptOrdinal,
    );

    if (!token.name.startsWith(prefix) || token.name === prefix)
      throw new MaisterError(
        "UNAUTHORIZED",
        "Question credential is no longer current for this turn",
      );
    const [prior] = await tx
      .select()
      .from(hitlRequests)
      .where(
        and(
          eq(hitlRequests.flowNodeAttemptId, attempt.id),
          sql`${hitlRequests.schema}->>'tokenId'=${token.id} AND ${hitlRequests.schema}->'flowQuestion'->>'promptOrdinal'=${String(attempt.actionPromptOrdinal)}`,
        ),
      );

    if (prior) {
      if (
        prior.flowRequestKey !== body.requestKey ||
        nodeQuestionEnvelope.parse(prior.schema).requestDigest !== digest
      )
        throw new MaisterError(
          "CONFLICT",
          "This node turn already has a different question",
        );

      return nodeQuestionReceipt(prior);
    }
    const source = await captureFlowQuestionSource(tx, run.id, attempt.id);
    const questionId = randomUUID();

    await createHitlRequest(
      tx,
      {
        id: questionId,
        runId: run.id,
        stepId: attempt.nodeId,
        kind: "agent_question",
        prompt: body.question,
        schema: {
          ...body.schema,
          ...source,
          requestingAgent: token.name.slice(prefix.length),
          tokenId,
          requestDigest: digest,
        },
        activationState: "pending_termination",
        flowRequestKey: body.requestKey,
        flowNodeAttemptId: attempt.id,
      },
      { silent: true },
    );
    await tx
      .update(nodeAttempts)
      .set({ status: "NeedsInput" })
      .where(eq(nodeAttempts.id, attempt.id));

    return { questionId, state: "checkpoint_pending" as const };
  });

  log.info(
    { questionId: result.questionId, state: result.state },
    "node question persisted",
  );

  return result;
}

/** Restore the source owner only with its Run, attempt and pending question already locked and verified. */
async function failPendingFlowQuestion(
  tx: Db,
  questionId: string,
  attemptId: string,
): Promise<void> {
  await tx
    .update(hitlRequests)
    .set({ activationState: "failed" })
    .where(eq(hitlRequests.id, questionId));
  await tx
    .update(nodeAttempts)
    .set({ status: "Running" })
    .where(eq(nodeAttempts.id, attemptId));
}

/** Claim/checkpoint that exact session. Exposure requires both a successful checkpoint and the closed incarnation. */
export async function reconcileFlowNodeQuestion(
  db: Db,
  hosts: ExecutionHosts,
  questionId: string,
): Promise<boolean> {
  const [selector] = await db
    .select()
    .from(hitlRequests)
    .where(eq(hitlRequests.id, questionId));

  if (
    !selector?.flowNodeAttemptId ||
    selector.activationState !== "pending_termination"
  )
    return false;
  const capture = nodeQuestionEnvelope.parse(selector.schema);
  const proof = capture.flowQuestion;
  const client = await hosts.forAssignment({ id: proof.assignmentId });
  const prepared = await db.transaction(async (tx) => {
    const [run] = await tx
      .select()
      .from(runs)
      .where(eq(runs.id, selector.runId))
      .for("no key update");
    const [attempt] = await tx
      .select()
      .from(nodeAttempts)
      .where(
        and(
          eq(nodeAttempts.id, proof.nodeAttemptId),
          latestFlowQuestionAttempt(),
          isNull(nodeAttempts.endedAt),
        ),
      )
      .for("update");
    const [row] = await tx
      .select()
      .from(hitlRequests)
      .where(eq(hitlRequests.id, questionId))
      .for("update");

    if (row?.activationState !== "pending_termination" || row.supersededAt)
      return null;
    if (
      !run ||
      !["Running", "NeedsInput"].includes(run.status) ||
      run.executionAssignmentId !== proof.assignmentId ||
      !attempt ||
      attempt.status !== "NeedsInput" ||
      attempt.actionPromptOrdinal !== proof.promptOrdinal ||
      attempt.runId !== run.id ||
      attempt.executionAssignmentId !== proof.assignmentId
    ) {
      log.warn(
        {
          questionId,
          runId: selector.runId,
          nodeAttemptId: proof.nodeAttemptId,
          assignmentId: proof.assignmentId,
        },
        "Flow question source was replaced or closed before checkpoint",
      );
      await tx
        .update(hitlRequests)
        .set({ activationState: "failed" })
        .where(eq(hitlRequests.id, questionId));

      return null;
    }
    const envelope = nodeQuestionEnvelope.parse(row.schema);
    const op = await client
      .prepareQuestionCheckpoint(
        tx,
        envelope.supervisorSessionId,
        envelope.checkpointCommandId ?? null,
      )
      .catch(async (error: unknown) => {
        if (
          !isMaisterError(error) ||
          error.details?.reason !== "question_checkpoint_failed"
        )
          throw error;
        // The source owner can now apply its own terminal result or continue its still-live turn.
        await failPendingFlowQuestion(tx, questionId, attempt.id);
        log.error(
          {
            questionId,
            nodeAttemptId: attempt.id,
            checkpointCommandId: envelope.checkpointCommandId,
          },
          "Flow node checkpoint rejected",
        );

        return null;
      });

    if (!op) return null;

    if (!envelope.checkpointCommandId)
      await tx
        .update(hitlRequests)
        .set({
          schema: {
            ...(row.schema as object),
            checkpointCommandId: op.commandId,
          },
        })
        .where(eq(hitlRequests.id, row.id));

    return op;
  });

  if (!prepared) return false;
  await prepared.deliver();
  const active = await db.transaction(async (tx) => {
    const [run] = await tx
      .select()
      .from(runs)
      .where(eq(runs.id, selector.runId))
      .for("no key update");
    const [attempt] = await tx
      .select()
      .from(nodeAttempts)
      .where(
        and(
          eq(nodeAttempts.id, proof.nodeAttemptId),
          latestFlowQuestionAttempt(),
          isNull(nodeAttempts.endedAt),
        ),
      )
      .for("update");
    const [question] = await tx
      .select()
      .from(hitlRequests)
      .where(eq(hitlRequests.id, questionId))
      .for("update");

    if (
      !run ||
      !["Running", "NeedsInput"].includes(run.status) ||
      run.executionAssignmentId !== proof.assignmentId ||
      attempt?.status !== "NeedsInput" ||
      attempt.actionPromptOrdinal !== proof.promptOrdinal ||
      attempt.executionAssignmentId !== proof.assignmentId ||
      question?.activationState !== "pending_termination" ||
      question.supersededAt
    )
      return false;
    const [inc] = await tx
      .select()
      .from(runSessionIncarnations)
      .where(eq(runSessionIncarnations.id, proof.incarnationId));
    const [op] = await tx
      .select()
      .from(executionCommands)
      .where(eq(executionCommands.id, prepared.commandId));

    if (
      !inc?.acpSessionId ||
      !["checkpointed", "exited"].includes(inc.state) ||
      inc.runId !== run.id ||
      inc.hostSessionId !== capture.supervisorSessionId ||
      inc.executionAssignmentId !== proof.assignmentId ||
      op?.state !== "succeeded" ||
      op.targetSessionId !== inc.hostSessionId ||
      op.assignmentEpoch !== inc.assignmentEpoch
    )
      return false;
    const [source] = await tx
      .select()
      .from(executionCommands)
      .where(eq(executionCommands.id, proof.commandId));

    if (
      !source ||
      !isPermissionResultCommand(source) ||
      !source.terminalEventId
    )
      return false;
    const order =
      source.state === "failed"
        ? await permissionCheckpointOrder(tx, source, op)
        : null;

    if (order === "unproven") return false;
    if (
      order &&
      (!isAfterCheckpoint(order) || !isPermissionCheckpointInterruption(source))
    ) {
      await failPendingFlowQuestion(tx, questionId, attempt.id);

      return false;
    }
    if (proof.promptOrdinal >= 2147483647)
      throw new MaisterError("CONFLICT", "Flow node prompt ordinal exhausted");
    await tx
      .update(nodeAttempts)
      .set({
        actionCompletion: null,
        actionPromptOrdinal: proof.promptOrdinal + 1,
        actionResume: {
          version: 1,
          kind: "node_question",
          questionId,
          checkpointCommandId: op.id,
          sourceCommandId: proof.commandId,
          sourceAssignmentId: proof.assignmentId,
          assignmentId: proof.assignmentId,
          sourceIncarnationId: inc.id,
          promptOrdinal: proof.promptOrdinal + 1,
          resumeSessionId: inc.acpSessionId,
        },
      })
      .where(eq(nodeAttempts.id, attempt.id));
    await tx
      .update(projectTokens)
      .set({ revoked_at: new Date(), revocation_reason: "revoked" })
      .where(
        and(
          eq(projectTokens.id, capture.tokenId),
          eq(projectTokens.knowledge_node_attempt_id, attempt.id),
          isNull(projectTokens.revoked_at),
        ),
      );
    await tx
      .update(hitlRequests)
      .set({ activationState: "active" })
      .where(eq(hitlRequests.id, questionId));
    await createHitlAssignmentForRun({
      db: tx,
      runId: run.id,
      stepId: attempt.nodeId,
      hitlRequestId: questionId,
      actionKind: "agent_question",
      title: [capture.requestingAgent, attempt.nodeId, question.prompt].join(
        " · ",
      ),
      roleRefs: [],
    });
    await emitHitlDecisionOpened(tx, question);
    await appendManagerRunStreamEvent(tx, {
      runId: run.id,
      sourceKey: `flow-node-question:${questionId}:opened`,
      event: {
        type: "run.needs_input",
        data: { nodeId: attempt.nodeId, reason: "node_question", questionId },
      },
    });
    await notifyNodeQuestionChanged(tx, run.id);
    await settleFlowNodeQuestionWait(tx, run.id, proof.assignmentId);

    return true;
  });

  if (active) {
    log.info(
      {
        questionId,
        runId: selector.runId,
        nodeAttemptId: proof.nodeAttemptId,
        checkpointCommandId: prepared.commandId,
      },
      "Flow node checkpoint verified and assignment opened",
    );
    runEventWakeBus.wake(selector.runId);
  }

  return active;
}

/** Host ingestion and command projection may finish after the checkpoint HTTP response.
 * Subscribe before reading the ledger so a local wake cannot race that read. The durable sweep
 * resumes a question after process loss or when cross-process projection exceeds this live window.
 */
export async function activateFlowNodeQuestionOnHostEvents(
  db: Db,
  hosts: ExecutionHosts,
  questionId: string,
): Promise<void> {
  const [source] = await db
    .select({ runId: hitlRequests.runId })
    .from(hitlRequests)
    .where(eq(hitlRequests.id, questionId));

  if (!source) return;
  const window = 8_000;
  const deadline = Date.now() + window;
  const stop = new AbortController();

  try {
    for (;;) {
      const remaining = deadline - Date.now();
      const wake =
        remaining > 0
          ? runEventWakeBus.wait(source.runId, remaining, stop.signal)
          : null;

      if (await reconcileFlowNodeQuestion(db, hosts, questionId)) return;
      if (!wake) return;
      const [current] = await db
        .select({ state: hitlRequests.activationState })
        .from(hitlRequests)
        .where(eq(hitlRequests.id, questionId));

      if (current?.state !== "pending_termination") return;
      await wake;
    }
  } finally {
    stop.abort();
  }
}

/** Each invocation owns a bounded fair page; unknown host outcomes keep their original command identity. */
export async function recoverFlowNodeQuestions(
  db: Db,
  hosts: ExecutionHosts,
): Promise<number> {
  await recoverEligibleFlowQuestionHeads(db);
  const candidates = await db.execute(sql`WITH pending AS (
    SELECT id FROM hitl_requests WHERE flow_node_attempt_id IS NOT NULL AND activation_state='pending_termination' AND superseded_at IS NULL
    AND (flow_reconciled_at IS NULL OR flow_reconciled_at<clock_timestamp()-interval '10 seconds')
    ORDER BY flow_reconciled_at NULLS FIRST,created_at,id LIMIT 30 FOR UPDATE SKIP LOCKED
  ) UPDATE hitl_requests q SET flow_reconciled_at=clock_timestamp() FROM pending WHERE q.id=pending.id RETURNING q.id`);
  let count = 0;

  for (const row of candidates.rows) {
    const questionId = String(row.id);

    try {
      if (await reconcileFlowNodeQuestion(db, hosts, questionId)) count++;
    } catch (error) {
      log.warn(
        { questionId, code: isMaisterError(error) ? error.code : "INTERNAL" },
        "Flow question checkpoint reconciliation did not complete",
      );
    }
  }

  return count;
}

/** Release a quiescent graph with human waits. Queue the oldest accepted answer against its original node. */
export async function settleFlowNodeQuestionWait(
  tx: Db,
  runId: string,
  currentAssignmentId: string,
): Promise<boolean> {
  const [run] = await tx
    .select({ status: runs.status, assignment: runs.executionAssignmentId })
    .from(runs)
    .where(eq(runs.id, runId))
    .for("no key update");

  if (
    !run ||
    run.assignment !== currentAssignmentId ||
    !["Running", "NeedsInput"].includes(run.status)
  )
    return false;
  const eligible =
    await tx.execute(sql`SELECT q.step_id,q.flow_answer_accepted_at FROM hitl_requests q
    JOIN node_attempts n ON n.id=q.flow_node_attempt_id AND n.run_id=q.run_id
    WHERE q.run_id=${runId} AND q.activation_state='active' AND q.responded_at IS NULL AND q.superseded_at IS NULL
      AND n.status='NeedsInput' AND n.action_resume->>'questionId'=q.id
      AND NOT EXISTS (SELECT 1 FROM node_attempts newer WHERE newer.run_id=n.run_id AND newer.node_id=n.node_id AND newer.attempt>n.attempt)
      AND NOT EXISTS (SELECT 1 FROM node_attempts live WHERE live.run_id=q.run_id AND (live.status IN ('Running','Pending') OR
        (live.status='NeedsInput' AND EXISTS (SELECT 1 FROM hitl_requests pending WHERE pending.flow_node_attempt_id=live.id AND pending.activation_state='pending_termination' AND pending.superseded_at IS NULL))))
      AND NOT EXISTS (SELECT 1 FROM run_session_incarnations i WHERE i.run_id=q.run_id AND i.execution_assignment_id=${currentAssignmentId} AND i.state IN ('created','active'))
    ORDER BY q.flow_answer_accepted_at NULLS LAST,q.created_at,q.id LIMIT 1`);
  const next = eligible.rows[0];

  if (!next || typeof next.step_id !== "string") return false;
  await tx
    .update(runs)
    .set({
      status: "NeedsInputIdle",
      currentStepId: next.step_id,
      checkpointAt: new Date(),
      keepaliveUntil: null,
      resumeRequestedAt: next.flow_answer_accepted_at ? new Date() : null,
    })
    .where(eq(runs.id, runId));
  await releaseAssignmentForRun(tx, runId, "checkpointed");

  return true;
}
