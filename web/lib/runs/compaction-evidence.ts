import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { CompactionMarker } from "@/lib/run-transcript/compaction";

import { sql } from "drizzle-orm";

type Evidence = Pick<CompactionMarker, "before" | "after">;

export async function readCompactionEvidence(
  db: Pick<Db, "execute">,
  runId: string,
  messageIds: readonly string[],
): Promise<ReadonlyMap<string, Evidence>> {
  if (messageIds.length === 0) return new Map();
  const rows = await db.execute<{
    id: string;
    before_usage: Evidence["before"] | null;
    after_usage: Evidence["after"] | null;
  }>(sql`
    SELECT m.id, c.before_usage, c.after_usage
    FROM run_messages m
    JOIN run_context_compactions c ON c.run_id = m.run_id
      AND c.node_attempt_id IS NOT DISTINCT FROM m.node_attempt_id
      AND c.first_run_sequence::text = m.first_supervisor_event_id
    WHERE m.run_id = ${runId} AND m.projection_tool_key LIKE 'compaction:%'
      AND m.id IN (${sql.join(
        messageIds.map((id) => sql`${id}`),
        sql`,`,
      )})
  `);

  return new Map(
    rows.rows.map((row) => [
      row.id,
      {
        ...(row.before_usage ? { before: row.before_usage } : {}),
        ...(row.after_usage ? { after: row.after_usage } : {}),
      },
    ]),
  );
}
