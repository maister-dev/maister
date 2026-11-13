import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";
import type { SQL } from "drizzle-orm";
import type { ProjectCommentAppointment } from "./project-source-types";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { queuedProjectSourceHandoffPredicate } from "./project-source-handoff-query";
import { projectCommentAppointmentSchema } from "./project-source-types";

import { captureTriggerBindingSnapshot } from "@/lib/agents/trigger-binding-snapshot";
import { parseAgentTriggerBindingSnapshot } from "@/lib/agents/trigger-attempt-types";
import { contentDigest } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";
import { postgresTextSchema } from "@/lib/text-schema";

const identity = postgresTextSchema.min(1).max(128);
const sourceSchema = z.object({
  project_id: identity,
  source_agent_id: identity,
  binding_id: identity,
  task_id: identity,
  comment_id: identity,
  body: postgresTextSchema.min(1).regex(/\S/),
  actor_type: z.enum(["user", "agent", "system"]),
  actor_id: identity.nullable(),
  comment_actor_type: z.enum(["user", "agent", "system"]),
  comment_actor_id: identity.nullable(),
  mentioned_agent_ids: z.array(identity),
  binding_snapshot: z.unknown(),
  cron_expr: z.string().nullable(),
  timezone: z.string().nullable(),
  event_match: z.object({ kinds: z.array(z.string()) }).nullable(),
});

export type ProjectCommentSource = Readonly<{
  projectId: string;
  agentId: string;
  bindingId: string;
  userId: string;
  taskId: string;
  commentId: string;
  body: string;
}>;

/** Lock and validate the real source closure; payload claims alone never establish author, owner or reservation. */
export async function loadProjectCommentAppointment(
  tx: SqlTransaction,
  value: ProjectCommentAppointment,
): Promise<ProjectCommentSource> {
  return loadProjectCommentSource(
    tx,
    value,
    sql`(invocation.outcome IS NULL OR ${queuedProjectSourceHandoffPredicate()})`,
  );
}

export async function loadProjectCommentReplacementSource(
  tx: SqlTransaction,
  value: ProjectCommentAppointment,
): Promise<ProjectCommentSource> {
  return loadProjectCommentSource(
    tx,
    value,
    sql`invocation.run_id=invocation.reserved_run_id AND invocation.outcome IN ('queued','launched','deduplicated')`,
  );
}

async function loadProjectCommentSource(
  tx: SqlTransaction,
  value: ProjectCommentAppointment,
  outcome: SQL,
): Promise<ProjectCommentSource> {
  const parsed = projectCommentAppointmentSchema.safeParse(value);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Native comment work requires a validated source appointment",
    );
  const appointment = parsed.data;
  const row = (
    await tx.execute(sql`
    SELECT invocation.project_id,invocation.source_agent_id,binding.id AS binding_id,
      event.task_id,comment.id AS comment_id,comment.body,event.actor_type,event.actor_id,
      comment.actor_type AS comment_actor_type,comment.actor_id AS comment_actor_id,
      event.payload->'mentionedAgentIds' AS mentioned_agent_ids,invocation.binding_snapshot,
      source.cron_expr,source.timezone,source.event_match
    FROM agent_trigger_attempts invocation
    JOIN agent_schedules source ON source.id=invocation.schedule_id AND source.project_id=invocation.project_id
      AND source.agent_id=invocation.source_agent_id AND source.company_id IS NULL AND source.enabled AND source.trigger_type='mention'
    JOIN agent_project_links binding ON binding.project_id=invocation.project_id AND binding.agent_id=invocation.source_agent_id AND binding.enabled
    JOIN domain_events event ON event.id=invocation.trigger_event_id AND event.project_id=invocation.project_id
      AND event.company_id IS NULL AND event.kind='task.comment_added'
    JOIN task_comments comment ON comment.id=event.payload->>'commentId' AND comment.project_id=event.project_id AND comment.task_id=event.task_id
    JOIN tasks task ON task.id=comment.task_id AND task.project_id=event.project_id
    WHERE invocation.id=${appointment.attemptId} AND invocation.schedule_id=${appointment.scheduleId}
      AND invocation.trigger_event_id=${appointment.eventId} AND invocation.reserved_run_id=${appointment.runId}
      AND invocation.company_id IS NULL AND invocation.trigger_source='domain_event' AND invocation.provenance='claim'
      AND ${outcome} AND invocation.scheduled_request_snapshot IS NULL
    FOR SHARE OF invocation,source,binding,event,comment,task
  `)
  ).rows[0];
  const actual = sourceSchema.safeParse(row);

  if (!actual.success)
    throw new MaisterError(
      "PRECONDITION",
      "The native comment source, bounded input or original invocation is unavailable",
      {
        details: { reason: "project_comment_appointment_unavailable" },
      },
    );
  const source = actual.data;

  if (source.body.length > 8000)
    throw new MaisterError(
      "CONFIG",
      "Native comment work requires at most 8000 stored characters; post a shorter request or reference its bounded input",
      {
        details: { reason: "project_comment_input_too_large" },
      },
    );

  if (
    source.actor_type !== "user" ||
    source.actor_id === null ||
    source.comment_actor_type !== "user" ||
    source.comment_actor_id !== source.actor_id
  )
    throw new MaisterError(
      "UNAUTHORIZED",
      "Native comment work requires its actual human author; agent work needs governed principal admission",
      {
        details: { reason: "project_comment_user_author_required" },
      },
    );
  if (!source.mentioned_agent_ids.includes(source.source_agent_id))
    throw new MaisterError(
      "CONFLICT",
      "The stored event did not address this professional",
    );
  const captured = parseAgentTriggerBindingSnapshot(source.binding_snapshot);
  const current = await captureTriggerBindingSnapshot(tx, {
    id: appointment.scheduleId,
    agentId: source.source_agent_id,
    projectId: source.project_id,
    companyId: null,
    companySpecialistBindingId: null,
    companyFlowBindingId: null,
    companyConfigRevision: null,
    triggerType: "mention",
    cronExpr: source.cron_expr,
    timezone: source.timezone,
    eventMatch: source.event_match,
  });

  if (
    captured.version !== 1 ||
    captured.triggerType !== "mention" ||
    contentDigest(captured) !== contentDigest(current)
  )
    throw new MaisterError(
      "CONFLICT",
      "The mention source selector changed after its immutable claim",
      {
        details: { reason: "project_comment_source_changed" },
      },
    );

  return {
    projectId: source.project_id,
    agentId: source.source_agent_id,
    bindingId: source.binding_id,
    userId: source.actor_id,
    taskId: source.task_id,
    commentId: source.comment_id,
    body: source.body,
  };
}
