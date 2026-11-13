import "server-only";

import type { SQL } from "drizzle-orm";
import type { KnowledgePrincipalIdentity } from "./knowledge-access";

import { sql } from "drizzle-orm";

export function standEvidenceReadPolicy(
  identity: KnowledgePrincipalIdentity,
  company: SQL,
): SQL {
  if (
    identity.kind === "agent" ||
    (identity.kind === "user" && identity.boundProjectId !== null)
  )
    return sql`false`;
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
