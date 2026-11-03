import "server-only";

import type { SQL } from "drizzle-orm";
import type { KnowledgePrincipalIdentity } from "./knowledge-access";

import { sql } from "drizzle-orm";

import { projectRolesForActions } from "@/lib/authz";

/** Execution inputs use repository/context authority independently of the Brain enablement axis. */
export function projectContextReadPolicy(
  identity: KnowledgePrincipalIdentity,
  project: SQL,
): SQL {
  const boundary =
    identity.kind === "user" && identity.boundProjectId !== null
      ? sql`${project}=${identity.boundProjectId}`
      : sql`true`;
  const role =
    identity.kind === "agent"
      ? sql`(${project}=${identity.projectId} OR EXISTS (SELECT 1 FROM agent_project_links context_grant WHERE context_grant.id=${identity.bindingId} AND context_grant.enabled AND context_grant.context_repos @> jsonb_build_array(jsonb_build_object('project',context_source_project.slug)) FOR SHARE))`
      : identity.user.role === "admin"
        ? sql`true`
        : sql`EXISTS (SELECT 1 FROM project_members source_member WHERE source_member.project_id=${project} AND source_member.user_id=${identity.user.id} AND source_member.role IN (${sql.join(
            projectRolesForActions(["readRepoFiles"]).map(
              (value) => sql`${value}`,
            ),
            sql`, `,
          )}) FOR SHARE)`;

  return sql`${boundary} AND EXISTS (SELECT 1 FROM projects context_source_project WHERE context_source_project.id=${project} AND context_source_project.archived_at IS NULL AND (${role}) FOR SHARE)`;
}

/** A role cannot read another role's private notes merely through a shared company/project grant. */
export function agentMemoryReadPolicy(
  identity: KnowledgePrincipalIdentity,
  project: SQL,
  agent: SQL,
): SQL {
  const source =
    identity.kind === "agent"
      ? sql`${agent}=${identity.actor.id} AND source_memory_link.enabled AND source_memory_link.memory_enabled`
      : sql`true`;

  return sql`(${projectContextReadPolicy(identity, project)}) AND EXISTS (SELECT 1 FROM agent_project_links source_memory_link WHERE source_memory_link.project_id=${project} AND source_memory_link.agent_id=${agent} AND (${source}) FOR SHARE)`;
}
