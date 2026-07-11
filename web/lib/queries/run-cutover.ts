import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { and, desc, eq, sql } from "drizzle-orm";

import * as schema from "@/lib/db/schema";
import {
  GRAPH_ONLY_CUTOVER_REASON,
  GRAPH_ONLY_CUTOVER_SOURCE,
} from "@/lib/domain-events/cutover";

export type GraphOnlyCutoverFailure = {
  occurredAt: Date;
  reason: typeof GRAPH_ONLY_CUTOVER_REASON;
};

export async function getGraphOnlyCutoverFailure(
  client: NodePgDatabase<typeof schema>,
  runId: string,
): Promise<GraphOnlyCutoverFailure | null> {
  const rows = await client
    .select({ occurredAt: schema.domainEvents.createdAt })
    .from(schema.domainEvents)
    .where(
      and(
        eq(schema.domainEvents.runId, runId),
        eq(schema.domainEvents.kind, "run.failed"),
        sql`${schema.domainEvents.payload}->>'reason' = ${GRAPH_ONLY_CUTOVER_REASON}`,
        sql`${schema.domainEvents.payload}->>'source' = ${GRAPH_ONLY_CUTOVER_SOURCE}`,
      ),
    )
    .orderBy(desc(schema.domainEvents.createdAt))
    .limit(1);

  return rows[0]
    ? {
        occurredAt: rows[0].occurredAt,
        reason: GRAPH_ONLY_CUTOVER_REASON,
      }
    : null;
}
