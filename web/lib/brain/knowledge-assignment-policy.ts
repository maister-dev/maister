import "server-only";

import type { SQL } from "drizzle-orm";
import type { KnowledgePrincipalIdentity } from "./knowledge-access";

import { sql } from "drizzle-orm";

import { projectRolesForActions } from "@/lib/authz";

export function assignmentInputOwnerReadPolicy(
  identity: Extract<KnowledgePrincipalIdentity, { kind: "user" }>,
  company: SQL,
  project: SQL,
): SQL {
  const companyReader =
    identity.boundProjectId !== null
      ? sql`false`
      : sql`EXISTS (SELECT 1 FROM company_grants source_grant WHERE source_grant.company_id=${company} AND source_grant.principal_type='user' AND source_grant.principal_id=${identity.user.id} AND source_grant.action='assignments:read' AND source_grant.revoked_at IS NULL FOR SHARE)`;
  const projectReader = sql`(${identity.boundProjectId === null ? sql`true` : sql`${project}=${identity.boundProjectId}`}) AND EXISTS (
    SELECT 1 FROM projects source_project WHERE source_project.id=${project} AND (
      ${
        identity.user.role === "admin"
          ? sql`true`
          : sql`EXISTS (
        SELECT 1 FROM project_members source_member WHERE source_member.project_id=source_project.id AND source_member.user_id=${identity.user.id} AND source_member.role IN (${sql.join(
          projectRolesForActions(["readBoard"]).map((role) => sql`${role}`),
          sql`, `,
        )}) FOR SHARE
      )`
      }
    ) FOR SHARE
  )`;

  return sql`((${company} IS NOT NULL AND (${companyReader})) OR (${project} IS NOT NULL AND (${projectReader})))`;
}

/** Appointment shares one immutable company input; it supplies no general Brain or assignment read grant. */
export function assignmentInputReadPolicy(
  identity: KnowledgePrincipalIdentity,
  assignmentId: SQL,
  revision: SQL,
  digest: SQL,
): SQL {
  if (identity.kind === "agent")
    return sql`((${projectAssignmentInputReadPolicy(identity, assignmentId, revision, digest)}) OR (${projectEventInputReadPolicy(identity, assignmentId, revision, digest)}))`;
  // The server-resolved execution identity already locks this exact input and
  // its current appointment, provider, initiating account and assignment read grant.
  if (identity.kind === "company_agent")
    return sql`((${assignmentId}=${identity.execution.assignment.id}
      AND (${revision})::text=${String(identity.execution.assignment.inputRevision)}
      AND ${digest}=${identity.execution.assignment.inputSha256}) OR (${companyEventInputReadPolicy(identity, assignmentId, revision, digest)}))`;

  return sql`EXISTS (
    SELECT 1 FROM specialist_assignments source_assignment
    JOIN specialist_input_revisions source_input ON source_input.assignment_id=source_assignment.id
    WHERE source_assignment.id=${assignmentId} AND source_input.revision::text=(${revision})::text AND source_input.digest=${digest}
      AND (${assignmentInputOwnerReadPolicy(identity, sql`source_assignment.company_id`, sql`source_assignment.project_id`)})
    FOR SHARE OF source_assignment,source_input
  )`;
}

/** An event appointment may share only the producing Run's classified source closure under an explicit current read grant and reviewed limit. */
function companyEventInputReadPolicy(
  identity: Extract<KnowledgePrincipalIdentity, { kind: "company_agent" }>,
  assignmentId: SQL,
  revision: SQL,
  digest: SQL,
): SQL {
  if (!identity.actionLimits.includes("assignments:read")) return sql`false`;

  return sql`EXISTS (
    SELECT 1 FROM runs recipient
    JOIN specialist_run_links appointment ON appointment.run_id=recipient.id
    JOIN specialist_assignments requested ON requested.id=appointment.assignment_id
    JOIN agent_trigger_attempts invocation ON invocation.reserved_run_id=recipient.id
      AND invocation.company_id=recipient.company_id AND invocation.project_id IS NULL
      AND invocation.schedule_id=recipient.agent_schedule_id AND invocation.trigger_source='domain_event'
      AND invocation.trigger_event_id=recipient.trigger_event_id
    JOIN domain_events event ON event.id=invocation.trigger_event_id AND event.company_id=recipient.company_id AND event.project_id IS NULL
    JOIN runs producing ON producing.id=event.run_id AND producing.company_id=recipient.company_id AND producing.project_id IS NULL
    JOIN specialist_input_revisions original ON original.assignment_id=${assignmentId}
      AND original.revision::text=(${revision})::text AND original.digest=${digest}
    JOIN specialist_assignments original_owner ON original_owner.id=original.assignment_id AND original_owner.company_id=recipient.company_id AND original_owner.project_id IS NULL
    JOIN company_grants sharing ON sharing.company_id=recipient.company_id AND sharing.principal_type='agent'
      AND sharing.principal_id=${identity.actor.id} AND sharing.action='assignments:read' AND sharing.revoked_at IS NULL
    WHERE recipient.id=${identity.actor.runId} AND recipient.company_id=${identity.companyId} AND recipient.project_id IS NULL
      AND recipient.trigger_source='domain_event' AND requested.origin->>'kind'='event'
      AND requested.origin->>'subscriptionId'=invocation.schedule_id AND requested.origin->>'eventId'=event.id::text
      AND producing.knowledge_access->>'state'='complete'
      AND producing.knowledge_access->'restrictions' @> jsonb_build_array(jsonb_build_object(
        'kind','assignment_input','assignmentId',original.assignment_id,'inputRevision',original.revision,'inputSha256',original.digest))
    FOR SHARE OF recipient,appointment,requested,invocation,event,producing,original,original_owner,sharing
  )`;
}

