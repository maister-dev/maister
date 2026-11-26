import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { capabilityImports } from "@/lib/db/schema";

/** Shared by native materialization, accepted bundle snapshots and the capability catalog. */
export function eligibleProjectImport(projectId: string): SQL {
  return sql`${capabilityImports.id} IN (SELECT id FROM project_ready_capability_imports(${projectId}) WHERE catalog_enabled)`;
}
