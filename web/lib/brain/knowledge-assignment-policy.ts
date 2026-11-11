import "server-only";

import type { SQL } from "drizzle-orm";
import type { KnowledgePrincipalIdentity } from "./knowledge-access";

import { sql } from "drizzle-orm";

import { MAX_DELEGATION_ANCESTORS } from "@/lib/orchestrator/delegation-spec";
import { projectAssignmentInitiatorPolicy } from "@/lib/specialist-assignments/project-initiator-policy";
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
    return sql`((${projectAssignmentInputReadPolicy(identity, assignmentId, revision, digest)}) OR (${projectEventInputReadPolicy(identity, assignmentId, revision, digest)}) OR (${projectWorkInputReadPolicy(identity, assignmentId, revision, digest)}))`;
  // The server-resolved execution identity already locks this exact input and
  // its current appointment, provider, initiating account and assignment read grant.
  if (identity.kind === "company_agent")
    return sql`((${assignmentId}=${identity.execution.assignment.id}
      AND (${revision})::text=${String(identity.execution.assignment.inputRevision)}
      AND ${digest}=${identity.execution.assignment.inputSha256}) OR (${assignmentId}=${identity.execution.assignment.id} AND specialist_run_has_input(${identity.actor.runId},(${assignmentId})::text,(${revision})::integer,(${digest})::text)) OR (${companyEventInputReadPolicy(identity, assignmentId, revision, digest)}))`;

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

  return projectOriginAssignmentInputReadPolicy(
    {
      runId: sql`${identity.actor.runId}`,
      nodeAttemptId: sql`${identity.actor.attemptId}`,
      projectId: sql`${identity.projectId}`,
      bindingId: sql`${identity.bindingId}`,
      actorId: sql`${identity.actor.id}`,
    },
    assignmentId,
    revision,
    digest,
  );
}

type ProjectAssignmentOrigin = Readonly<{
  runId: SQL;
  nodeAttemptId: SQL;
  projectId: SQL;
  bindingId: SQL;
  actorId: SQL;
}>;

