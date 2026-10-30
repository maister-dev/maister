import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { domainEvents } from "@/lib/db/schema";

/** Agent execution history owns routine operational terminals and failures already represented by incidents. */
export function humanActivityEventPredicate(): SQL {
  return sql`NOT (
    ${domainEvents.kind} IN ('run.done','run.failed','run.crashed','run.abandoned')
    AND (EXISTS (SELECT 1 FROM runs operation WHERE operation.id=${domainEvents.runId} AND operation.agent_kind='operational')
      OR EXISTS (SELECT 1 FROM agent_incident_occurrences incident
        WHERE incident.run_id=${domainEvents.runId} AND incident.channel='execution_failure'))
  )`;
}
