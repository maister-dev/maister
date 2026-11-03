import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { tasks } from "@/lib/db/schema";

/** Only a qualification finding is advisory; unclassified historical flags remain holds. */
export function manualTriageHoldPredicate(): SQL {
  return sql`(${tasks.triageStatus}='flagged' AND ${tasks.triageFlagOrigin} IS DISTINCT FROM 'qualification') IS TRUE`;
}
