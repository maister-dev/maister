import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";
import type { ProjectCronAppointment } from "./project-source-types";
import type { ScheduledAgentRequestSnapshot } from "@/lib/agents/scheduled-request";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { projectCronAppointmentSchema } from "./project-source-types";

import { projectTriggerBindingSnapshotSchema } from "@/lib/agents/trigger-attempt-types";
import { captureTriggerBindingSnapshot } from "@/lib/agents/trigger-binding-snapshot";
import { scheduledRequestSnapshotSchema } from "@/lib/agents/scheduled-request";
import { projectSourceReviewSchema } from "@/lib/agents/project-source-review-types";
import { contentDigest } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";
import { postgresTextSchema } from "@/lib/text-schema";

const identity = postgresTextSchema.min(1).max(128);
const sourceSchema = z.object({
  project_id: identity,
  source_agent_id: identity,
  binding_id: identity,
  binding_snapshot: projectTriggerBindingSnapshotSchema,
  scheduled_request_snapshot: scheduledRequestSnapshotSchema,
  project_source_review: projectSourceReviewSchema,
  cron_expr: postgresTextSchema,
  timezone: postgresTextSchema,
  request_at_launch: postgresTextSchema.nullable(),
});

export type ProjectCronSource = Readonly<{
  projectId: string;
  agentId: string;
  bindingId: string;
  userId: string;
  scheduledRequest: ScheduledAgentRequestSnapshot;
}>;

/** Validate current review and the real open source claim; neither model input nor a retained grant can create an appointment. */
export async function loadProjectCronAppointment(
  tx: SqlTransaction,
  value: ProjectCronAppointment,
): Promise<ProjectCronSource> {
  const appointment = projectCronAppointmentSchema.safeParse(value);

  if (!appointment.success)
    throw new MaisterError(
      "CONFIG",
      "Native project cron work requires an exact source appointment",
    );
  const reference = appointment.data;
  const parsed = sourceSchema.safeParse(
    (
      await tx.execute(sql`
    SELECT invocation.project_id,invocation.source_agent_id,binding.id AS binding_id,
      invocation.binding_snapshot,invocation.scheduled_request_snapshot,
      source.project_source_review,source.cron_expr,source.timezone,source.request_at_launch
    FROM agent_trigger_attempts invocation
    JOIN agent_schedules source ON source.id=invocation.schedule_id AND source.project_id=invocation.project_id
      AND source.agent_id=invocation.source_agent_id AND source.company_id IS NULL AND source.enabled AND source.trigger_type='cron'
    JOIN agent_project_links binding ON binding.project_id=invocation.project_id AND binding.agent_id=invocation.source_agent_id AND binding.enabled
    WHERE invocation.id=${reference.attemptId} AND invocation.schedule_id=${reference.scheduleId}
      AND invocation.reserved_run_id=${reference.runId} AND invocation.company_id IS NULL
      AND invocation.trigger_source='cron' AND invocation.trigger_event_id IS NULL AND invocation.provenance='claim'
      AND invocation.outcome IS NULL
    FOR SHARE OF invocation,source,binding
  `)
    ).rows[0],
  );

  if (!parsed.success)
    throw new MaisterError(
      "PRECONDITION",
      "The exact reviewed project cron source or open invocation is unavailable",
      { details: { reason: "project_cron_appointment_unavailable" } },
    );
  const source = parsed.data;
  const scheduled = source.scheduled_request_snapshot;

  if (scheduled.requestAtLaunch === null)
    throw new MaisterError(
      "NEEDS_INPUT",
      "Native project cron work requires an explicit retained recurring request",
      { details: { reason: "project_scheduled_request_missing" } },
    );
  const current = await captureTriggerBindingSnapshot(tx, {
    id: reference.scheduleId,
    agentId: source.source_agent_id,
    projectId: source.project_id,
    companyId: null,
    companySpecialistBindingId: null,
    companyFlowBindingId: null,
    companyConfigRevision: null,
    triggerType: "cron",
    cronExpr: source.cron_expr,
    timezone: source.timezone,
    eventMatch: null,
    requestAtLaunch: source.request_at_launch,
    projectSourceReview: source.project_source_review,
  });

  if (
    contentDigest(current) !== contentDigest(source.binding_snapshot) ||
    scheduled.scheduleId !== reference.scheduleId ||
    scheduled.triggerAttemptId !== reference.attemptId ||
    scheduled.requestAtLaunch !== source.request_at_launch ||
    source.binding_snapshot.owner.projectId !== source.project_id
  )
    throw new MaisterError(
      "CONFLICT",
      "Project cron source changed after its immutable reviewed invocation",
      { details: { reason: "project_cron_source_changed" } },
    );

  return {
    projectId: source.project_id,
    agentId: source.source_agent_id,
    bindingId: source.binding_id,
    userId: source.project_source_review.reviewerUserId,
    scheduledRequest: scheduled,
  };
}
