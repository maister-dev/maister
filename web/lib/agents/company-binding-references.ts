import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";

import { sql } from "drizzle-orm";

/** Call under the existing Flow revision lock; binding capture holds its shared counterpart. */
export async function hasCompanyCoordinatorFlowReference(
  tx: SqlTransaction,
  revisionId: string,
): Promise<boolean> {
  const row = (
    await tx.execute(
      sql`SELECT id FROM company_flow_bindings WHERE flow_revision_id=${revisionId} AND detached_at IS NULL UNION ALL SELECT b.id FROM company_specialist_bindings b JOIN company_specialist_binding_revisions r ON r.binding_id=b.id AND r.revision=b.revision WHERE b.detached_at IS NULL AND r.snapshot->>'coordinatorFlowRevisionId'=${revisionId} LIMIT 1`,
    )
  ).rows[0];

  return row !== undefined;
}
