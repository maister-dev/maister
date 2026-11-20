import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { sql } from "drizzle-orm";

// A confirmation can depend on exact revisions in several vaults. Fence
// that whole operation before taking card, vault, or payload row locks.
const redactionFence = sql`hashtextextended('maister:vault-card-redaction:v1', 0)`;

export async function lockConfirmationSources(tx: Db): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(${redactionFence})`);
}

export async function lockConfirmationSourceRedaction(tx: Db): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${redactionFence})`);
}
