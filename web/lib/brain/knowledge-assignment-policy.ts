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
  if (identity.kind === "agent") return sql`false`;
  // The server-resolved execution identity already locks this exact input and
  // its current appointment, provider, initiating account and assignment read grant.
  if (identity.kind === "company_agent")
    return sql`${assignmentId}=${identity.execution.assignment.id}
      AND (${revision})::text=${String(identity.execution.assignment.inputRevision)}
      AND ${digest}=${identity.execution.assignment.inputSha256}`;

  return sql`EXISTS (
    SELECT 1 FROM specialist_assignments source_assignment
    JOIN specialist_input_revisions source_input ON source_input.assignment_id=source_assignment.id
    WHERE source_assignment.id=${assignmentId} AND source_input.revision::text=(${revision})::text AND source_input.digest=${digest}
      AND (${assignmentInputOwnerReadPolicy(identity, sql`source_assignment.company_id`, sql`source_assignment.project_id`)})
    FOR SHARE OF source_assignment,source_input
  )`;
}
