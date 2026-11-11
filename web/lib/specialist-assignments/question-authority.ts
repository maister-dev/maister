import "server-only";

import type { HitlRequest } from "@/lib/db/schema";
import type { AssignmentQuestionSnapshot } from "./question-types";
import type { SqlTransaction } from "@/lib/db/sql-types";
import type { ResolvedAssignmentContextPrincipal } from "./context-access";
import type { KnowledgePrincipal } from "@/lib/brain/knowledge-types";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { assignmentQuestionSnapshotSchema } from "./question-types";
import {
  readAuthorizedAssignmentInput,
  readSpecialistAssignmentContextInTransaction,
} from "./context";
import {
  authorizeRetainedAssignmentQuestion,
  resolveAssignmentContextPrincipal,
} from "./context-access";

import { nodePermissionSourceSchema } from "@/lib/execution-host/flow-permission-source";
import { lockKnowledgeReadConsumer } from "@/lib/brain/knowledge-disclosure";
import { authorizeSourceRestrictions } from "@/lib/brain/knowledge-restrictions";
import { resolveKnowledgeRunIdentity } from "@/lib/brain/knowledge-run-identity";
import { contentDigest } from "@/lib/evaluations/digest";
import { knowledgeOwner } from "@/lib/brain/knowledge-access";
import { MaisterError } from "@/lib/errors";

/** Decode retained native metadata without treating caller form fields as server authority. */
export function decodeAssignmentQuestionSubject(
  value: unknown,
): AssignmentQuestionSnapshot {
  const envelope = z
    .object({ assignmentQuestion: assignmentQuestionSnapshotSchema })
    .passthrough()
    .safeParse(value);

  if (!envelope.success)
    throw new MaisterError(
      "CONFIG",
      "Retained assignment question subject is invalid",
    );

  return envelope.data.assignmentQuestion;
}

/** Before business-owner claims land, only one unsettled root appointment can own a clarification. Ambiguity refuses. */
export async function selectAssignmentQuestionRun(
  tx: SqlTransaction,
  assignmentId: string,
): Promise<string> {
  const candidates = (
    await tx.execute(sql`
    SELECT appointment.run_id FROM specialist_run_links appointment
    JOIN specialist_assignments assignment ON assignment.id=appointment.assignment_id
    JOIN runs execution ON execution.id=appointment.run_id
    JOIN specialist_input_revisions current_input ON current_input.assignment_id=assignment.id AND current_input.revision=assignment.input_revision
    WHERE appointment.assignment_id=${assignmentId} AND specialist_run_has_input(appointment.run_id,assignment.id,current_input.revision,current_input.digest)
      AND appointment.role IN ('specialist','coordinator','continuation') AND appointment.work_id IS NULL
      AND execution.status IN ('Pending','Running','NeedsInput','NeedsInputIdle','WaitingOnChildren','Review')
    LIMIT 2
  `)
  ).rows;

  if (candidates.length !== 1 || typeof candidates[0]?.run_id !== "string")
    throw new MaisterError(
      "CONFLICT",
      "Clarification requires one unambiguous current root execution",
      { details: { reason: "assignment_question_source_ambiguous" } },
    );

  return candidates[0].run_id;
}

/** Recovery rechecks the original actual actor and appointment; a revoked checkpoint token is never impersonated. */
export async function assertPendingAssignmentQuestion(
  tx: SqlTransaction,
  question: HitlRequest,
  assignmentId: string,
): Promise<void> {
  const subject = decodeAssignmentQuestionSubject(question.schema);

  if (
    question.specialistAssignmentId !== assignmentId ||
    question.taskId !== null
  )
    throw new MaisterError(
      "CONFIG",
      "Retained assignment question subject is invalid",
    );
  const head = (
    await tx.execute(
      sql`SELECT * FROM specialist_assignments WHERE id=${assignmentId} FOR UPDATE`,
    )
  ).rows[0];

  if (
    !head ||
    (await selectAssignmentQuestionRun(tx, assignmentId)) !== question.runId ||
    head.status !== "waiting_input" ||
    head.input_revision !== subject.inputRevision ||
    subject.assignmentId !== assignmentId ||
    question.specialistInputRevision !== subject.inputRevision
  )
    throw new MaisterError(
      "CONFLICT",
      "The question no longer names the waiting assignment and exact input",
      { details: { reason: "assignment_question_stale" } },
    );
  const sourceRun = (
    await tx.execute(
      sql`SELECT run_kind FROM runs WHERE id=${question.runId} FOR SHARE`,
    )
  ).rows[0];
  let nodeAttemptId: string | null = null;

  if (sourceRun?.run_kind === "flow") {
    const proof = nodePermissionSourceSchema.safeParse(
      (question.schema as Readonly<{ flowQuestion?: unknown }> | null)
        ?.flowQuestion,
    );

    if (!proof.success)
      throw new MaisterError(
        "CONFIG",
        "Retained Flow clarification source is invalid",
      );
    nodeAttemptId = proof.data.nodeAttemptId;
  }
  await resolveKnowledgeRunIdentity(tx, question.runId, nodeAttemptId);
  let principal: ResolvedAssignmentContextPrincipal;

  if (subject.actor.kind === "user") {
    principal = await resolveAssignmentContextPrincipal(
      tx,
      { kind: "user", userId: subject.actor.id },
      "assignments:update",
    );
  } else {
    const source: KnowledgePrincipal = {
      kind: "execution",
      runId: question.runId,
      nodeAttemptId,
    };
    const consumer = await lockKnowledgeReadConsumer(tx, source);
    const resolved = await resolveKnowledgeRunIdentity(
      tx,
      question.runId,
      nodeAttemptId,
    );

    if (resolved.runKind !== "agent" && resolved.runKind !== "flow")
      throw new MaisterError(
        "UNAUTHORIZED",
        "The clarification source must retain its actual execution appointment",
      );
    principal = { identity: resolved.identity, source, consumer };
  }
  if (contentDigest(principal.identity.actor) !== contentDigest(subject.actor))
    throw new MaisterError(
      "UNAUTHORIZED",
      "The clarification author no longer matches its source appointment",
    );
  const context = await readSpecialistAssignmentContextInTransaction(
    tx,
    principal.source,
    assignmentId,
    subject.contextRevision,
  );

  const currentInput = await readAuthorizedAssignmentInput(
    tx,
    principal.source,
    assignmentId,
    subject.inputRevision,
  );

  if (
    context.value.currentInputRevision !== subject.inputRevision ||
    currentInput.digest !== subject.inputSha256
  )
    throw new MaisterError(
      "CONFLICT",
      "The clarification input witness no longer matches its retained context",
    );
  await authorizeSourceRestrictions(
    tx,
    principal.source,
    subject.sourceRestrictions,
    context.access,
  );
  await authorizeRetainedAssignmentQuestion(
    tx,
    principal,
    knowledgeOwner(head),
    currentInput.snapshot.authoritySnapshot.executionPolicy,
  );
}
