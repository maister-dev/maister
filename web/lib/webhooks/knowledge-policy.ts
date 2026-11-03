import "server-only";

import type { SQL } from "drizzle-orm";

import { sql } from "drizzle-orm";

import { FINDINGS_CONTRACT } from "@/lib/run-results/findings-contract";

/** Project subscriptions carry no receiving knowledge principal; retain only explicit control metadata. */
export function projectWebhookDataSql(runId: SQL, data: SQL): SQL {
  return sql`CASE WHEN EXISTS (
    SELECT 1 FROM runs native_source_run WHERE native_source_run.id=${runId}
      AND (native_source_run.knowledge_access IS NOT NULL
        OR native_source_run.result_contract->>'nativeContract'=${FINDINGS_CONTRACT})
    ) THEN '{"contentState":"source_restricted"}'::jsonb ELSE ${data} END`;
}
