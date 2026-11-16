import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionAssignment, HitlRequest } from "@/lib/db/schema";
import type { FlowQuestionSource } from "@/lib/execution-host/flow-question-source";
import type { FlowClarificationResume } from "@/lib/flows/graph/action-resume";

import { and, desc, eq, sql } from "drizzle-orm";

import { assignmentQuestionAnswerSchema } from "./question-types";
import { readAuthorizedAssignmentInput } from "./context";

import { markNodeNeedsInput } from "@/lib/flows/graph/ledger";
import {
  executionAssignments,
  executionCommands,
  hitlRequests,
  nodeAttempts,
  runSessionIncarnations,
  runs,
} from "@/lib/db/schema";
import { nodePermissionSourceSchema } from "@/lib/execution-host/flow-permission-source";
import {
  isPermissionResultCommand,
  isPermissionCheckpointInterruption,
  permissionCheckpointOrder,
} from "@/lib/execution-host/permission-handoff-evidence";
import { resolveKnowledgeRunIdentity } from "@/lib/brain/knowledge-run-identity";
import {
  lockKnowledgeReadConsumer,
  recordKnowledgeDisclosure,
} from "@/lib/brain/knowledge-disclosure";
import {
  restrictionsForKnowledgeAccess,
  authorizeSourceRestrictions,
} from "@/lib/brain/knowledge-restrictions";
import { contentDigest } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";

/** Record the pause before checkpointing, retaining the original ordinal until its canonical lifecycle is confirmed. */
export async function pauseAssignmentQuestionNode(
  tx: Db,
  source: FlowQuestionSource,
): Promise<void> {
  if (
    !(await markNodeNeedsInput(source.flowQuestion.nodeAttemptId, tx, {
      requireRunning: true,
    }))
  )
    throw new MaisterError(
      "CONFLICT",
      "The node completed before its clarification pause could be recorded",
    );
}

/** Advance only after the original prompt's checkpoint and quiescence, so late source lifecycle evidence keeps its owner. */
export async function parkAssignmentQuestionNode(
  tx: Db,
  questionId: string,
  source: FlowQuestionSource,
): Promise<void> {
  const proof = source.flowQuestion;
  const [incarnation] = await tx
    .select()
    .from(runSessionIncarnations)
    .where(eq(runSessionIncarnations.id, proof.incarnationId));

  if (
    !incarnation?.acpSessionId ||
    incarnation.hostSessionId !== source.supervisorSessionId
  )
    throw new MaisterError(
      "CONFLICT",
      "Flow clarification lost its exact logical session witness",
    );
  const [attempt] = await tx
    .select()
    .from(nodeAttempts)
    .where(eq(nodeAttempts.id, proof.nodeAttemptId))
    .for("update");

  if (
    attempt?.actionResume?.kind === "clarification" &&
    attempt.actionResume.questionId === questionId &&
    attempt.actionPromptOrdinal === proof.promptOrdinal + 1
  )
    return;
  if (
    !attempt ||
    attempt.status !== "NeedsInput" ||
    attempt.actionPromptOrdinal !== proof.promptOrdinal ||
    attempt.executionAssignmentId !== proof.assignmentId
  )
    throw new MaisterError(
      "CONFLICT",
      "The checkpointed node no longer matches its original clarification prompt",
    );
  if (proof.promptOrdinal === 2147483647)
    throw new MaisterError("CONFLICT", "The node prompt ordinal is exhausted");
  const resume: FlowClarificationResume = {
    version: 1,
    kind: "clarification",
    questionId,
    sourceCommandId: proof.commandId,
    sourceAssignmentId: proof.assignmentId,
    assignmentId: proof.assignmentId,
    sourceIncarnationId: proof.incarnationId,
    promptOrdinal: proof.promptOrdinal + 1,
    resumeSessionId: incarnation.acpSessionId,
    answer: null,
  };

  await tx
    .update(nodeAttempts)
    .set({
      actionPromptOrdinal: resume.promptOrdinal,
      actionCompletion: null,
      actionResume: resume,
    })
    .where(eq(nodeAttempts.id, proof.nodeAttemptId));
}

