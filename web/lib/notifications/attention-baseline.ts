import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { GlobalRole } from "@/lib/db/schema";

import { sql } from "drizzle-orm";
import pino from "pino";

import { MaisterError } from "@/lib/errors";
import { upgradeMaintenanceEngaged } from "@/lib/maintenance/upgrade-fence";
import { readAttentionDecisionSnapshot } from "@/lib/notifications/attention-publication";

const log = pino({
  name: "attention-publication-baseline",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Insert-only restartable upgrade baseline. Existing users require fenced admission; no notification is emitted. */
export async function backfillAttentionPublicationPage(
  db: Db,
): Promise<{ complete: boolean; processed: number }> {
  const candidates = await db.execute<{
    id: string;
    role: GlobalRole;
  }>(sql`SELECT u.id,u.role FROM users u
    WHERE u.account_status='active' AND NOT EXISTS
      (SELECT 1 FROM attention_publication_states state WHERE state.owner_user_id=u.id)
    ORDER BY u.id LIMIT 25`);

  if (!candidates.rows.length) return { complete: true, processed: 0 };
  assertFenced();
  let processed = 0;

  for (const user of candidates.rows) {
    const snapshot = await readAttentionDecisionSnapshot(
      db,
      user.id,
      user.role,
    );

    await db.transaction(async (tx) => {
      assertFenced();
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${0x61746e_64}::int,hashtext(${user.id})::int)`,
      );
      const inserted =
        await tx.execute(sql`INSERT INTO attention_publication_states(owner_user_id,decisions,ordinary_decisions)
        VALUES (${user.id},${snapshot.decisions},${snapshot.ordinaryDecisions})
        ON CONFLICT(owner_user_id) DO NOTHING RETURNING owner_user_id`);

      processed += inserted.rows.length;
    });
  }
  log.info(
    { processed, candidateCount: candidates.rows.length },
    "attention publication baseline page committed",
  );

  return { complete: false, processed };
}

function assertFenced(): void {
  if (!upgradeMaintenanceEngaged())
    throw new MaisterError(
      "PRECONDITION",
      "Enable upgrade maintenance before seeding existing attention publication baselines",
      { details: { reason: "attention_baseline_requires_maintenance" } },
    );
}
