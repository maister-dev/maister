import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { eq, sql } from "drizzle-orm";

import { agentMemoryCutover } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

// One transaction fence for legacy readers/writers, manifests and activation.
export const vaultCutoverLock = sql`7269687725980627351::bigint`;

export async function lockVaultCutover(tx: Db): Promise<bigint | null> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock_shared(${vaultCutoverLock})`,
  );
  const [current] = await tx
    .select({ generation: agentMemoryCutover.generation })
    .from(agentMemoryCutover)
    .where(eq(agentMemoryCutover.singleton, true));

  return current?.generation ?? null;
}

export async function requireVaultActive(tx: Db): Promise<void> {
  if ((await lockVaultCutover(tx)) === null)
    throw new MaisterError(
      "PRECONDITION",
      "Memory vault activation is required",
      {
        details: { reason: "agent_memory_cutover_required" },
      },
    );
}
