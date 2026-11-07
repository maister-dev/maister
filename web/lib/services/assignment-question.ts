import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { AssignmentContextPrincipal } from "@/lib/specialist-assignments/context-access";
import type {
  AssignmentQuestionInput,
  AssignmentQuestionReceipt,
} from "@/lib/specialist-assignments/question-types";
import type {
  PendingQuestion,
  AgentQuestionActivationDeps,
} from "./agent-question";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import pino from "pino";

import { activatePersistedAgentQuestion } from "./agent-question";

import {
  assignmentQuestionInputSchema,
  assignmentQuestionSnapshotSchema,
} from "@/lib/specialist-assignments/question-types";
import {
  authorizeAssignmentContextUpdate,
  resolveAssignmentContextPrincipal,
} from "@/lib/specialist-assignments/context-access";
import {
  readAuthorizedAssignmentInput,
  readSpecialistAssignmentContextInTransaction,
} from "@/lib/specialist-assignments/context";
import {
  beginAssignmentTransaction,
  unavailableAssignment,
} from "@/lib/specialist-assignments/store";
import { authorizeAssignment } from "@/lib/specialist-assignments/access";
import { executionPolicySchema } from "@/lib/runs/execution-policy";
import {
  selectAssignmentQuestionRun,
  decodeAssignmentQuestionSubject,
} from "@/lib/specialist-assignments/question-authority";
import { knowledgeOwner } from "@/lib/brain/knowledge-access";
import {
  lockKnowledgeReadConsumer,
  recordKnowledgeDisclosure,
} from "@/lib/brain/knowledge-disclosure";
import {
  authorizeSourceRestrictions,
  restrictionsForKnowledgeAccess,
} from "@/lib/brain/knowledge-restrictions";
import { resolveKnowledgeRunIdentity } from "@/lib/brain/knowledge-run-identity";
import { knowledgeAccessCaptureSchema } from "@/lib/company/types";
import { contentDigest } from "@/lib/evaluations/digest";
import { emitSpecialistAssignmentChange } from "@/lib/domain-events/outbox";
import { createHitlRequest } from "@/lib/runs/hitl-create";
import { loadActiveRunSession } from "@/lib/runs/active-run-session";
import {
  captureFlowQuestionSource,
  selectCurrentFlowQuestionNode,
} from "@/lib/execution-host/flow-question-source";
import { pauseAssignmentQuestionNode } from "@/lib/specialist-assignments/flow-question";
import { captureAgentPauseSource } from "@/lib/execution-host/agent-pause-source";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { queryErrorDiagnostics, redactQueryError } from "@/lib/db/pg-error";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const log = pino({
  name: "assignment-question",
  level: process.env.LOG_LEVEL ?? "info",
});

