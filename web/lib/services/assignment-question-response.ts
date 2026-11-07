import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { AssignmentQuestionAnswer } from "@/lib/specialist-assignments/question-types";
import type { AssignmentInputSnapshot } from "@/lib/specialist-assignments/types";

import { and, eq, sql } from "drizzle-orm";
import pino from "pino";

import { assertAgentQuestionResponse } from "./agent-question-response";

import { assertParkedAssignmentQuestionNode } from "@/lib/specialist-assignments/flow-question";
import {
  isPlainObject,
  validateStructuredOutput,
} from "@/lib/flows/output-schema";
import { hitlRequests } from "@/lib/db/schema";
import {
  beginAssignmentTransaction,
  getSpecialistAssignmentInputInTransaction,
} from "@/lib/specialist-assignments/store";
import { authorizeAssignment } from "@/lib/specialist-assignments/access";
import {
  decodeAssignmentQuestionSubject,
  selectAssignmentQuestionRun,
} from "@/lib/specialist-assignments/question-authority";
import {
  assignmentQuestionAnswerSchema,
  assignmentQuestionResponseSchema,
} from "@/lib/specialist-assignments/question-types";
import { assignmentObjectiveInputSchema } from "@/lib/specialist-assignments/types";
import { retainAssignmentInput } from "@/lib/specialist-assignments/input-snapshot";
import { readSpecialistAssignmentContextInTransaction } from "@/lib/specialist-assignments/context";
import { knowledgeOwner } from "@/lib/brain/knowledge-access";
import {
  lockKnowledgeReadConsumer,
  recordKnowledgeDisclosure,
} from "@/lib/brain/knowledge-disclosure";
import {
  authorizeSourceRestrictions,
  restrictionsForKnowledgeAccess,
} from "@/lib/brain/knowledge-restrictions";
import { emitSpecialistAssignmentChange } from "@/lib/domain-events/outbox";
import {
  completeAssignment,
  ensureCompanyUserActor,
  ensureUserActor,
} from "@/lib/assignments/service";
import { contentDigest } from "@/lib/evaluations/digest";
import { MaisterError, isMaisterError } from "@/lib/errors";
import { redactQueryError, queryErrorDiagnostics } from "@/lib/db/pg-error";
import { runEventWakeBus } from "@/lib/execution-host/events/run-wake";

const log = pino({
  name: "assignment-question-response",
  level: process.env.LOG_LEVEL ?? "info",
});

export type AssignmentQuestionAnswerReceipt = Readonly<{
  assignmentId: string;
  questionId: string;
  runId: string;
  inputRevision: number;
  idempotent: boolean;
}>;

