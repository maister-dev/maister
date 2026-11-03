import "server-only";

import { sql, type SQL } from "drizzle-orm";

export function knowledgeConflictEdges(
  recordId: string,
  revision: number,
): SQL {
  return sql`SELECT e.id AS edge_id,e.claim_state AS classification,e.created_at,
    CASE WHEN e.from_ref->>'id'=${recordId} THEN e.to_ref->>'id' ELSE e.from_ref->>'id' END AS record_id,
    CASE WHEN e.from_ref->>'id'=${recordId} THEN e.to_revision ELSE e.from_revision END AS revision
    FROM brain_edges e WHERE e.claim_state IS NOT NULL AND ((e.from_ref->>'id'=${recordId} AND e.from_revision=${revision}) OR (e.to_ref->>'id'=${recordId} AND e.to_revision=${revision}))`;
}
