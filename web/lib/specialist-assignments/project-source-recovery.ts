import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { SpecialistAssignment } from "./types";
import type { ProjectAgentTriggerClaim } from "@/lib/agents/trigger-attempts";
import type { ProjectSourceAppointment } from "./project-source-types";

import { and, eq, isNull, or, sql } from "drizzle-orm";
import pino from "pino";

import { getSpecialistAssignment, getSpecialistAssignmentInput } from "./store";
import { reserveProjectCoordinatorTask } from "./project-flow-task";
import { retainProjectSourceHandoff } from "./project-source-handoff";
import { assertProjectCoordinatorProvider } from "./project-flow-provider";
import { submitProjectCommentAssignment } from "./project-comment-intake";
import { submitProjectCronAssignment } from "./project-cron-intake";
import { submitProjectEventAssignment } from "./project-event-intake";
import {
  advanceProjectRecoveryCursor,
  PROJECT_RECOVERY_PAGE_SIZE,
  projectRecoveryHeadBounds,
  readProjectRecoveryCursor,
} from "./project-recovery-cursor";

import { agentTriggerAttempts } from "@/lib/db/schema";
import { assertProjectAgentTriggerClaim } from "@/lib/agents/trigger-attempts";
import { dispatchTaskLaunchIntent } from "@/lib/tasks/launch-dispatch";
import { isMaisterError, MaisterError } from "@/lib/errors";

