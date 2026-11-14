import "server-only";

import type { SQL } from "drizzle-orm";
import type { KnowledgePrincipalIdentity } from "./knowledge-access";

import { sql } from "drizzle-orm";

import { assignmentInputReadPolicy } from "./knowledge-assignment-policy";

export function standEvidenceReadPolicy(
  identity: KnowledgePrincipalIdentity,
  company: SQL,
): SQL {
  if (identity.kind === "user" && identity.boundProjectId !== null)
    return sql`false`;
  if (identity.kind === "agent") {
    if (identity.actor.runId === null) return sql`false`;

    return sql`EXISTS (
      SELECT 1 FROM specialist_run_links link
      JOIN specialist_assignments subject ON subject.id=link.assignment_id
      JOIN specialist_input_revisions original ON original.assignment_id=link.assignment_id AND original.revision=link.input_revision
      JOIN specialist_input_revisions current_input ON current_input.assignment_id=subject.id AND current_input.revision=subject.input_revision
      JOIN agents professional ON professional.id=${identity.actor.id}
      JOIN stand_targets target ON target.company_id=${company} AND target.enabled
        AND current_input.objective_input->'targetIds' ? target.id
      WHERE link.run_id=${identity.actor.runId} AND subject.project_id=${identity.projectId}
        AND professional.specialist->'targetClasses' ? 'stand'
        AND (${assignmentInputReadPolicy(identity, sql`subject.id`, sql`current_input.revision`, sql`current_input.digest`)})
        AND EXISTS (SELECT 1 FROM company_grants evidence_reader
          WHERE evidence_reader.company_id=target.company_id AND evidence_reader.principal_type='user'
            AND evidence_reader.principal_id=original.actor->>'id' AND evidence_reader.action='targets:read'
            AND original.actor->>'kind'='user' AND evidence_reader.revoked_at IS NULL FOR SHARE)
        AND EXISTS (SELECT 1 FROM company_grants evidence_role
          WHERE evidence_role.company_id=target.company_id AND evidence_role.principal_type='agent'
            AND evidence_role.principal_id=professional.id AND evidence_role.action='targets:read'
            AND evidence_role.revoked_at IS NULL FOR SHARE)
      FOR SHARE OF link,subject,original,current_input,professional,target
    )`;
  }
  const userId =
    identity.kind === "user" ? identity.user.id : identity.initiatingUser.id;
  const userGrant = sql`EXISTS (SELECT 1 FROM company_grants evidence_reader
    WHERE evidence_reader.company_id=${company} AND evidence_reader.principal_type='user'
      AND evidence_reader.principal_id=${userId} AND evidence_reader.action='targets:read'
      AND evidence_reader.revoked_at IS NULL FOR SHARE)`;

  if (identity.kind === "user") return userGrant;
  if (!identity.actionLimits.includes("targets:read")) return sql`false`;

  return sql`${company}=${identity.companyId} AND ${userGrant} AND EXISTS (
    SELECT 1 FROM company_grants evidence_role WHERE evidence_role.company_id=${company}
      AND evidence_role.principal_type='agent' AND evidence_role.principal_id=${identity.actor.id}
      AND evidence_role.action='targets:read' AND evidence_role.revoked_at IS NULL FOR SHARE)`;
}
