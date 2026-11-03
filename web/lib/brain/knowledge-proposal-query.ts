import "server-only";

import type { SQL } from "drizzle-orm";
import type { KnowledgePrincipalIdentity } from "./knowledge-access";
import type { KnowledgeAction, KnowledgePrincipal } from "./knowledge-types";

import { sql } from "drizzle-orm";

import {
  knowledgeOwnerActionPolicy,
  knowledgeReadPolicyCte,
  knowledgeRevisionReadPolicyCte,
} from "./knowledge-query-policy";

function credentialAllows(
  principal: KnowledgePrincipal,
  action: KnowledgeAction,
): SQL {
  return principal.kind === "user"
    ? sql`true`
    : sql`EXISTS (SELECT 1 FROM project_tokens t WHERE t.id=${principal.tokenId} AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>now()) AND (t.scopes ? '*' OR t.scopes ? ${action}) FOR SHARE)`;
}

function sourceAllows(identity: KnowledgePrincipalIdentity, ref: SQL): SQL {
  const recordPolicy = knowledgeReadPolicyCte(
    identity,
    sql`i.id=${ref}->>'recordId'`,
  );

  return sql`CASE ${ref}->>'kind'
    WHEN 'company' THEN ${knowledgeOwnerActionPolicy(identity, sql`NULL::text`, sql`${ref}->>'companyId'`, "knowledge:read")}
    WHEN 'project' THEN ${knowledgeOwnerActionPolicy(identity, sql`${ref}->>'projectId'`, sql`NULL::text`, "knowledge:read")}
    WHEN 'record' THEN EXISTS (${recordPolicy} SELECT 1 FROM knowledge_readable_records)
    ELSE false END`;
}

/** Inspection is an owner/source read plus current review authority, or the originating principal's propose authority. */
export function knowledgeProposalReadPolicyCte(
  identity: KnowledgePrincipalIdentity,
  principal: KnowledgePrincipal,
  selection: SQL,
): SQL {
  const read = knowledgeOwnerActionPolicy(
    identity,
    sql`p.project_id`,
    sql`p.company_id`,
    "knowledge:read",
  );
  const review = sql`${credentialAllows(principal, "knowledge:review")} AND ${knowledgeOwnerActionPolicy(identity, sql`p.project_id`, sql`p.company_id`, "knowledge:review")}`;
  const propose = sql`p.principal_key=${`${identity.actor.kind}:${identity.actor.id}`} AND ${credentialAllows(principal, "knowledge:propose")} AND ${knowledgeOwnerActionPolicy(identity, sql`p.project_id`, sql`p.company_id`, "knowledge:propose")}`;

  const published = knowledgeRevisionReadPolicyCte(
    identity,
    sql`SELECT p.published_record_id AS record_id,p.published_record_revision AS revision`,
  );

  return sql`WITH knowledge_readable_proposals AS (
    SELECT p.*,CASE WHEN (${review}) THEN 'review' ELSE 'propose' END AS inspection_action
    FROM brain_proposals p WHERE p.kind IN ('knowledge_add','knowledge_correct') AND (${selection}) AND (${read}) AND ((${review}) OR (${propose}))
    AND NOT EXISTS (
      SELECT 1 FROM (
        SELECT ref FROM jsonb_array_elements(coalesce(p.source_restrictions,'[]'::jsonb)) ref
        UNION ALL
        SELECT jsonb_build_object('kind',CASE WHEN o.company_id IS NULL THEN 'project' ELSE 'company' END,CASE WHEN o.company_id IS NULL THEN 'projectId' ELSE 'companyId' END,coalesce(o.company_id,o.project_id))
        FROM jsonb_array_elements(p.draft->'evidence') proof JOIN brain_evidence_witnesses w ON proof->'reference'->>'kind'='witness' AND w.id=proof->'reference'->>'id' JOIN brain_evidence_observations o ON o.id=w.observation_id
        UNION ALL
        SELECT ref FROM jsonb_array_elements(p.draft->'evidence') proof JOIN brain_evidence_witnesses w ON proof->'reference'->>'kind'='witness' AND w.id=proof->'reference'->>'id' CROSS JOIN LATERAL jsonb_array_elements(w.restrictions) ref
      ) source_refs WHERE NOT (${sourceAllows(identity, sql`source_refs.ref`)})
    )
    AND (p.published_record_id IS NULL OR EXISTS (${published} SELECT 1 FROM knowledge_readable_records))
    AND (p.source_restrictions IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p.draft->'evidence') proof LEFT JOIN brain_evidence_witnesses w ON proof->'reference'->>'kind'='witness' AND w.id=proof->'reference'->>'id' WHERE w.id IS NULL
    ))
  )`;
}