const log = pino({
  name: "project-source-recovery",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Original origin and real invocation identify unused source work; neither score nor arrival order chooses an owner. */
async function originalProjectSourceClaim(
  db: Db,
  assignment: SpecialistAssignment,
): Promise<ProjectAgentTriggerClaim | null> {
  if (assignment.owner.kind !== "project") return null;
  if (typeof assignment.responsible.id !== "string")
    throw new MaisterError(
      "CONFIG",
      "Interrupted intake must retain its original responsible role",
    );
  const origin = assignment.origin;

  if (origin.kind === "manual" || origin.kind === "webhook") return null;
  if (!["task_comment", "schedule", "event"].includes(origin.kind))
    throw new MaisterError(
      "PRECONDITION",
      "Only the original native project intake can recover its source",
    );
  const originMatch =
    origin.kind === "schedule"
      ? sql`${agentTriggerAttempts.id}=${origin.triggerAttemptId} AND ${agentTriggerAttempts.scheduleId}=${origin.scheduleId} AND ${agentTriggerAttempts.triggerSource}='cron'`
      : origin.kind === "event"
        ? sql`${agentTriggerAttempts.scheduleId}=${origin.subscriptionId} AND ${agentTriggerAttempts.triggerEventId}::text=${origin.eventId} AND ${agentTriggerAttempts.triggerSource}='domain_event' AND ${agentTriggerAttempts.bindingSnapshot}->>'triggerType'='event'`
        : origin.kind === "task_comment"
          ? sql`${agentTriggerAttempts.triggerSource}='domain_event' AND ${agentTriggerAttempts.bindingSnapshot}->>'triggerType'='mention'
          AND EXISTS(SELECT 1 FROM domain_events fact WHERE fact.id=${agentTriggerAttempts.triggerEventId}
            AND fact.project_id=${assignment.owner.projectId} AND fact.company_id IS NULL AND fact.kind='task.comment_added'
            AND fact.task_id=${origin.taskId} AND fact.payload->>'commentId'=${origin.commentId}
            AND fact.actor_type='user' AND fact.actor_id=${assignment.requester.id})`
          : sql`false`;
  const claims = await db
    .select()
    .from(agentTriggerAttempts)
    .where(
      and(
        eq(agentTriggerAttempts.projectId, assignment.owner.projectId),
        isNull(agentTriggerAttempts.companyId),
        eq(agentTriggerAttempts.sourceAgentId, assignment.responsible.id),
        eq(agentTriggerAttempts.provenance, "claim"),
        isNull(agentTriggerAttempts.specialistAssignment),
        isNull(agentTriggerAttempts.runId),
        isNull(agentTriggerAttempts.originalRunId),
        or(
          isNull(agentTriggerAttempts.outcome),
          eq(agentTriggerAttempts.outcome, "unknown"),
        ),
        originMatch,
      ),
    )
    .limit(2);

  if (claims.length !== 1)
    throw new MaisterError(
      "CONFLICT",
      "Interrupted intake requires one exact unused original source reservation",
      { details: { reason: "project_source_recovery_unavailable" } },
    );
  const claim = claims[0];

  assertProjectAgentTriggerClaim(claim);

  return claim;
}

function originalSourceAppointment(
  assignment: SpecialistAssignment,
  claim: ProjectAgentTriggerClaim,
): ProjectSourceAppointment {
  const base = {
    schemaVersion: 1 as const,
    attemptId: claim.id,
    scheduleId: claim.scheduleId,
    runId: claim.reservedRunId,
  };

  if (assignment.origin.kind === "schedule") return { ...base, kind: "cron" };
  if (claim.triggerEventId === null)
    throw new MaisterError(
      "CONFIG",
      "The original source event identity is missing",
    );
  if (assignment.origin.kind === "task_comment")
    return { ...base, kind: "task_comment", eventId: claim.triggerEventId };
  if (assignment.origin.kind === "event")
    return { ...base, kind: "event", eventId: claim.triggerEventId };
  throw new MaisterError(
    "CONFIG",
    "A native source cannot recover another assignment origin",
  );
}

/** Recover bounded missing intake bindings on the existing automatic-launch job, without resetting uncertain execution. */
export async function recoverInterruptedProjectIntakes(
  db: Db,
): Promise<number> {
  const cursor = await readProjectRecoveryCursor(
    db,
    "projectIntakeRecoveryCursor",
  );
  const candidates = (
    await db.execute<{
      id: string;
      user_id: string;
      cursor_created_at: string;
    }>(sql`
    SELECT head.id,head.requester->>'id' AS user_id,
      to_char(head.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
    FROM specialist_assignments head
    JOIN specialist_input_revisions input ON input.assignment_id=head.id AND input.revision=head.input_revision
    WHERE head.project_id IS NOT NULL AND head.company_id IS NULL AND head.status='queued'
      AND input.standing_definition->'schemaVersion'='2'::jsonb AND head.requester->>'kind'='user'
      AND head.origin->>'kind' IN ('manual','webhook','task_comment','schedule','event')
      AND EXISTS(SELECT 1 FROM specialist_intake_receipts receipt WHERE receipt.assignment_id=head.id
        AND receipt.input_revision=head.input_revision AND receipt.actor=head.requester)
      AND NOT EXISTS(SELECT 1 FROM specialist_run_links link WHERE link.assignment_id=head.id)
      AND NOT EXISTS(SELECT 1 FROM task_launch_intents intent WHERE intent.task_id=head.project_task_id)
      AND (head.project_task_id IS NULL OR (head.origin->>'kind' IN ('task_comment','schedule','event')
        AND NOT EXISTS(SELECT 1 FROM agent_trigger_attempts invocation WHERE invocation.specialist_assignment->'assignment'->>'id'=head.id)))
      AND ${projectRecoveryHeadBounds(cursor)}
    ORDER BY head.created_at,head.id LIMIT ${PROJECT_RECOVERY_PAGE_SIZE}
  `)
  ).rows;
  let recovered = 0;

  for (const candidate of candidates) {
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.user_id !== "string"
    )
      throw new MaisterError(
        "CONFIG",
        "Interrupted intake attribution is unavailable",
      );
    try {
      const assignment = await getSpecialistAssignment(
        db,
        candidate.user_id,
        candidate.id,
      );
      const input = await getSpecialistAssignmentInput(
        db,
        candidate.user_id,
        candidate.id,
        assignment.inputRevision,
      );

      if (
        assignment.owner.kind !== "project" ||
        input.snapshot.standingDefinition.schemaVersion !== 2
      )
        continue;
      const claim = await originalProjectSourceClaim(db, assignment);
      const source = claim
        ? originalSourceAppointment(assignment, claim)
        : null;
      const flow = input.snapshot.standingDefinition.coordinatorFlow;

      await assertProjectCoordinatorProvider(
        db,
        assignment.owner.projectId,
        flow,
      );
      const carrier = await reserveProjectCoordinatorTask(db, {
        projectId: assignment.owner.projectId,
        agentId: input.snapshot.standingDefinition.agentId,
        flow,
        reference: {
          assignmentId: assignment.id,
          inputRevision: assignment.inputRevision,
          expectedRevision: assignment.revision,
          userId: candidate.user_id,
          ...(source ? { source } : {}),
        },
      });

      if (source && claim) {
        await retainProjectSourceHandoff(
          db,
          assignment.owner.projectId,
          carrier.admission,
        );
        const receipt =
          source.kind === "task_comment"
            ? await submitProjectCommentAssignment(db, claim)
            : source.kind === "cron"
              ? await submitProjectCronAssignment(db, claim)
              : await submitProjectEventAssignment(db, claim);

        if (receipt.assignment.id !== assignment.id)
          throw new MaisterError(
            "CONFLICT",
            "Source recovery cannot retarget retained assignment input",
          );
        if (receipt.projectAdmission?.kind === "accepted")
          await dispatchTaskLaunchIntent(
            db,
            receipt.projectAdmission.receipt.intentId,
          );
      }
      recovered++;
    } catch (error) {
      if (
        !isMaisterError(error) ||
        ![
          "CONFIG",
          "PRECONDITION",
          "CONFLICT",
          "UNAUTHORIZED",
          "UNAUTHENTICATED",
          "ACCOUNT_INACTIVE",
          "PASSWORD_CHANGE_REQUIRED",
          "NEEDS_INPUT",
          "EXECUTOR_UNAVAILABLE",
        ].includes(error.code)
      )
        throw error;
      log.warn(
        {
          assignmentId: candidate.id,
          code: error.code,
          reason: error.details?.reason ?? null,
        },
        "interrupted project intake retains its current admission blocker",
      );
    }
  }
  const last = candidates.at(-1);

  await advanceProjectRecoveryCursor(
    db,
    cursor,
    candidates.length === PROJECT_RECOVERY_PAGE_SIZE && last
      ? { id: last.id, createdAt: last.cursor_created_at }
      : null,
  );

  return recovered;
}