function projectOriginAssignmentInputReadPolicy(
  origin: ProjectAssignmentOrigin,
  assignmentId: SQL,
  revision: SQL,
  digest: SQL,
): SQL {
  const appointmentKind = sql`(
    (${origin.nodeAttemptId}::text IS NULL
      AND execution.run_kind='agent' AND appointment.role='specialist'
      AND binding.id=${origin.bindingId} AND role.id=${origin.actorId})
    OR (${origin.nodeAttemptId}::text IS NOT NULL
      AND execution.run_kind='flow' AND appointment.role='coordinator'
      AND original.standing_definition->'schemaVersion'='2'::jsonb
      AND original.standing_definition->'coordinatorFlow'->>'flowId'=execution.flow_id
      AND original.standing_definition->'coordinatorFlow'->>'flowRevisionId'=execution.flow_revision_id
      AND original.standing_definition->'coordinatorFlow'->>'resolvedRevision'=execution.flow_revision
      AND requested.project_task_id=execution.task_id)
  )`;

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
      WHERE appointment.run_id=${origin.runId} AND (${appointmentKind})
        AND appointment.assignment_id=${assignmentId} AND specialist_run_has_input(execution.id,appointment.assignment_id,(${revision})::integer,(${digest})::text)
        AND requested.project_id=${origin.projectId} AND requested.company_id IS NULL
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
        AND (${projectAssignmentInitiatorPolicy({
          runId: sql`execution.id`,
          createdByUserId: sql`execution.created_by_user_id`,
          projectId: sql`execution.project_id`,
          taskId: sql`execution.task_id`,
          userId: sql`initiator.id`,
          assignmentId: sql`original.assignment_id`,
          inputRevision: sql`original.revision`,
          inputSha256: sql`original.digest`,
        })}) AND original.actor->>'kind'='user'
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

/** Native project children inherit only the exact input appointed to their current installed role. */
function projectWorkInputReadPolicy(
  identity: Extract<KnowledgePrincipalIdentity, { kind: "agent" }>,
  assignmentId: SQL,
  revision: SQL,
  digest: SQL,
): SQL {
  if (identity.actor.runId === null || identity.actor.attemptId !== null)
    return sql`false`;

  const source = projectOriginAssignmentInputReadPolicy(
    {
      runId: sql`origin.parent_run_id`,
      nodeAttemptId: sql`origin.actor->>'attemptId'`,
      projectId: sql`child.project_id`,
      bindingId: sql`root_role.id`,
      actorId: sql`origin.actor->>'id'`,
    },
    assignmentId,
    revision,
    digest,
  );

  return sql`EXISTS (
    SELECT 1
    FROM specialist_run_links link
    JOIN specialist_work work ON work.id=link.work_id AND work.work_revision=link.work_revision
      AND work.assignment_id=link.assignment_id AND work.input_revision=link.input_revision
      AND work.child_run_id=link.run_id AND work.reserved_run_id=link.run_id
    JOIN runs child ON child.id=link.run_id AND child.parent_run_id=work.parent_run_id
    JOIN agent_project_links receiving ON receiving.id=${identity.bindingId}
      AND receiving.agent_id=child.source_agent_id AND receiving.project_id=child.project_id AND receiving.enabled
    JOIN agents recipient_role ON recipient_role.id=receiving.agent_id AND recipient_role.enabled AND recipient_role.quarantined_at IS NULL
    JOIN project_package_attachments attachment ON attachment.project_id=child.project_id AND attachment.package_name=recipient_role.package_name
    JOIN package_installs pin ON pin.id=attachment.package_install_id
    JOIN agent_project_links origin_role ON origin_role.project_id=child.project_id
      AND origin_role.agent_id=work.actor->>'id' AND origin_role.enabled
    JOIN agents origin_catalog ON origin_catalog.id=origin_role.agent_id AND origin_catalog.enabled AND origin_catalog.quarantined_at IS NULL
    WHERE child.id=${identity.actor.runId} AND child.run_kind='agent' AND child.company_id IS NULL
      AND child.project_id=${identity.projectId} AND child.source_agent_id=${identity.actor.id}
      AND link.assignment_id=${assignmentId} AND link.input_revision::text=(${revision})::text
      AND link.role IN ('child','continuation')
      AND specialist_run_has_input(child.id,link.assignment_id,(${revision})::integer,(${digest})::text)
      AND work.input_sha256=${digest} AND work.decision_state<>'cancelled'
      AND work.definition->'target'->>'kind'='project_agent'
      AND work.definition->'target'->>'attachmentId'=receiving.id
      AND work.definition->'target'->'role'->>'agentId'=recipient_role.id
      AND work.definition->'target'->'role'->>'packageInstallId'=pin.id
      AND work.definition->'target'->'role'->>'packageRevision'=pin.resolved_revision
      AND work.definition->'target'->'role'->>'definitionSha256'=child.agent_activity_snapshot->>'definitionSha256'
      AND pin.package_status='Installed' AND pin.trust_status IN ('trusted','trusted_by_policy')
      AND EXISTS (
        WITH RECURSIVE origin(parent_run_id, actor, lineage) AS (
          SELECT work.parent_run_id,work.actor,ARRAY[child.id,work.parent_run_id]
          UNION ALL
          SELECT previous.parent_run_id,previous.actor,origin.lineage||previous.parent_run_id
          FROM origin
          JOIN specialist_work previous ON previous.child_run_id=origin.parent_run_id
            AND previous.assignment_id=work.assignment_id AND previous.decision_state<>'cancelled'
          JOIN runs ancestor ON ancestor.id=previous.child_run_id AND ancestor.parent_run_id=previous.parent_run_id
          WHERE cardinality(origin.lineage)<=${MAX_DELEGATION_ANCESTORS} AND previous.parent_run_id<>ALL(origin.lineage)
            AND ancestor.project_id=child.project_id AND ancestor.source_agent_id=origin.actor->>'id'
            AND specialist_run_has_input(ancestor.id,previous.assignment_id,previous.input_revision,previous.input_sha256)
            AND specialist_work_target_exists(previous.definition->'target',NULL,child.project_id)
        )
        SELECT 1 FROM origin
        JOIN agent_project_links root_role ON root_role.project_id=child.project_id
          AND root_role.agent_id=origin.actor->>'id' AND root_role.enabled
        JOIN agents root_catalog ON root_catalog.id=root_role.agent_id AND root_catalog.enabled AND root_catalog.quarantined_at IS NULL
        WHERE ${source}
        FOR SHARE OF root_role,root_catalog
      )
    FOR SHARE OF link,work,child,receiving,recipient_role,attachment,pin,origin_role,origin_catalog
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