/** Human answer acceptance requires the exact parked node and acknowledged checkpoint, before any successor is claimed. */
export async function assertParkedAssignmentQuestionNode(
  tx: Db,
  question: HitlRequest,
): Promise<void> {
  const envelope = question.schema as Readonly<{
    flowQuestion?: unknown;
  }> | null;
  const proof = nodePermissionSourceSchema.safeParse(envelope?.flowQuestion);

  if (!proof.success)
    throw new MaisterError(
      "CONFIG",
      "The retained Flow clarification source is invalid",
    );
  const [attempt] = await tx
    .select()
    .from(nodeAttempts)
    .where(eq(nodeAttempts.id, proof.data.nodeAttemptId))
    .for("update");
  const resume = attempt?.actionResume;
  const witnessed = await tx.execute(sql`
    SELECT checkpoint.id FROM execution_commands checkpoint
    JOIN execution_assignments fence ON fence.id=checkpoint.execution_assignment_id
    JOIN run_session_incarnations incarnation ON incarnation.id=${proof.data.incarnationId}
      AND incarnation.run_id=${question.runId} AND incarnation.execution_assignment_id=fence.id
      AND incarnation.host_session_id=checkpoint.target_session_id
      AND incarnation.state IN ('checkpointed','exited')
    JOIN runs execution ON execution.id=fence.run_id AND execution.current_step_id=${question.stepId}
      AND execution.execution_assignment_id=fence.id AND execution.status='NeedsInputIdle'
    WHERE checkpoint.run_id=${question.runId} AND checkpoint.kind='session.checkpoint' AND checkpoint.state='succeeded'
      AND checkpoint.execution_assignment_id=${proof.data.assignmentId} AND checkpoint.assignment_epoch=fence.epoch
      AND fence.state='released' AND fence.released_reason='checkpointed'
  `);

  if (
    !attempt ||
    attempt.runId !== question.runId ||
    attempt.nodeId !== question.stepId ||
    attempt.status !== "NeedsInput" ||
    resume?.kind !== "clarification" ||
    resume.questionId !== question.id ||
    resume.sourceCommandId !== proof.data.commandId ||
    resume.sourceAssignmentId !== proof.data.assignmentId ||
    resume.sourceIncarnationId !== proof.data.incarnationId ||
    attempt.actionPromptOrdinal !== proof.data.promptOrdinal + 1 ||
    resume.answer !== null ||
    witnessed.rows.length !== 1
  )
    throw new MaisterError(
      "CONFLICT",
      "The Flow clarification no longer owns its exact parked node and checkpoint",
    );
  await resolveKnowledgeRunIdentity(tx, question.runId, attempt.id);
}