/** Commit the exact human answer, attributed input and existing resume intent atomically; delivery remains the continuation worker's job. */
export async function answerAssignmentQuestion(
  db: Db,
  userId: string,
  assignmentId: string,
  questionId: string,
  value: unknown,
  recordSuccessAudit?: (tx: Db, status: number) => Promise<void>,
): Promise<AssignmentQuestionAnswerReceipt> {
  const rawStructure = validateStructuredOutput(
    isPlainObject(value) ? value.response : undefined,
    { fields: [] },
  );

  if (!rawStructure.ok)
    throw new MaisterError("NEEDS_INPUT", rawStructure.message, {
      details: { reason: rawStructure.reason ?? "assignment_answer_invalid" },
    });
  const parsed = assignmentQuestionResponseSchema.safeParse(value);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Invalid exact-revision assignment clarification response",
    );
  const input = parsed.data;

  try {
    const result = await db.transaction(async (tx) => {
      await beginAssignmentTransaction(tx);
      const selector = (
        await tx
          .select()
          .from(hitlRequests)
          .where(
            and(
              eq(hitlRequests.id, questionId),
              eq(hitlRequests.specialistAssignmentId, assignmentId),
            ),
          )
      )[0];

      if (!selector)
        throw new MaisterError(
          "PRECONDITION",
          "Assignment clarification is unavailable",
        );
      const run = (
        await tx.execute(
          sql`SELECT status,run_kind,agent_kind FROM runs WHERE id=${selector.runId} FOR UPDATE`,
        )
      ).rows[0];

      if (
        !run ||
        ["Done", "Failed", "Crashed", "Abandoned"].includes(String(run.status))
      )
        throw new MaisterError(
          "CONFLICT",
          "The clarification execution is closed; continue or recover the assignment before requesting new input",
          { details: { reason: "assignment_question_closed" } },
        );
      const consumer = await lockKnowledgeReadConsumer(tx, {
        kind: "execution",
        runId: selector.runId,
        nodeAttemptId: null,
      });
      const head = (
        await tx.execute(
          sql`SELECT * FROM specialist_assignments WHERE id=${assignmentId} FOR UPDATE`,
        )
      ).rows[0];
      const question = (
        await tx
          .select()
          .from(hitlRequests)
          .where(eq(hitlRequests.id, questionId))
          .for("update")
      )[0];

      if (
        !head ||
        !question ||
        question.specialistAssignmentId !== assignmentId ||
        question.runId !== selector.runId ||
        question.taskId !== null ||
        question.kind !== "agent_question"
      )
        throw new MaisterError(
          "CONFLICT",
          "Clarification no longer matches this assignment and execution",
        );
      const subject = decodeAssignmentQuestionSubject(question.schema);
      const context = await readSpecialistAssignmentContextInTransaction(
        tx,
        { kind: "user", userId },
        assignmentId,
      );
      const authoritySnapshot = await authorizeAssignment(
        tx,
        userId,
        knowledgeOwner(head),
        "assignments:answer",
        context.input.snapshot.authoritySnapshot.executionPolicy,
      );
      const access = await authorizeSourceRestrictions(
        tx,
        { kind: "user", userId },
        subject.sourceRestrictions,
        context.access,
      );

      assertAgentQuestionResponse(input.response, question.schema);
      if (Buffer.byteLength(JSON.stringify(input), "utf8") > 32768)
        throw new MaisterError(
          "CONFIG",
          "Clarification response exceeds the 32 KiB request bound",
        );
      const requestDigest = contentDigest(input);
      const principalKey = contentDigest(authoritySnapshot.actor);
      const receipt = { assignmentId, questionId, runId: question.runId };

      if (question.respondedAt !== null) {
        const previous = assignmentQuestionAnswerSchema.safeParse(
          question.specialistAnswer,
        );

        if (
          !previous.success ||
          previous.data.principalKey !== principalKey ||
          previous.data.requestKey !== input.idempotencyKey ||
          previous.data.requestDigest !== requestDigest ||
          previous.data.responseSha256 !== contentDigest(input.response)
        )
          throw new MaisterError(
            "CONFLICT",
            "Assignment clarification already has a different answer or delivery identity",
          );
        if (["cancelled", "failed", "completed"].includes(String(head.status)))
          throw new MaisterError(
            "CONFLICT",
            "Terminal assignment cannot adopt an answer replay",
          );
        await recordSuccessAudit?.(tx, 200);

        return {
          ...receipt,
          inputRevision: previous.data.answeredInputRevision,
          idempotent: true,
        };
      }
      if (
        head.status !== "waiting_input" ||
        head.revision !== input.expectedRevision ||
        head.input_revision !== input.inputRevision ||
        subject.inputRevision !== input.inputRevision ||
        subject.assignmentId !== assignmentId ||
        question.specialistInputRevision !== input.inputRevision ||
        question.activationState !== "active" ||
        question.supersededAt !== null ||
        question.response !== null ||
        run?.status !== "NeedsInputIdle" ||
        !(
          run.run_kind === "flow" ||
          (run.run_kind === "agent" && run.agent_kind === "operational")
        ) ||
        (await selectAssignmentQuestionRun(tx, assignmentId)) !== question.runId
      )
        throw new MaisterError(
          "CONFLICT",
          "Clarification requires its active exact waiting assignment, input and checkpointed execution",
        );
      if (run.run_kind === "flow")
        await assertParkedAssignmentQuestionNode(tx, question);
      const original = await getSpecialistAssignmentInputInTransaction(
        tx,
        userId,
        assignmentId,
        input.inputRevision,
      );

      if (
        original.digest !== subject.inputSha256 ||
        input.inputRevision === 2147483647 ||
        input.expectedRevision === 2147483647
      )
        throw new MaisterError(
          "CONFLICT",
          "Clarification input witness is stale or its revision is exhausted",
        );
      const humanWork = (
        await tx.execute(
          sql`SELECT id,status,assignee_actor_id FROM assignments WHERE hitl_request_id=${questionId} FOR UPDATE`,
        )
      ).rows;

      if (humanWork.length !== 1 || typeof humanWork[0]?.id !== "string")
        throw new MaisterError(
          "CONFLICT",
          "Clarification requires its exact retained human work item",
        );
      const actor =
        head.company_id !== null
          ? await ensureCompanyUserActor({
              db: tx,
              companyId: String(head.company_id),
              userId,
            })
          : await ensureUserActor({
              db: tx,
              projectId: String(head.project_id),
              userId,
            });

      if (
        (humanWork[0].status === "claimed" &&
          humanWork[0].assignee_actor_id !== actor.id) ||
        humanWork[0].status === "cancelled" ||
        humanWork[0].status === "completed"
      )
        throw new MaisterError(
          "CONFLICT",
          "Clarification work is closed or claimed by another human",
        );
      const objective = assignmentObjectiveInputSchema.safeParse({
        ...original.snapshot.objectiveInput,
        input: [
          original.snapshot.objectiveInput.input,
          `Assignment clarification ${questionId}\nQuestion: ${question.prompt}\nHuman answer: ${JSON.stringify(input.response)}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      });

      if (!objective.success)
        throw new MaisterError(
          "PRECONDITION",
          "Combined clarification input exceeds its retained bounds; shorten the answer without discarding prior input",
        );
      const snapshot: AssignmentInputSnapshot = {
        ...original.snapshot,
        objectiveInput: objective.data,
        authoritySnapshot,
        sourceRestrictions: restrictionsForKnowledgeAccess(access),
      };
      const inputRevision = original.revision + 1;
      const answer: AssignmentQuestionAnswer = {
        schemaVersion: 1,
        assignmentId,
        questionId,
        sourceRunId: question.runId,
        sourceInputRevision: original.revision,
        answeredInputRevision: inputRevision,
        expectedRevision: input.expectedRevision,
        inputSha256: contentDigest(snapshot),
        responseSha256: contentDigest(input.response),
        principalKey,
        requestKey: input.idempotencyKey,
        requestDigest,
        actor: { kind: "user", id: userId, runId: null, attemptId: null },
        acceptedAt: new Date().toISOString(),
      };

      await retainAssignmentInput(tx, assignmentId, inputRevision, snapshot);
      await tx
        .update(hitlRequests)
        .set({
          response: input.response,
          respondedAt: new Date(answer.acceptedAt),
          specialistAnswerInputRevision: inputRevision,
          specialistAnswer: answer,
        })
        .where(eq(hitlRequests.id, questionId));
      await tx.execute(
        sql`UPDATE specialist_assignments SET status='active',revision=revision+1,input_revision=${inputRevision},updated_at=clock_timestamp() WHERE id=${assignmentId}`,
      );
      await completeAssignment({
        db: tx,
        assignmentId: humanWork[0].id,
        actorId: actor.id,
        eventKind: "responded",
      });
      await recordKnowledgeDisclosure(tx, consumer, [
        ...restrictionsForKnowledgeAccess(access),
        {
          kind: "assignment_input",
          assignmentId,
          inputRevision,
          inputSha256: answer.inputSha256,
        },
      ]);
      await tx.execute(
        sql`UPDATE runs SET resume_requested_at=coalesce(resume_requested_at,clock_timestamp()) WHERE id=${question.runId} AND status='NeedsInputIdle'`,
      );
      await emitSpecialistAssignmentChange({
        db: tx,
        owner: knowledgeOwner(head),
        assignmentId,
        revision: input.expectedRevision + 1,
        previousStatus: "waiting_input",
        status: "active",
        cause: "input",
        actor: { type: "user", id: userId },
        originExecution: { runId: question.runId, nodeAttemptId: null },
      });
      await recordSuccessAudit?.(tx, 202);

      return { ...receipt, inputRevision, idempotent: false };
    });

    log.info(
      {
        assignmentId,
        questionId,
        runId: result.runId,
        inputRevision: result.inputRevision,
        idempotent: result.idempotent,
      },
      "clarification answer and existing resume intent committed",
    );
    runEventWakeBus.wake(result.runId);

    return result;
  } catch (error) {
    log.warn(
      {
        assignmentId,
        questionId,
        code: isMaisterError(error) ? error.code : undefined,
        reason: isMaisterError(error) ? error.details?.reason : undefined,
        ...queryErrorDiagnostics(error),
      },
      "clarification answer refused",
    );
    throw redactQueryError(error);
  }
}
