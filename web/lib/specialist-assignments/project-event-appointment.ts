import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";
import type { KnowledgeAccessRestriction } from "@/lib/company/types";
import type { ProjectEventAppointment } from "./project-source-types";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { projectEventAppointmentSchema } from "./project-source-types";

import { projectTriggerBindingSnapshotSchema } from "@/lib/agents/trigger-attempt-types";
import { captureTriggerBindingSnapshot } from "@/lib/agents/trigger-binding-snapshot";
import { projectEventSourceReviewSchema } from "@/lib/agents/project-source-review-types";
import { resolveProjectEventChainDepth } from "@/lib/agents/chain-depth";
import { authorizeSourceRestrictions } from "@/lib/brain/knowledge-restrictions";
import { knowledgeAccessCaptureSchema } from "@/lib/company/types";
import { isAgentTriggerEventKind } from "@/lib/domain-events/taxonomy";
import { contentDigest } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";
import { postgresTextSchema } from "@/lib/text-schema";

const identity = postgresTextSchema.min(1).max(128);
const sourceSchema = z.object({
  project_id: identity,
  source_agent_id: identity,
  binding_id: identity,
  binding_snapshot: projectTriggerBindingSnapshotSchema,
  project_source_review: projectEventSourceReviewSchema,
  event_match: z
    .object({
      kinds: z.array(postgresTextSchema.min(1).max(128)).min(1).max(16),
    })
    .strict(),
  event_kind: postgresTextSchema.refine(isAgentTriggerEventKind),
  event_actor_type: z.string(),
  event_run_id: identity.nullable(),
  event_task_id: identity.nullable(),
  producing_id: identity.nullable(),
  source_capture: knowledgeAccessCaptureSchema.nullable(),
});

export type ProjectEventSource = Readonly<{
  projectId: string;
  agentId: string;
  bindingId: string;
  userId: string;
  event: Readonly<{
    id: string;
    kind: string;
    projectId: string;
    taskId: string | null;
    runId: string | null;
  }>;
  sourceRestrictions: readonly KnowledgeAccessRestriction[];
  chainDepth: number;
}>;

/** Validate the actual reviewed event appointment and its complete source closure before native admission. */
export async function loadProjectEventAppointment(
  tx: SqlTransaction,
  value: ProjectEventAppointment,
): Promise<ProjectEventSource> {
  const parsedReference = projectEventAppointmentSchema.safeParse(value);

  if (!parsedReference.success)
    throw new MaisterError(
      "CONFIG",
      "Native project events require an exact source appointment",
      { details: { reason: "project_event_appointment_required" } },
    );
  const reference = parsedReference.data;
  const parsed = sourceSchema.safeParse(
    (
      await tx.execute(sql`
    SELECT invocation.project_id,invocation.source_agent_id,binding.id AS binding_id,
      invocation.binding_snapshot,source.project_source_review,source.event_match,
      event.kind AS event_kind,event.actor_type AS event_actor_type,event.run_id AS event_run_id,event.task_id AS event_task_id,
      producing.id AS producing_id,producing.knowledge_access AS source_capture
    FROM agent_trigger_attempts invocation
    JOIN agent_schedules source ON source.id=invocation.schedule_id AND source.project_id=invocation.project_id
      AND source.agent_id=invocation.source_agent_id AND source.company_id IS NULL AND source.enabled AND source.trigger_type='event'
    JOIN agent_project_links binding ON binding.project_id=invocation.project_id AND binding.agent_id=invocation.source_agent_id AND binding.enabled
    JOIN domain_events event ON event.id=invocation.trigger_event_id AND event.project_id=invocation.project_id AND event.company_id IS NULL
      AND source.created_at<=event.created_at
    LEFT JOIN runs producing ON producing.id=event.run_id AND producing.project_id=invocation.project_id AND producing.company_id IS NULL
    WHERE invocation.id=${reference.attemptId} AND invocation.schedule_id=${reference.scheduleId}
      AND invocation.reserved_run_id=${reference.runId} AND invocation.company_id IS NULL
      AND invocation.trigger_source='domain_event' AND invocation.trigger_event_id=${reference.eventId}
      AND invocation.scheduled_request_snapshot IS NULL AND invocation.provenance='claim' AND invocation.outcome IS NULL
    FOR SHARE OF invocation,source,binding,event
  `)
    ).rows[0],
  );

  if (!parsed.success)
    throw new MaisterError(
      "PRECONDITION",
      "The exact reviewed project event or open invocation is unavailable",
      { details: { reason: "project_event_appointment_unavailable" } },
    );
  const source = parsed.data;
  const current = await captureTriggerBindingSnapshot(tx, {
    id: reference.scheduleId,
    agentId: source.source_agent_id,
    projectId: source.project_id,
    companyId: null,
    companySpecialistBindingId: null,
    companyFlowBindingId: null,
    companyConfigRevision: null,
    triggerType: "event",
    cronExpr: null,
    timezone: null,
    eventMatch: source.event_match,
    projectSourceReview: source.project_source_review,
    requestAtLaunch: null,
  });

  if (
    contentDigest(current) !== contentDigest(source.binding_snapshot) ||
    source.binding_snapshot.owner.projectId !== source.project_id ||
    !source.binding_snapshot.eventKinds.includes(source.event_kind) ||
    BigInt(reference.eventId) <=
      BigInt(source.project_source_review.eventCursor)
  )
    throw new MaisterError(
      "CONFLICT",
      "The project event source changed or does not cover this event",
      { details: { reason: "project_event_source_changed" } },
    );
  let restrictions: readonly KnowledgeAccessRestriction[] = [
    { kind: "project_context", projectId: source.project_id },
  ];

  if (source.event_run_id !== null) {
    if (
      source.producing_id !== source.event_run_id ||
      source.source_capture?.state !== "complete"
    )
      throw new MaisterError(
        "PRECONDITION",
        "The producing project Run has unavailable or unclassified evidence",
        { details: { reason: "project_event_source_unclassified" } },
      );
    if (source.project_source_review.sourceSharing !== "producing_run")
      throw new MaisterError(
        "UNAUTHORIZED",
        "This event source has no current approval to share its producing Run context",
        { details: { reason: "project_event_sharing_required" } },
      );
    await tx.execute(
      sql`SELECT id FROM runs WHERE id=${source.producing_id} FOR SHARE`,
    );
    restrictions = source.source_capture.restrictions;
  } else if (source.event_actor_type !== "user")
    throw new MaisterError(
      "PRECONDITION",
      "Agent and system events require classified producing work",
      { details: { reason: "project_event_source_unclassified" } },
    );
  await authorizeSourceRestrictions(
    tx,
    { kind: "user", userId: source.project_source_review.reviewerUserId },
    restrictions,
  );
  const chain = await resolveProjectEventChainDepth(
    tx,
    source.project_id,
    reference.eventId,
  );

  if (chain.atCap)
    throw new MaisterError(
      "PRECONDITION",
      "Project event chain is unclassified or exhausted",
      { details: { reason: chain.reason ?? "chain_depth_exhausted" } },
    );

  return {
    projectId: source.project_id,
    agentId: source.source_agent_id,
    bindingId: source.binding_id,
    userId: source.project_source_review.reviewerUserId,
    sourceRestrictions: restrictions,
    chainDepth: chain.depth,
    event: {
      id: String(reference.eventId),
      kind: source.event_kind,
      projectId: source.project_id,
      taskId: source.event_task_id,
      runId: source.event_run_id,
    },
  };
}
