import "server-only";

import type { SQL } from "drizzle-orm";
import type { KnowledgePrincipalIdentity } from "./knowledge-access";
import type { KnowledgeAction } from "./knowledge-types";

import { sql } from "drizzle-orm";

import {
  projectContextReadPolicy,
  projectVisibilityReadPolicy,
  agentMemoryReadPolicy,
  vaultRevisionReferenceQuery,
} from "./knowledge-context-policy";
import {
  assignmentInputReadPolicy,
  assignmentInputOwnerReadPolicy,
} from "./knowledge-assignment-policy";
import { standEvidenceReadPolicy } from "./knowledge-stand-policy";

import { projectRolesForActions } from "@/lib/authz";
import { installationProjectAccess } from "@/lib/agents/installation-authority";

export function knowledgeOwnerActionPolicy(
  identity: KnowledgePrincipalIdentity,
  project: SQL,
  company: SQL,
  action: KnowledgeAction,
): SQL {
  if (identity.kind === "installation_agent") {
    const context = identity.installation;
    if (
      (action !== "knowledge:read" && action !== "knowledge:propose") ||
      !context.scopes.includes(action)
    )
      return sql`false`;
    const companyRights =
      context.principal.kind === "unattended"
        ? sql`true`
        : sql`EXISTS (SELECT 1 FROM company_grants g WHERE company_id=${context.companyId} AND principal_type='user'
        AND principal_id=${context.principal.userId} AND g.action=${action} AND revoked_at IS NULL FOR SHARE)`;
    const projectAction =
      action === "knowledge:read" ? "readBrain" : "writeBrain";

    return sql`((${company}=${context.companyId} AND ${companyRights}) OR EXISTS (
      SELECT 1 FROM projects p WHERE p.id=${project} AND p.archived_at IS NULL AND p.brain_enabled
      AND ${installationProjectAccess(context, sql`p.id`, projectAction)} FOR SHARE))`;
  }
  if (identity.kind === "company_agent") {
    const allowed =
      (action === "knowledge:read" || action === "knowledge:propose") &&
      identity.actionLimits.includes(action);

    return sql`${allowed} AND coalesce(${company}=${identity.companyId},false)
      AND EXISTS (SELECT 1 FROM company_grants cg WHERE cg.company_id=${identity.companyId} AND cg.principal_type='agent' AND cg.principal_id=${identity.actor.id} AND cg.action=${action} AND cg.revoked_at IS NULL FOR SHARE)
      AND EXISTS (SELECT 1 FROM company_grants initiating_grant WHERE initiating_grant.company_id=${identity.companyId} AND initiating_grant.principal_type='user' AND initiating_grant.principal_id=${identity.initiatingUser.id} AND initiating_grant.action=${action} AND initiating_grant.revoked_at IS NULL FOR SHARE)`;
  }
  if (identity.kind === "user" && identity.boundProjectId !== null) {
    const projectPolicy = knowledgeOwnerActionPolicy(
      { ...identity, boundProjectId: null },
      project,
      sql`NULL::text`,
      action,
    );

    return sql`${project}=${identity.boundProjectId} AND (${projectPolicy})`;
  }
  const companyPolicy = sql`coalesce(${company} IN (SELECT cg.company_id FROM company_grants cg WHERE cg.principal_type=${identity.actor.kind} AND cg.principal_id=${identity.actor.id} AND cg.action=${action} AND cg.revoked_at IS NULL FOR SHARE),false)`;
  const projectAction =
    action === "knowledge:read"
      ? "readBrain"
      : action === "knowledge:propose"
        ? "writeBrain"
        : "editSettings";
  const agentAllowed =
    identity.kind === "agent" &&
    (action === "knowledge:read"
      ? identity.canReadBrain
      : action === "knowledge:propose"
        ? identity.canWriteBrain
        : false);
  const projectPolicy =
    identity.kind === "agent"
      ? sql`${project}=${identity.projectId} AND ${agentAllowed} AND EXISTS (SELECT 1 FROM projects knowledge_owner_project WHERE knowledge_owner_project.id=${identity.projectId} AND knowledge_owner_project.brain_enabled FOR SHARE)`
      : sql`coalesce(${project} IN (
      SELECT knowledge_owner_project.id FROM projects knowledge_owner_project WHERE knowledge_owner_project.brain_enabled AND (${
        identity.user.role === "admin"
          ? sql`true`
          : sql`knowledge_owner_project.id IN (
          SELECT pm.project_id FROM project_members pm WHERE pm.user_id=${identity.user.id} AND pm.role IN (${sql.join(
            projectRolesForActions([projectAction]).map((role) => sql`${role}`),
            sql`, `,
          )}) FOR SHARE
        )`
      }) FOR SHARE
    ),false)`;

  return sql`((${company} IS NOT NULL AND ${companyPolicy}) OR (${project} IS NOT NULL AND (${projectPolicy})))`;
}