/** The normal Flow idle claim is the only writer that binds an answered clarification to a successor execution epoch. */
export async function authorizeAssignmentQuestionNodeResume(
  tx: Db,
  assignment: ExecutionAssignment,
): Promise<void> {
  const [run] = await tx
    .select()
    .from(runs)
    .where(eq(runs.id, assignment.runId));

  if (run?.runKind !== "flow" || !run.currentStepId) return;
  const [attempt] = await tx
    .select()
    .from(nodeAttempts)
    .where(
      and(
        eq(nodeAttempts.runId, run.id),
        eq(nodeAttempts.nodeId, run.currentStepId),
      ),
    )
    .orderBy(desc(nodeAttempts.attempt))
    .limit(1)
    .for("update");
  const resume = attempt?.actionResume;

  if (resume?.kind !== "clarification") return;
  const [question] = await tx
    .select()
    .from(hitlRequests)
    .where(eq(hitlRequests.id, resume.questionId))
    .for("update");
  const envelope = question?.schema as Readonly<{
    flowQuestion?: unknown;
  }> | null;
  const proof = nodePermissionSourceSchema.safeParse(envelope?.flowQuestion);
  const answer = assignmentQuestionAnswerSchema.safeParse(
    question?.specialistAnswer,
  );
  const [source] = await tx
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.id, resume.sourceCommandId));
  const [prior] = await tx
    .select()
    .from(executionAssignments)
    .where(eq(executionAssignments.id, resume.sourceAssignmentId));
  const [parked] = attempt?.executionAssignmentId
    ? await tx
        .select()
        .from(executionAssignments)
        .where(eq(executionAssignments.id, attempt.executionAssignmentId))
    : [];
  const [incarnation] = await tx
    .select()
    .from(runSessionIncarnations)
    .where(eq(runSessionIncarnations.id, resume.sourceIncarnationId));
  const checkpoint = (
    await tx
      .select()
      .from(executionCommands)
      .where(
        and(
          eq(executionCommands.runId, run.id),
          eq(executionCommands.kind, "session.checkpoint"),
          eq(
            executionCommands.executionAssignmentId,
            resume.sourceAssignmentId,
          ),
          eq(
            executionCommands.targetSessionId,
            incarnation?.hostSessionId ?? "",
          ),
          eq(executionCommands.state, "succeeded"),
        ),
      )
  )[0];

  if (
    !attempt ||
    attempt.status !== "NeedsInput" ||
    attempt.actionCompletion !== null ||
    !question ||
    question.kind !== "agent_question" ||
    question.runId !== run.id ||
    question.stepId !== attempt.nodeId ||
    question.activationState !== "active" ||
    question.respondedAt === null ||
    question.supersededAt !== null ||
    !proof.success ||
    !answer.success ||
    question.specialistAssignmentId !== answer.data.assignmentId ||
    question.specialistInputRevision !== answer.data.sourceInputRevision ||
    question.specialistAnswerInputRevision !==
      answer.data.answeredInputRevision ||
    proof.data.nodeAttemptId !== attempt.id ||
    proof.data.commandId !== resume.sourceCommandId ||
    proof.data.assignmentId !== resume.sourceAssignmentId ||
    proof.data.incarnationId !== resume.sourceIncarnationId ||
    proof.data.promptOrdinal + 1 !== resume.promptOrdinal ||
    !source ||
    source.runId !== run.id ||
    source.ownerKind !== "flow_node_attempt" ||
    !isPermissionResultCommand(source) ||
    !prior ||
    prior.runId !== run.id ||
    prior.state !== "released" ||
    prior.releasedReason !== "checkpointed" ||
    prior.executionHostId !== assignment.executionHostId ||
    prior.epoch >= assignment.epoch ||
    !parked ||
    parked.runId !== run.id ||
    parked.state !== "released" ||
    parked.executionHostId !== assignment.executionHostId ||
    parked.epoch >= assignment.epoch ||
    (parked.id !== prior.id && parked.releasedReason !== "resume_rollback") ||
    !checkpoint ||
    checkpoint.assignmentEpoch !== prior.epoch ||
    !incarnation ||
    incarnation.executionAssignmentId !== prior.id ||
    incarnation.executionHostId !== assignment.executionHostId ||
    incarnation.acpSessionId !== resume.resumeSessionId ||
    !["checkpointed", "exited"].includes(incarnation.state) ||
    source.targetSessionId !== incarnation.hostSessionId ||
    source.executionAssignmentId !== prior.id ||
    source.assignmentEpoch !== prior.epoch ||
    run.executionAssignmentId !== assignment.id ||
    assignment.state !== "active"
  )
    throw new MaisterError(
      "CONFLICT",
      "Flow clarification resume requires its exact answered input, owned prompt, checkpoint and successor epoch",
      { details: { reason: "assignment_flow_question_resume_unproven" } },
    );
  if (source.state === "failed") {
    const order = await permissionCheckpointOrder(tx, source, checkpoint);

    if (
      !isPermissionCheckpointInterruption(source) ||
      order === "unproven" ||
      order.order !== "after_checkpoint"
    )
      throw new MaisterError(
        "CONFLICT",
        "Reconcile the original node failure before resuming its clarification",
      );
  }
  await resolveKnowledgeRunIdentity(tx, run.id, attempt.id);
  const input = await readAuthorizedAssignmentInput(
    tx,
    { kind: "execution", runId: run.id, nodeAttemptId: attempt.id },
    answer.data.assignmentId,
    answer.data.answeredInputRevision,
  );

  if (input.digest !== answer.data.inputSha256)
    throw new MaisterError(
      "CONFLICT",
      "The answered Flow input differs from its retained receipt",
    );
  await tx
    .update(nodeAttempts)
    .set({
      executionAssignmentId: assignment.id,
      actionResume: {
        ...resume,
        assignmentId: assignment.id,
        answer: {
          inputRevision: input.revision,
          inputSha256: input.digest,
          receiptSha256: contentDigest(answer.data),
          checkpointCommandId: checkpoint.id,
        },
      },
    })
    .where(eq(nodeAttempts.id, attempt.id));
}

