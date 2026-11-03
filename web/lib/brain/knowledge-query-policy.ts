import "server-only";

import type { SQL } from "drizzle-orm";
import type { KnowledgePrincipalIdentity } from "./knowledge-access";
import type { KnowledgeAction } from "./knowledge-types";

import { sql } from "drizzle-orm";

import { projectRolesForActions } from "@/lib/authz";

export function knowledgeOwnerActionPolicy(
  identity: KnowledgePrincipalIdentity,
  project: SQL,
  company: SQL,
  action: KnowledgeAction,
): SQL {
  if (identity.kind === "user" && identity.boundProjectId !== null) {
    const projectPolicy = knowledgeOwnerActionPolicy(
      { ...identity, boundProjectId: null },
      project,
      sql`NULL::text`,
      action,
    );

    return sql`${project}=${identity.boundProjectId} AND (${projectPolicy})`;
  }
  const companyPolicy = sql`EXISTS (SELECT 1 FROM company_grants cg WHERE cg.company_id=${company} AND cg.principal_type=${identity.actor.kind} AND cg.principal_id=${identity.actor.id} AND cg.action=${action} AND cg.revoked_at IS NULL FOR SHARE)`;
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
  const projectRole =
    identity.kind === "agent"
      ? sql`${project}=${identity.projectId} AND ${agentAllowed}`
      : identity.user.role === "admin"
        ? sql`true`
        : sql`EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id=${project} AND pm.user_id=${identity.user.id} AND pm.role IN (${sql.join(
            projectRolesForActions([projectAction]).map((role) => sql`${role}`),
            sql`, `,
          )}) FOR SHARE)`;

  return sql`((${company} IS NOT NULL AND ${companyPolicy}) OR (${project} IS NOT NULL AND EXISTS (SELECT 1 FROM projects knowledge_owner_project WHERE knowledge_owner_project.id=${project} AND knowledge_owner_project.brain_enabled AND (${projectRole}) FOR SHARE)))`;
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

  return sql`${readableOwner(identity, sql`${table}.project_id`, sql`${table}.company_id`)} AND (${table}.visibility='owner_grants' OR EXISTS (SELECT 1 FROM brain_record_grants rg WHERE rg.record_id=${table}.id AND rg.principal_type=${identity.actor.kind} AND rg.principal_id=${identity.actor.id} AND rg.action='knowledge:read' AND rg.revoked_at IS NULL FOR SHARE))`;
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

/** Both the current policy head and the selected immutable revision constrain historical disclosure. */
export function knowledgeRevisionReadPolicyCte(
  identity: KnowledgePrincipalIdentity,
  candidates: SQL,
): SQL {
  const dependencyPolicy = sql`CASE d.kind
    WHEN 'company' THEN ${readableOwner(identity, sql`NULL::text`, sql`d.identity`)}
    WHEN 'project' THEN ${readableOwner(identity, sql`d.identity`, sql`NULL::text`)}
    WHEN 'record' THEN EXISTS (SELECT 1 FROM brain_items r WHERE r.id=d.identity AND ${readableRecord(identity, "r")} AND (d.revision IS NULL OR EXISTS (SELECT 1 FROM brain_record_revisions v WHERE v.record_id=r.id AND v.revision=d.revision)))
    ELSE false END`;

  return sql`WITH RECURSIVE knowledge_requested_revisions AS (${candidates}), knowledge_candidates AS (
    SELECT DISTINCT i.*,c.revision AS selected_revision FROM knowledge_requested_revisions c JOIN brain_items i ON i.id=c.record_id
    WHERE ${readableRecord(identity, "i")}
  ), knowledge_access_dependencies(root_id,root_revision,kind,identity,revision) AS (
    (SELECT id,selected_revision,'record'::text,id,current_revision FROM knowledge_candidates
     UNION SELECT id,selected_revision,'record'::text,id,selected_revision FROM knowledge_candidates)
    UNION
    SELECT d.root_id,d.root_revision,child.kind,child.identity,child.revision FROM knowledge_access_dependencies d
    JOIN brain_items r ON d.kind='record' AND r.id=d.identity
    JOIN brain_record_revisions v ON v.record_id=r.id AND v.revision=coalesce(d.revision,r.current_revision)
    CROSS JOIN LATERAL (
      SELECT CASE WHEN r.project_id IS NULL THEN 'company' ELSE 'project' END AS kind,coalesce(r.project_id,r.company_id) AS identity,NULL::integer AS revision
      UNION ALL
      SELECT ref->>'kind',CASE ref->>'kind' WHEN 'company' THEN ref->>'companyId' WHEN 'project' THEN ref->>'projectId' WHEN 'record' THEN ref->>'recordId' END,NULL::integer
      FROM jsonb_array_elements(coalesce(v.source_restrictions,'[]'::jsonb)) ref
      UNION ALL
      SELECT ref->>'kind',CASE ref->>'kind' WHEN 'company' THEN ref->>'companyId' WHEN 'project' THEN ref->>'projectId' WHEN 'record' THEN ref->>'recordId' END,NULL::integer
      FROM brain_revision_evidence e CROSS JOIN LATERAL jsonb_array_elements(coalesce(e.witness_snapshot->'restrictions','[]'::jsonb)) ref
      WHERE e.record_id=r.id AND e.revision=v.revision
    ) child
  ), knowledge_readable_records AS (
    SELECT i.* FROM knowledge_candidates i WHERE NOT EXISTS (
      SELECT 1 FROM knowledge_access_dependencies d WHERE d.root_id=i.id AND d.root_revision=i.selected_revision AND NOT (${dependencyPolicy})
    )
  )`;
}
