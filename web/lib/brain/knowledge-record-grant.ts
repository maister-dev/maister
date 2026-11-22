import "server-only";

import type { KnowledgeAuthorityActor } from "./knowledge-access";
import type { KnowledgeAction } from "./knowledge-types";

import { sql, type SQL } from "drizzle-orm";

export function knowledgeRecordGrant(
  recordId: SQL,
  actor: Pick<KnowledgeAuthorityActor, "kind" | "id">,
  action: KnowledgeAction,
): SQL {
  return sql`EXISTS (
    SELECT 1 FROM brain_record_grants grant_row
    WHERE grant_row.record_id=${recordId} AND grant_row.principal_type=${actor.kind}
      AND grant_row.principal_id=${actor.id} AND grant_row.action=${action}
      AND grant_row.revoked_at IS NULL FOR SHARE
  )`;
}
