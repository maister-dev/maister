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
  if (identity.kind === "agent") {
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