function readableOwner(
  identity: KnowledgePrincipalIdentity,
  project: SQL,
  company: SQL,
): SQL {
  return knowledgeOwnerActionPolicy(
    identity,
    project,
    company,
    "knowledge:read",
  );
}

function readableRecord(
  identity: KnowledgePrincipalIdentity,
  alias: "i" | "r",
): SQL {
  const table = sql.identifier(alias);

  const initiatingRecordGrant =
    identity.kind === "company_agent"
      ? sql`EXISTS (SELECT 1 FROM brain_record_grants initiating_record_grant WHERE initiating_record_grant.record_id=${table}.id AND initiating_record_grant.principal_type='user' AND initiating_record_grant.principal_id=${identity.initiatingUser.id} AND initiating_record_grant.action='knowledge:read' AND initiating_record_grant.revoked_at IS NULL FOR SHARE)`
      : identity.kind === "installation_agent" &&
          identity.installation.principal.kind === "manual"
        ? sql`EXISTS (SELECT 1 FROM brain_record_grants g WHERE g.record_id=${table}.id AND g.principal_type='user'
          AND g.principal_id=${identity.installation.principal.userId} AND g.action='knowledge:read' AND g.revoked_at IS NULL FOR SHARE)`
        : sql`true`;

  return sql`${readableOwner(identity, sql`${table}.project_id`, sql`${table}.company_id`)} AND (${table}.visibility='owner_grants' OR (${initiatingRecordGrant} AND EXISTS (SELECT 1 FROM brain_record_grants rg WHERE rg.record_id=${table}.id AND rg.principal_type=${identity.actor.kind} AND rg.principal_id=${identity.actor.id} AND rg.action='knowledge:read' AND rg.revoked_at IS NULL FOR SHARE)))`;
}

/** Apply source closure before LIMIT/cursors so inaccessible records cannot consume public page slots. */
export function knowledgeReadPolicyCte(
  identity: KnowledgePrincipalIdentity,
  selection: SQL,
): SQL {
  return knowledgeRevisionReadPolicyCte(
    identity,
    sql`SELECT i.id AS record_id,i.current_revision AS revision FROM brain_items i WHERE ${selection}`,
  );
}

function sourceIdentity(reference: SQL): SQL {
  return sql`CASE ${reference}->>'kind'
    WHEN 'company' THEN ${reference}->>'companyId'
    WHEN 'stand_target' THEN ${reference}->>'companyId'
    WHEN 'project' THEN ${reference}->>'projectId'
    WHEN 'project_context' THEN ${reference}->>'projectId'
    WHEN 'project_visibility' THEN ${reference}->>'projectId'
    WHEN 'legacy_project_private' THEN ${reference}->>'projectId'
    WHEN 'agent_memory' THEN ${reference}::text
    WHEN 'agent_vault_revision_v1' THEN ${reference}::text
    WHEN 'assignment_input' THEN ${reference}::text
    WHEN 'record' THEN ${reference}->>'recordId' END`;
}

