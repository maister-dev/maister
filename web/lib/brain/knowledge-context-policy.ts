import "server-only";

import type { SQL } from "drizzle-orm";
import type { KnowledgePrincipalIdentity } from "./knowledge-access";

import { sql } from "drizzle-orm";

import { projectRolesForActions } from "@/lib/authz";
import { installationProjectAccess } from "@/lib/agents/installation-authority";

/** Execution inputs use repository/context authority independently of the Brain enablement axis. */
export function projectContextReadPolicy(
  identity: KnowledgePrincipalIdentity,
  project: SQL,
): SQL {
  if (identity.kind === "company_agent") return sql`false`;
  if (identity.kind === "installation_agent")
    return sql`EXISTS (SELECT 1 FROM projects p
    WHERE p.id=${project} AND p.archived_at IS NULL AND ${installationProjectAccess(identity.installation, sql`p.id`, "readRepoFiles")} FOR SHARE)`;
  const boundary =
    identity.kind === "user" && identity.boundProjectId !== null
      ? sql`${project}=${identity.boundProjectId}`
      : sql`true`;
  const role =
    identity.kind === "agent"
      ? sql`(context_source_project.id=${identity.projectId} OR EXISTS (SELECT 1 FROM agent_project_links context_grant WHERE context_grant.id=${identity.bindingId} AND context_grant.enabled AND context_grant.context_repos @> jsonb_build_array(jsonb_build_object('project',context_source_project.slug)) FOR SHARE))`
      : identity.user.role === "admin"
        ? sql`true`
        : sql`context_source_project.id IN (SELECT source_member.project_id FROM project_members source_member WHERE source_member.user_id=${identity.user.id} AND source_member.role IN (${sql.join(
            projectRolesForActions(["readRepoFiles"]).map(
              (value) => sql`${value}`,
            ),
            sql`, `,
          )}) FOR SHARE)`;

  return sql`${boundary} AND coalesce(${project} IN (SELECT context_source_project.id FROM projects context_source_project WHERE context_source_project.archived_at IS NULL AND (${role}) FOR SHARE),false)`;
}

/** Installation list metadata needs the same current board visibility as its original disclosure. */
export function projectVisibilityReadPolicy(
  identity: KnowledgePrincipalIdentity,
  project: SQL,
): SQL {
  if (identity.kind === "installation_agent")
    return sql`EXISTS (SELECT 1 FROM projects p WHERE p.id=${project} AND p.archived_at IS NULL
      AND ${installationProjectAccess(identity.installation, sql`p.id`, "readBoard")} FOR SHARE)`;
  if (identity.kind === "agent") return sql`${project}=${identity.projectId}`;
  if (identity.kind !== "user") return sql`false`;
  const user = identity.user;

  if (user.role === "admin" && identity.boundProjectId === null)
    return sql`true`;
  const roles = sql.join(
    projectRolesForActions(["readBoard"]).map((role) => sql`${role}`),
    sql`, `,
  );
  const bound = identity.boundProjectId
    ? sql`AND m.project_id=${identity.boundProjectId}`
    : sql``;

  return sql`EXISTS (SELECT 1 FROM project_members m JOIN projects visibility_project
      ON visibility_project.id=m.project_id AND visibility_project.archived_at IS NULL
    WHERE m.project_id=${project} AND m.user_id=${user.id} AND m.role IN (${roles}) ${bound}
    FOR SHARE OF m,visibility_project)`;
}

/** A role cannot read another role's private notes merely through a shared company/project grant. */
export function agentMemoryReadPolicy(
  identity: KnowledgePrincipalIdentity,
  project: SQL,
  agent: SQL,
): SQL {
  if (
    identity.kind === "company_agent" ||
    identity.kind === "installation_agent"
  )
    return sql`false`;
  const source =
    identity.kind === "agent"
      ? sql`source_memory_link.agent_id=${identity.actor.id} AND source_memory_link.enabled AND source_memory_link.memory_enabled`
      : sql`true`;

  return sql`(${projectContextReadPolicy(identity, project)}) AND coalesce((${project},${agent}) IN (SELECT source_memory_link.project_id,source_memory_link.agent_id FROM agent_project_links source_memory_link WHERE (${source}) FOR SHARE),false)`;
}

/** Match the retained identity and live payload before authorizing a derived disclosure. */
export function vaultRevisionReferenceQuery(
  identity: KnowledgePrincipalIdentity,
  reference: SQL,
): SQL {
  const companyAuthority =
    identity.kind === "installation_agent"
      ? sql`vault.company_id=${identity.installation.companyId} AND vault.agent_id=${identity.installation.agentId} AND ${identity.installation.memoryEnabled}`
      : identity.kind === "user" && identity.boundProjectId === null
        ? identity.user.role === "admin"
          ? sql`true`
          : sql`EXISTS (SELECT 1 FROM company_grants g WHERE g.company_id=vault.company_id AND g.principal_type='user'
          AND g.principal_id=${identity.user.id} AND g.action='specialists:read' AND g.revoked_at IS NULL FOR SHARE)`
        : sql`false`;
  const installationPolicy = sql`vault.company_id IS NOT NULL AND (${companyAuthority}) AND EXISTS (
    SELECT 1 FROM company_specialist_bindings b JOIN company_specialist_binding_revisions v
      ON (v.binding_id,v.revision)=(b.id,b.revision)
    WHERE b.company_id=vault.company_id AND b.agent_id=vault.agent_id AND b.detached_at IS NULL
      AND v.snapshot->'installationGrant'->>'reach'='active_projects' FOR SHARE OF b,v)`;

  return sql`
    SELECT revision.source_project_ids, revision.source_restrictions, vault.company_id IS NOT NULL AS installation
    FROM agent_memory_revisions revision
    JOIN agent_memory_vaults vault ON vault.id=revision.vault_id
    JOIN agent_memory_revision_payloads payload
      ON (payload.vault_id,payload.note_id,payload.revision_id) =
         (revision.vault_id,revision.note_id,revision.id)
    WHERE revision.vault_id=${reference}->>'vaultId'
      AND revision.note_id=${reference}->>'noteId'
      AND revision.id=${reference}->>'revisionId'
      AND revision.content_sha256=${reference}->>'contentSha256'
      AND ((${agentMemoryReadPolicy(identity, sql`vault.project_id`, sql`vault.agent_id`)}) OR (${installationPolicy}))
    FOR SHARE OF payload
  `;
}
