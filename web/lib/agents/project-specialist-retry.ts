import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { Run } from "@/lib/db/schema";
import type { ProjectAgentRetryIntent } from "./retry-scope";
import type {
  ProjectAgentRetryRecipe,
  ProjectSpecialistReplacement,
} from "./retry-types";

import { sql } from "drizzle-orm";

import {
  assertRetryAuthority,
  preDispatchRetrySafetyReason,
  retryDigest,
  retryRefusal,
} from "./retry-guards";
import { projectSpecialistReplacementSchema } from "./retry-snapshot";
import { parseScheduledRequestSnapshot } from "./scheduled-request";

import {
  authorizeRunKnowledgeDisclosure,
  authorizeRunsKnowledgeDisclosure,
} from "@/lib/brain/knowledge-run-disclosure";
import { pgErrorOf, redactQueryError } from "@/lib/db/pg-error";
import { authorizeAssignment } from "@/lib/specialist-assignments/access";
import { assignmentBudgetAllowsDispatchSql } from "@/lib/specialist-assignments/delegated-budget";
import { loadProjectCronReplacementSource } from "@/lib/specialist-assignments/project-cron-appointment";

export async function authorizeProjectRetryReceipt(
  db: Db,
  intent: ProjectAgentRetryIntent,
  userId: string,
): Promise<void> {
  if (intent.recipe.version !== 2 || !intent.recipe.replacement) {
    await assertRetryAuthority(db, intent.projectId, userId);

    return;
  }
  const { recipe } = intent;

  await db.transaction(async (tx) => {
    await assertRetryAuthority(tx, intent.projectId, userId);
    await authorizeAssignment(
      tx,
      userId,
      { kind: "project", projectId: intent.projectId },
      "assignments:recover",
      recipe.policy,
    );
    await authorizeRunsKnowledgeDisclosure(
      tx,
      { kind: "user", userId },
      intent.createdRunId
        ? [intent.sourceRunId, intent.createdRunId]
        : [intent.sourceRunId],
    );
  });
}