/** Both record revisions and exact assignment inputs contribute immutable source edges. */
function sourceDependencyJoins(identity: KnowledgePrincipalIdentity): SQL {
  const assignment = sql`CASE WHEN d.kind='assignment_input' THEN d.identity::jsonb ELSE '{}'::jsonb END`;
  const vaultRevision = sql`CASE WHEN d.kind='agent_vault_revision_v1' THEN d.identity::jsonb ELSE '{}'::jsonb END`;

  return sql`CROSS JOIN LATERAL (
    SELECT record_child.kind,record_child.identity,record_child.revision
    FROM brain_items r JOIN brain_record_revisions v ON v.record_id=r.id AND v.revision=coalesce(d.revision,r.current_revision)
    CROSS JOIN LATERAL (
      SELECT CASE WHEN r.project_id IS NULL THEN 'company' ELSE 'project' END AS kind,coalesce(r.project_id,r.company_id) AS identity,NULL::integer AS revision
      UNION ALL
      SELECT ref->>'kind',${sourceIdentity(sql`ref`)},NULL::integer
      FROM native_knowledge_source_restrictions(coalesce(v.source_restrictions,'[]'::jsonb)) ref
      UNION ALL
      SELECT ref->>'kind',${sourceIdentity(sql`ref`)},NULL::integer
      FROM brain_revision_evidence e CROSS JOIN LATERAL native_knowledge_source_restrictions(coalesce(e.witness_snapshot->'restrictions','[]'::jsonb)) ref
      WHERE e.record_id=r.id AND e.revision=v.revision
    ) record_child WHERE d.kind='record' AND r.id=d.identity
    UNION ALL
    SELECT ref->>'kind',${sourceIdentity(sql`ref`)},NULL::integer
    FROM specialist_input_revisions retained_input
    CROSS JOIN LATERAL native_knowledge_source_restrictions(coalesce(retained_input.source_restrictions,'[]'::jsonb)) ref
    WHERE d.kind='assignment_input' AND retained_input.assignment_id=(${assignment})->>'assignmentId'
      AND retained_input.revision::text=(${assignment})->>'inputRevision'
      AND retained_input.digest=(${assignment})->>'inputSha256'
    UNION ALL
    SELECT vault_child.kind, vault_child.identity, NULL::integer
    FROM (${vaultRevisionReferenceQuery(identity, vaultRevision)}) source
    CROSS JOIN LATERAL (
      SELECT CASE WHEN source.installation THEN 'project_visibility' ELSE 'project_context' END AS kind, project_id AS identity FROM unnest(source.source_project_ids) project_id
      UNION ALL
      SELECT ref->>'kind', ${sourceIdentity(sql`ref`)}
      FROM native_knowledge_source_restrictions(source.source_restrictions) ref
    ) vault_child
  ) child`;
}

function sourceDependencyPolicy(identity: KnowledgePrincipalIdentity): SQL {
  return sql`coalesce((CASE d.kind
    WHEN 'company' THEN ${readableOwner(identity, sql`NULL::text`, sql`d.identity`)}
    WHEN 'project' THEN ${readableOwner(identity, sql`d.identity`, sql`NULL::text`)}
    WHEN 'project_context' THEN ${projectContextReadPolicy(identity, sql`d.identity`)}
    WHEN 'project_visibility' THEN ${projectVisibilityReadPolicy(identity, sql`d.identity`)}
    WHEN 'legacy_project_private' THEN ${projectContextReadPolicy(identity, sql`d.identity`)}
    WHEN 'stand_target' THEN ${standEvidenceReadPolicy(identity, sql`d.identity`)}
    WHEN 'agent_memory' THEN ${agentMemoryReadPolicy(identity, sql`(d.identity::jsonb)->>'projectId'`, sql`(d.identity::jsonb)->>'agentId'`)}
    WHEN 'agent_vault_revision_v1' THEN EXISTS (${vaultRevisionReferenceQuery(identity, sql`d.identity::jsonb`)})
    WHEN 'assignment_input' THEN ${
      identity.kind === "user"
        ? sql`((d.identity::jsonb)->>'assignmentId',(d.identity::jsonb)->>'inputRevision',(d.identity::jsonb)->>'inputSha256') IN (SELECT assignment_id,revision::text,digest FROM knowledge_authorized_assignment_dependencies)`
        : assignmentInputReadPolicy(
            identity,
            sql`(d.identity::jsonb)->>'assignmentId'`,
            sql`(d.identity::jsonb)->>'inputRevision'`,
            sql`(d.identity::jsonb)->>'inputSha256'`,
          )
    }
    WHEN 'record' THEN CASE WHEN d.revision IS NULL
      THEN d.identity IN (SELECT record_id FROM knowledge_authorized_record_dependencies WHERE current_reference)
      ELSE (d.identity,d.revision) IN (SELECT record_id,revision FROM knowledge_authorized_record_dependencies) END
    ELSE false END),false)`;
}

