import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { runs } from "@/lib/db/schema";
import { TERMINAL_RUN_STATUSES } from "@/lib/runs/run-status-sets";

/** Execution disposal can be pending while the completed operation is historical. */
export function operationalActiveWorkspacePredicate(): SQL {
  return sql`(${runs.agentKind} IS DISTINCT FROM 'operational' OR ${runs.status} NOT IN (${sql.join(
    TERMINAL_RUN_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  )}))`;
}