async function persistAssignmentQuestion(
  tx: Tx,
  principal: AssignmentContextPrincipal,
  assignmentId: string,
  input: AssignmentQuestionInput,
): Promise<PendingQuestion> {
  const resolved = await resolveAssignmentContextPrincipal(
    tx,
    principal,
    "assignments:update",
  );

  if (resolved.identity.kind === "user") {
    const selector = (
      await tx.execute(sql`
      SELECT assignment.company_id,assignment.project_id,input.authority_snapshot->'executionPolicy' AS policy
      FROM specialist_assignments assignment JOIN specialist_input_revisions input
        ON input.assignment_id=assignment.id AND input.revision=assignment.input_revision
      WHERE assignment.id=${assignmentId}
    `)
    ).rows[0];

    if (!selector) throw unavailableAssignment();
    const policy = executionPolicySchema.safeParse(selector.policy);

    if (!policy.success)
      throw new MaisterError(
        "CONFIG",
        "Retained question selector policy is invalid",
      );
    await authorizeAssignment(
      tx,
      resolved.identity.user.id,
      knowledgeOwner(selector),
      "assignments:read",
      policy.data,
    );
    await authorizeAssignment(
      tx,
      resolved.identity.user.id,
      knowledgeOwner(selector),
      "assignments:update",
      policy.data,
    );
  } else {
    // The bound consumer is already Run-locked; source input sharing never appoints a foreign context.
    await readSpecialistAssignmentContextInTransaction(
      tx,
      resolved.source,
      assignmentId,
    );
  }
  const runId = await selectAssignmentQuestionRun(tx, assignmentId);

  if (
    resolved.identity.kind !== "user" &&
    resolved.identity.actor.runId !== runId
  )
    throw unavailableAssignment();
  await tx.execute(sql`SELECT id FROM runs WHERE id=${runId} FOR UPDATE`);
  const source = (
    await tx.execute(sql`SELECT * FROM runs WHERE id=${runId} FOR UPDATE`)
  ).rows[0];
  const head = (
    await tx.execute(
      sql`SELECT * FROM specialist_assignments WHERE id=${assignmentId} FOR UPDATE`,
    )
  ).rows[0];

  if (
    !source ||
    !head ||
    (await selectAssignmentQuestionRun(tx, assignmentId)) !== runId ||
    !(
      source.run_kind === "flow" ||
      (source.run_kind === "agent" && source.agent_kind === "operational")
    )
  )
    throw new MaisterError(
      "PRECONDITION",
      "Assignment clarification requires its current owned operational or Flow-node prompt",
      { details: { reason: "assignment_question_source_unavailable" } },
    );
  const flowNodeAttemptId =
    source.run_kind === "flow"
      ? await selectCurrentFlowQuestionNode(tx, runId)
      : null;

  if (
    flowNodeAttemptId !== null &&
    resolved.identity.kind !== "user" &&
    resolved.identity.actor.attemptId !== flowNodeAttemptId
  )
    throw unavailableAssignment();
  await resolveKnowledgeRunIdentity(tx, runId, flowNodeAttemptId);
  const context = await readSpecialistAssignmentContextInTransaction(
    tx,
    resolved.source,
    assignmentId,
  );
  const currentInput = await readAuthorizedAssignmentInput(
    tx,
    resolved.source,
    assignmentId,
    Number(head.input_revision),
  );
  const actor = await authorizeAssignmentContextUpdate(
    tx,
    resolved,
    knowledgeOwner(head),
    currentInput.snapshot.authoritySnapshot.executionPolicy,
  );
  const principalKey = contentDigest(actor);
  const requestDigest = contentDigest(input);
  const previous = (
    await tx.execute(sql`SELECT id,schema,activation_state,input_revision FROM (
    SELECT id,schema,activation_state,specialist_input_revision AS input_revision FROM hitl_requests
    WHERE specialist_assignment_id=${assignmentId} AND schema->'assignmentQuestion'->>'principalKey'=${principalKey}
      AND schema->'assignmentQuestion'->>'requestKey'=${input.idempotencyKey}
  ) retained`)
  ).rows[0];

  if (previous) {
    const subject = decodeAssignmentQuestionSubject(previous.schema);

    await authorizeSourceRestrictions(
      tx,
      resolved.source,
      subject.sourceRestrictions,
      context.access,
    );
    if (subject.requestDigest !== requestDigest)
      throw new MaisterError(
        "CONFLICT",
        "The clarification delivery key already names different content",
      );
    if (
      previous.activation_state !== "active" &&
      previous.activation_state !== "pending_termination"
    )
      throw new MaisterError(
        "CONFLICT",
        "The retained clarification cannot be activated; inspect its checkpoint evidence",
      );

    return {
      id: String(previous.id),
      taskId: null,
      specialistAssignmentId: assignmentId,
      runId,
      activationState: previous.activation_state,
      created: false,
    };
  }
  if (Number(head.revision) >= 2147483647)
    throw new MaisterError(
      "CONFLICT",
      "Assignment revision is exhausted; retain this work and submit a separate request",
    );
  if (
    head.status !== "active" ||
    source.status !== "Running" ||
    head.revision !== input.expectedRevision ||
    head.input_revision !== input.inputRevision ||
    context.value.currentInputRevision !== input.inputRevision
  )
    throw new MaisterError(
      "CONFLICT",
      "Inspect the current active assignment and exact input before opening clarification",
      { details: { reason: "assignment_question_stale" } },
    );
  if (
    (
      await tx.execute(
        sql`SELECT id FROM hitl_requests WHERE run_id=${runId} AND responded_at IS NULL AND superseded_at IS NULL AND (activation_state IS NULL OR activation_state<>'failed') FOR SHARE`,
      )
    ).rows.length > 0
  )
    throw new MaisterError(
      "CONFLICT",
      "The execution already has an unanswered human decision",
    );
  const flowSource =
    source.run_kind === "flow"
      ? await captureFlowQuestionSource(tx, runId)
      : null;
  const capture = knowledgeAccessCaptureSchema.safeParse(
    source.knowledge_access,
  );

  if (!capture.success || capture.data.state !== "complete")
    throw new MaisterError(
      "PRECONDITION",
      "Clarification requires complete source provenance",
    );
  const access = await authorizeSourceRestrictions(
    tx,
    resolved.source,
    [
      ...capture.data.restrictions,
      ...currentInput.snapshot.sourceRestrictions,
      {
        kind: "assignment_input",
        assignmentId,
        inputRevision: currentInput.revision,
        inputSha256: currentInput.digest,
      },
    ],
    context.access,
  );
  const consumer = await lockKnowledgeReadConsumer(tx, {
    kind: "execution",
    runId,
    nodeAttemptId: null,
  });
  const pause =
    flowSource ??
    (await (async () => {
      const session = await loadActiveRunSession(tx, runId);

      if (
        typeof source.execution_assignment_id !== "string" ||
        !session?.hostSessionId
      )
        throw new MaisterError(
          "PRECONDITION",
          "Clarification requires the current owned session",
        );
      const captured = await captureAgentPauseSource(tx, {
        runId,
        assignmentId: source.execution_assignment_id,
        sessionId: session.hostSessionId,
      });

      if (!captured)
        throw new MaisterError(
          "PRECONDITION",
          "Clarification requires the current dispatched prompt owner",
        );

      return captured;
    })());
  const subject = assignmentQuestionSnapshotSchema.parse({
    schemaVersion: 1,
    assignmentId,
    inputRevision: input.inputRevision,
    inputSha256: currentInput.digest,
    contextRevision: context.value.revision,
    expectedRevision: input.expectedRevision,
    principalKey,
    requestKey: input.idempotencyKey,
    requestDigest,
    actor,
    sourceRestrictions: restrictionsForKnowledgeAccess(access),
  });
  const id = randomUUID();

  await recordKnowledgeDisclosure(tx, consumer, subject.sourceRestrictions);
  await createHitlRequest(tx, {
    id,
    runId,
    stepId: flowSource === null ? "agent" : String(source.current_step_id),
    kind: "agent_question",
    taskId: null,
    specialistAssignmentId: assignmentId,
    specialistInputRevision: input.inputRevision,
    activationState: "pending_termination",
    reTriggerMode: "agent",
    schema: {
      ...input.schema,
      kind: "agent_question",
      ...pause,
      assignmentQuestion: subject,
    },
    prompt: input.question,
  });
  if (flowSource !== null) await pauseAssignmentQuestionNode(tx, flowSource);
  await tx.execute(
    sql`UPDATE runs SET status='NeedsInput' WHERE id=${runId} AND status='Running'`,
  );
  await tx.execute(
    sql`UPDATE specialist_assignments SET status='waiting_input',revision=revision+1,updated_at=clock_timestamp() WHERE id=${assignmentId}`,
  );
  await emitSpecialistAssignmentChange({
    db: tx,
    owner: knowledgeOwner(head),
    assignmentId,
    revision: input.expectedRevision + 1,
    previousStatus: "active",
    status: "waiting_input",
    cause: "question",
    actor: { type: actor.kind, id: actor.id },
    originExecution: { runId, nodeAttemptId: null },
  });
  log.info(
    {
      assignmentId,
      runId,
      hitlRequestId: id,
      inputRevision: input.inputRevision,
      contextRevision: subject.contextRevision,
      actorKind: actor.kind,
    },
    "assignment clarification retained before source checkpoint",
  );

  return {
    id,
    taskId: null,
    specialistAssignmentId: assignmentId,
    runId,
    activationState: "pending_termination",
    created: true,
  };
}