/** Authorize each referenced record/revision once rather than replanning correlated grants for every recursive edge. */
function authorizedRecordDependencies(
  identity: KnowledgePrincipalIdentity,
  dependencies: SQL,
): SQL {
  return sql`knowledge_authorized_record_dependencies AS MATERIALIZED (
    SELECT DISTINCT r.id AS record_id,v.revision,(requested.revision IS NULL) AS current_reference FROM ${dependencies} requested
    JOIN brain_items r ON requested.kind='record' AND r.id=requested.identity
    JOIN brain_record_revisions v ON v.record_id=r.id AND v.revision=coalesce(requested.revision,r.current_revision)
    WHERE ${readableRecord(identity, "r")}
  )`;
}

function authorizedAssignmentDependencies(
  identity: KnowledgePrincipalIdentity,
  dependencies: SQL,
): SQL {
  if (identity.kind !== "user")
    return sql`knowledge_authorized_assignment_dependencies AS (SELECT NULL::text AS assignment_id,NULL::integer AS revision,NULL::text AS digest WHERE false)`;
  const reference = sql`CASE WHEN requested.kind='assignment_input' THEN requested.identity::jsonb ELSE '{}'::jsonb END`;

  return sql`knowledge_authorized_assignment_dependencies AS MATERIALIZED (
    SELECT input.assignment_id,input.revision,input.digest FROM specialist_input_revisions input
    JOIN specialist_assignments assignment ON assignment.id=input.assignment_id
    WHERE (input.assignment_id,input.revision::text,input.digest) IN (
      SELECT (${reference})->>'assignmentId',(${reference})->>'inputRevision',(${reference})->>'inputSha256' FROM ${dependencies} requested WHERE requested.kind='assignment_input'
    ) AND (${assignmentInputOwnerReadPolicy(identity, sql`assignment.company_id`, sql`assignment.project_id`)})
    FOR SHARE OF input,assignment
  )`;
}

/** Proposal source inspection uses the same closure as record retrieval, including inherited assignment restrictions. */
export function knowledgeSourceReadPolicy(
  identity: KnowledgePrincipalIdentity,
  reference: SQL,
): SQL {
  return sql`(WITH RECURSIVE knowledge_source_dependencies(kind,identity,revision) AS (
    SELECT ${reference}->>'kind',${sourceIdentity(reference)},NULL::integer
    UNION
    SELECT child.kind,child.identity,child.revision FROM knowledge_source_dependencies d ${sourceDependencyJoins(identity)}
  ), ${authorizedRecordDependencies(identity, sql`knowledge_source_dependencies`)}, ${authorizedAssignmentDependencies(identity, sql`knowledge_source_dependencies`)}
  SELECT NOT EXISTS (SELECT 1 FROM knowledge_source_dependencies d WHERE NOT (${sourceDependencyPolicy(identity)})))`;
}

/** Both the current policy head and the selected immutable revision constrain historical disclosure. */
export function knowledgeRevisionReadPolicyCte(
  identity: KnowledgePrincipalIdentity,
  candidates: SQL,
): SQL {
  return sql`WITH RECURSIVE knowledge_requested_revisions AS (${candidates}), knowledge_candidates AS (
    SELECT DISTINCT i.*,c.revision AS selected_revision FROM knowledge_requested_revisions c JOIN brain_items i ON i.id=c.record_id
    WHERE ${readableRecord(identity, "i")}
  ), knowledge_access_dependencies(root_id,root_revision,kind,identity,revision) AS (
    (SELECT id,selected_revision,'record'::text,id,current_revision FROM knowledge_candidates
     UNION SELECT id,selected_revision,'record'::text,id,selected_revision FROM knowledge_candidates)
    UNION
    SELECT d.root_id,d.root_revision,child.kind,child.identity,child.revision FROM knowledge_access_dependencies d ${sourceDependencyJoins(identity)}
  ), ${authorizedRecordDependencies(identity, sql`knowledge_access_dependencies`)}, ${authorizedAssignmentDependencies(identity, sql`knowledge_access_dependencies`)}, knowledge_readable_records AS (
    SELECT i.* FROM knowledge_candidates i WHERE NOT EXISTS (
      SELECT 1 FROM knowledge_access_dependencies d WHERE d.root_id=i.id AND d.root_revision=i.selected_revision AND NOT (${sourceDependencyPolicy(identity)})
    )
  )`;
}