/** Newly assembled node prompts consume one exact answer; existing prompt reattachment keeps its original bytes. */
export async function appendAssignmentQuestionAnswerPrompt(
  db: Db,
  runId: string,
  nodeAttemptId: string,
  prompt: string,
): Promise<string> {
  return db.transaction(async (tx) => {
    const [selector] = await tx
      .select({ resume: nodeAttempts.actionResume })
      .from(nodeAttempts)
      .where(
        and(eq(nodeAttempts.id, nodeAttemptId), eq(nodeAttempts.runId, runId)),
      );

    if (selector?.resume?.kind !== "clarification") return prompt;
    const consumer = await lockKnowledgeReadConsumer(tx, {
      kind: "execution",
      runId,
      nodeAttemptId,
    });
    const [attempt] = await tx
      .select()
      .from(nodeAttempts)
      .where(
        and(eq(nodeAttempts.id, nodeAttemptId), eq(nodeAttempts.runId, runId)),
      );
    const resume = attempt?.actionResume;

    if (resume?.kind !== "clarification") return prompt;
    const [question] = await tx
      .select()
      .from(hitlRequests)
      .where(eq(hitlRequests.id, resume.questionId));
    const answer = assignmentQuestionAnswerSchema.safeParse(
      question?.specialistAnswer,
    );

    if (
      !resume.answer ||
      !answer.success ||
      question?.runId !== runId ||
      question.stepId !== attempt.nodeId ||
      question.respondedAt === null ||
      question.supersededAt !== null ||
      question.response === null ||
      resume.answer.inputRevision !== answer.data.answeredInputRevision ||
      resume.answer.inputSha256 !== answer.data.inputSha256 ||
      resume.answer.receiptSha256 !== contentDigest(answer.data)
    )
      throw new MaisterError(
        "CONFLICT",
        "The current node has no exact authorized clarification answer receipt",
      );
    await resolveKnowledgeRunIdentity(tx, runId, nodeAttemptId);
    const principal = { kind: "execution" as const, runId, nodeAttemptId };
    const input = await readAuthorizedAssignmentInput(
      tx,
      principal,
      answer.data.assignmentId,
      answer.data.answeredInputRevision,
    );
    const access = await authorizeSourceRestrictions(tx, principal, [
      ...input.snapshot.sourceRestrictions,
      {
        kind: "assignment_input",
        assignmentId: input.assignmentId,
        inputRevision: input.revision,
        inputSha256: input.digest,
      },
    ]);

    if (input.digest !== answer.data.inputSha256)
      throw new MaisterError(
        "CONFLICT",
        "The current clarification input witness changed",
      );
    await recordKnowledgeDisclosure(
      tx,
      consumer,
      restrictionsForKnowledgeAccess(access),
    );

    return `${prompt}\n\n[Assignment clarification — retained human input for this same node; this does not accept work, confer action authority or confirm Brain knowledge.]\n${JSON.stringify({ schemaVersion: 1, assignmentId: input.assignmentId, questionId: question.id, sourceInputRevision: answer.data.sourceInputRevision, inputRevision: input.revision, inputSha256: input.digest, question: question.prompt, response: question.response, actor: answer.data.actor })}`;
  });
}