/** Persist before teardown; all subjects share the existing HITL checkpoint/activation/recovery service. */
export async function createOrActivateAssignmentQuestion(
  db: Db,
  principal: AssignmentContextPrincipal,
  assignmentId: string,
  value: unknown,
  deps: Omit<AgentQuestionActivationDeps, "db"> = {},
): Promise<AssignmentQuestionReceipt> {
  if (
    !assignmentQuestionSnapshotSchema.shape.assignmentId.safeParse(assignmentId)
      .success
  )
    throw new MaisterError("CONFIG", "Invalid assignment question selector");
  const parsed = assignmentQuestionInputSchema.safeParse(value);

  if (!parsed.success)
    throw new MaisterError("CONFIG", "Invalid structured assignment question");
  if (Buffer.byteLength(JSON.stringify(parsed.data), "utf8") > 32768)
    throw new MaisterError(
      "CONFIG",
      "Assignment question exceeds the 32 KiB request bound",
      { details: { reason: "json_body_too_large" } },
    );
  try {
    const pending = await db.transaction(async (tx) => {
      await beginAssignmentTransaction(tx);

      return persistAssignmentQuestion(
        tx,
        principal,
        assignmentId,
        parsed.data,
      );
    });
    const activated = await activatePersistedAgentQuestion(pending, {
      ...deps,
      db,
    });

    return {
      schemaVersion: 1,
      assignmentId,
      hitlRequestId: activated.hitlRequestId,
      sourceRunId: activated.sourceRunId,
      inputRevision: parsed.data.inputRevision,
      activationState: activated.activationState,
      created: activated.created,
    };
  } catch (error) {
    log.warn(
      {
        assignmentId,
        principalKind: principal.kind,
        expectedRevision: parsed.data.expectedRevision,
        inputRevision: parsed.data.inputRevision,
        code: isMaisterError(error) ? error.code : undefined,
        reason: isMaisterError(error) ? error.details?.reason : undefined,
        ...queryErrorDiagnostics(error),
      },
      "assignment clarification refused",
    );
    throw redactQueryError(error);
  }
}
