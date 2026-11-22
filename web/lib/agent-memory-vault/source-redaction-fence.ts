import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { sql } from "drizzle-orm";

// Reviews and confirmations can depend on exact revisions in several vaults.
// Take the fence before checking source access or locking dependent rows.
const redactionFence = sql`hashtextextended('maister:vault-card-redaction:v1', 0)`;

export async function lockVaultSources(tx: Db): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(${redactionFence})`);
}

export async function lockVaultSourceRedaction(tx: Db): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${redactionFence})`);
}