/** Current project appointment authorizes its own input; source sharing is checked separately and remains revocable. */
function projectAssignmentInputReadPolicy(
  identity: Extract<KnowledgePrincipalIdentity, { kind: "agent" }>,
  assignmentId: SQL,
  revision: SQL,
  digest: SQL,
): SQL {
  if (identity.actor.runId === null) return sql`false`;
  const appointmentKind =
    identity.actor.attemptId === null
      ? sql`execution.run_kind='agent' AND appointment.role='specialist' AND binding.id=${identity.bindingId} AND role.id=${identity.actor.id}`
      : sql`execution.run_kind='flow' AND appointment.role='coordinator'
          AND original.standing_definition->'schemaVersion'='2'::jsonb
          AND original.standing_definition->'coordinatorFlow'->>'flowId'=execution.flow_id
          AND original.standing_definition->'coordinatorFlow'->>'flowRevisionId'=execution.flow_revision_id
          AND original.standing_definition->'coordinatorFlow'->>'resolvedRevision'=execution.flow_revision
          AND requested.project_task_id=execution.task_id`;

  return sql`EXISTS (
      SELECT 1 FROM specialist_run_links appointment
      JOIN specialist_assignments requested ON requested.id=appointment.assignment_id
      JOIN specialist_input_revisions original ON original.assignment_id=appointment.assignment_id AND original.revision=appointment.input_revision
      JOIN runs execution ON execution.id=appointment.run_id
      JOIN agent_project_links binding ON binding.id=requested.specialist_binding_id AND binding.project_id=requested.project_id
      JOIN agents role ON role.id=binding.agent_id
      JOIN project_package_attachments attachment ON attachment.project_id=binding.project_id AND attachment.package_name=role.package_name
      JOIN package_installs pin ON pin.id=attachment.package_install_id
      JOIN users initiator ON initiator.id=original.actor->>'id'
      WHERE appointment.run_id=${identity.actor.runId} AND (${appointmentKind})
        AND appointment.assignment_id=${assignmentId} AND appointment.input_revision::text=(${revision})::text AND original.digest=${digest}
        AND requested.project_id=${identity.projectId} AND requested.company_id IS NULL
        AND requested.status IN ('active','waiting_input','waiting_children','waiting_resource','reconciling','awaiting_acceptance')
        AND (requested.origin->>'kind'<>'event' OR EXISTS (
          SELECT 1 FROM agent_schedules live_source
          JOIN agent_trigger_attempts live_claim ON live_claim.schedule_id=live_source.id
            AND live_claim.reserved_run_id=execution.id AND live_claim.project_id=requested.project_id
          JOIN domain_events live_event ON live_event.id=live_claim.trigger_event_id AND live_event.project_id=requested.project_id AND live_event.company_id IS NULL
          WHERE live_source.id=requested.origin->>'subscriptionId' AND live_source.project_id=requested.project_id
            AND live_source.agent_id=role.id AND live_source.company_id IS NULL AND live_source.enabled AND live_source.trigger_type='event'
            AND live_source.project_source_review->'schemaVersion'='2'::jsonb
            AND live_claim.binding_snapshot->'review'->'schemaVersion'='2'::jsonb
            AND live_claim.trigger_source='domain_event' AND live_event.id::text=requested.origin->>'eventId'
            AND execution.trigger_source='domain_event' AND execution.trigger_event_id=live_event.id AND execution.agent_schedule_id=live_source.id
            AND (live_event.run_id IS NULL OR (
              live_source.project_source_review->>'sourceSharing'='producing_run'
              AND live_claim.binding_snapshot->'review'->>'sourceSharing'='producing_run'))
          FOR SHARE OF live_source,live_claim,live_event
        ))
        AND binding.enabled AND role.enabled AND role.quarantined_at IS NULL
        AND execution.source_agent_id=role.id
        AND execution.project_id=requested.project_id AND execution.company_id IS NULL
        AND execution.created_by_user_id=initiator.id AND original.actor->>'kind'='user'
        AND requested.requester->>'kind'='user' AND requested.requester->>'id'=initiator.id
        AND initiator.account_status='active' AND NOT initiator.must_change_password
        AND original.standing_definition->>'agentId'=role.id
        AND original.standing_definition->>'packageInstallId'=pin.id
        AND original.standing_definition->>'packageRevision'=pin.resolved_revision
        AND original.standing_definition->>'definitionSha256'=execution.agent_activity_snapshot->>'definitionSha256'
        AND execution.agent_activity_snapshot->>'packageInstallId'=pin.id
        AND pin.package_status='Installed' AND pin.trust_status IN ('trusted','trusted_by_policy')
        AND (initiator.role='admin' OR EXISTS (
          SELECT 1 FROM project_members member
          WHERE member.project_id=requested.project_id AND member.user_id=initiator.id
            AND member.role IN (${sql.join(
              projectRolesForActions(["readBoard", "launchRun"]).map(
                (role) => sql`${role}`,
              ),
              sql`, `,
            )})
          FOR SHARE
        ))
      FOR SHARE OF appointment,requested,original,execution,binding,role,attachment,pin,initiator
    )`;
}

