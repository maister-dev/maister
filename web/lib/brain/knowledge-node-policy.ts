import type { SQL } from "drizzle-orm";

import { sql } from "drizzle-orm";

/** A completed action can still own post-action work; a newer attempt or node transition fences its credential. */
export function currentKnowledgeNodeAttemptPolicy(
  alias: string,
  runId: SQL,
  nodeId: SQL,
): SQL {
  const node = sql.identifier(alias);

  return sql`${node}.run_id=${runId} AND ${node}.node_id=${nodeId}
    AND ${node}.status IN ('Running','NeedsInput','Succeeded')
    AND NOT EXISTS (SELECT 1 FROM node_attempts newer_knowledge_attempt WHERE newer_knowledge_attempt.run_id=${node}.run_id AND newer_knowledge_attempt.node_id=${node}.node_id AND newer_knowledge_attempt.attempt>${node}.attempt)`;
}