/** A settled, taskless operational appointment must carry positive pre-dispatch evidence. */
export async function prepareProjectSpecialistReplacement(
  db: Db,
  source: Run,
  userId: string,
): Promise<{
  witness: ProjectSpecialistReplacement;
  runnerId: string;
  runner: unknown;
}> {
  const cron = source.triggerSource === "cron";

  if (
    !source.projectId ||
    source.companyId ||
    source.runKind !== "agent" ||
    source.agentKind !== "operational" ||
    source.agentWorkspace !== "none" ||
    source.taskId ||
    source.parentRunId ||
    source.persistent ||
    (source.triggerSource !== "manual" && !cron) ||
    source.triggerEventId !== null ||
    (cron
      ? !source.agentScheduleId ||
        !source.scheduledRequestSnapshot ||
        source.retryOfRunId !== null
      : Boolean(source.agentScheduleId || source.scheduledRequestSnapshot)) ||
    !source.resultContract ||
    !source.operationalTerminal ||
    !source.executionPolicy ||
    !source.endedAt
  )
    throw retryRefusal("retry_source_unsupported");

  await authorizeAssignment(
    db,
    userId,
    { kind: "project", projectId: source.projectId },
    "assignments:recover",
    source.executionPolicy,
  );
  try {
    await db.execute(sql`
      SELECT subject.id FROM specialist_assignments subject
      JOIN specialist_run_links link ON link.assignment_id=subject.id AND link.run_id=${source.id}
      WHERE subject.project_id=${source.projectId} FOR NO KEY UPDATE OF subject NOWAIT
    `);
  } catch (error) {
    if (pgErrorOf(error)?.code === "55P03")
      throw retryRefusal("retry_assignment_busy");
    throw redactQueryError(error);
  }

  const [row] = (
    await db.execute(sql`
    SELECT jsonb_build_object(
      'sourceRunId',source.id,'assignmentId',subject.id,'inputRevision',input.revision,'inputSha256',input.digest,
      'assignmentRevision',subject.revision,'contextRevision',subject.context_revision,'ownerEpoch',owner.epoch,
      'resultSha256',task_launch_admission_digest(source.result_contract),'sourceSha256',company_retry_source_digest(source)
    ) AS witness, session.runner_id, session.runner_snapshot,
    company_retry_has_dispatch_witness(source.id) AS before_dispatch,
    ${assignmentBudgetAllowsDispatchSql(sql`${source.id}`)} AS budget_allowed
    FROM runs source JOIN specialist_run_links link ON link.run_id=source.id AND link.work_id IS NULL
    JOIN specialist_assignments subject ON subject.id=link.assignment_id AND subject.project_id=source.project_id
    JOIN specialist_input_revisions input ON input.assignment_id=subject.id AND input.revision=subject.input_revision
    JOIN specialist_owner_claims owner ON owner.assignment_id=subject.id AND owner.run_id=source.id AND owner.placement_id=source.execution_assignment_id
    JOIN run_sessions session ON session.run_id=source.id AND session.session_name='default'
    WHERE source.id=${source.id} AND subject.status='active' AND subject.origin->>'kind'=${cron ? "schedule" : "manual"}
      AND subject.requester->>'kind'='user' AND subject.requester->>'id'=${userId}
      AND input.revision=link.input_revision AND link.role IN ('specialist','continuation')
      AND specialist_current_root_id(subject.id,subject.input_revision)=source.id
      AND NOT specialist_other_unsettled_root(subject.id,source.id)
      AND source.knowledge_access->>'state'='complete'
      AND source.knowledge_access->'restrictions' @> jsonb_build_array(jsonb_build_object(
        'kind','assignment_input','assignmentId',subject.id,'inputRevision',input.revision,'inputSha256',input.digest))
    FOR SHARE OF link,input,owner,session
  `)
  ).rows;
  const witness = projectSpecialistReplacementSchema.safeParse(row?.witness);

  if (
    !witness.success ||
    typeof row?.runner_id !== "string" ||
    !row.runner_snapshot
  )
    throw retryRefusal("retry_source_unsupported");
  await authorizeRunKnowledgeDisclosure(
    db,
    { kind: "user", userId },
    source.id,
  );
  const reason = await preDispatchRetrySafetyReason(db, source);

  if (reason) throw retryRefusal(reason);
  if (row.before_dispatch !== true)
    throw retryRefusal("reconciliation_required");
  if (row.budget_allowed !== true)
    throw retryRefusal("assignment_budget_exhausted");
  const scheduled = parseScheduledRequestSnapshot(
    source.scheduledRequestSnapshot,
  );
  const appointment = scheduled
    ? {
        schemaVersion: 1 as const,
        kind: "cron" as const,
        attemptId: scheduled.triggerAttemptId,
        scheduleId: scheduled.scheduleId,
        runId: source.id,
      }
    : undefined;

  if (appointment) {
    const original = await loadProjectCronReplacementSource(db, appointment);

    if (
      original.projectId !== source.projectId ||
      original.agentId !== source.sourceAgentId ||
      original.userId !== userId ||
      original.scheduledRequest.scheduleId !== source.agentScheduleId ||
      retryDigest(original.scheduledRequest) !== retryDigest(scheduled)
    )
      throw retryRefusal("retry_context_changed");
  }

  return {
    witness: { ...witness.data, ...(appointment ? { cron: appointment } : {}) },
    runnerId: row.runner_id,
    runner: row.runner_snapshot,
  };
}

export async function assertProjectSpecialistReplacement(
  db: Db,
  source: Run,
  userId: string,
  recipe: Extract<ProjectAgentRetryRecipe, { version: 2 }>,
): Promise<void> {
  const current = await prepareProjectSpecialistReplacement(db, source, userId);

  if (
    recipe.strategy !== "pre_work_retry" ||
    recipe.projectId !== source.projectId ||
    recipe.trigger.source !== source.triggerSource ||
    recipe.taskId !== null ||
    retryDigest(current.witness) !== retryDigest(recipe.replacement) ||
    retryDigest(current.runner) !== retryDigest(recipe.runner)
  )
    throw retryRefusal("retry_context_changed");
}