/** Only the producing Run's exact classified inputs are shared with its appointed recipient. */
function projectEventInputReadPolicy(
  identity: Extract<KnowledgePrincipalIdentity, { kind: "agent" }>,
  assignmentId: SQL,
  revision: SQL,
  digest: SQL,
): SQL {
  if (identity.actor.runId === null) return sql`false`;

  return sql`EXISTS (
    SELECT 1 FROM runs event_recipient
    JOIN specialist_run_links event_appointment ON event_appointment.run_id=event_recipient.id
    JOIN specialist_assignments event_work ON event_work.id=event_appointment.assignment_id
    JOIN specialist_input_revisions event_input ON event_input.assignment_id=event_appointment.assignment_id AND event_input.revision=event_appointment.input_revision
    JOIN agent_trigger_attempts event_invocation ON event_invocation.reserved_run_id=event_recipient.id
      AND event_invocation.project_id=event_recipient.project_id AND event_invocation.company_id IS NULL
      AND event_invocation.schedule_id=event_recipient.agent_schedule_id AND event_invocation.trigger_source='domain_event'
      AND event_invocation.trigger_event_id=event_recipient.trigger_event_id
    JOIN domain_events event_fact ON event_fact.id=event_invocation.trigger_event_id AND event_fact.project_id=event_recipient.project_id AND event_fact.company_id IS NULL
    JOIN runs event_producer ON event_producer.id=event_fact.run_id AND event_producer.project_id=event_recipient.project_id AND event_producer.company_id IS NULL
    JOIN specialist_input_revisions event_original ON event_original.assignment_id=${assignmentId} AND event_original.revision::text=(${revision})::text AND event_original.digest=${digest}
    JOIN specialist_assignments event_original_owner ON event_original_owner.id=event_original.assignment_id AND event_original_owner.project_id=event_recipient.project_id AND event_original_owner.company_id IS NULL
    WHERE event_recipient.id=${identity.actor.runId} AND event_recipient.project_id=${identity.projectId} AND event_recipient.company_id IS NULL
      AND event_work.origin->>'kind'='event' AND event_work.origin->>'subscriptionId'=event_invocation.schedule_id
      AND event_work.origin->>'eventId'=event_fact.id::text
      AND event_producer.knowledge_access->>'state'='complete'
      AND event_producer.knowledge_access->'restrictions' @> jsonb_build_array(jsonb_build_object(
        'kind','assignment_input','assignmentId',event_original.assignment_id,'inputRevision',event_original.revision,'inputSha256',event_original.digest))
      AND (${projectAssignmentInputReadPolicy(identity, sql`event_input.assignment_id`, sql`event_input.revision`, sql`event_input.digest`)})
    FOR SHARE OF event_recipient,event_appointment,event_work,event_input,event_invocation,event_fact,event_producer,event_original,event_original_owner
  )`;
}
