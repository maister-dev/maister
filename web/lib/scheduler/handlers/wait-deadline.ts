import "server-only";

import type { WaitDb, WaitTx } from "@/lib/waits/store";

import { and, asc, eq, sql } from "drizzle-orm";
import pino from "pino";

import { runWaits } from "@/lib/db/schema";
import { resolveObservedWait } from "@/lib/waits/resolve";
import { closeExpiredCiCallbacks } from "@/lib/waits/reservations";

const log = pino({
  name: "scheduler-wait-deadline",
  level: process.env.LOG_LEVEL ?? "info",
});
const BATCH_SIZE = 64;
const nextCheck = sql`greatest(${runWaits.nextDueAt}, ${runWaits.deadlineRetryAt})`;

export async function runWaitDeadlineSweep(
  db: WaitDb & Pick<WaitTx, "select" | "update">,
): Promise<{ scanned: number; resolved: number; errors: string[] }> {
  await closeExpiredCiCallbacks(db);
  const candidates = await db
    .select({
      waitId: runWaits.id,
      runId: runWaits.runId,
      projectId: runWaits.projectId,
    })
    .from(runWaits)
    .where(
      and(
        eq(runWaits.state, "open"),
        sql`${nextCheck} <= statement_timestamp()`,
      ),
    )
    .orderBy(asc(nextCheck), asc(runWaits.id))
    .limit(BATCH_SIZE);

  const errors: string[] = [];
  let resolved = 0;

  for (const address of candidates) {
    try {
      if (await resolveObservedWait(db, address)) resolved++;
    } catch (error: unknown) {
      errors.push(address.waitId);
      log.warn({ ...address, err: error }, "due wait resolution failed");
      await db
        .update(runWaits)
        .set({ deadlineRetryAt: sql`clock_timestamp() + interval '2 minutes'` })
        .where(
          and(eq(runWaits.id, address.waitId), eq(runWaits.state, "open")),
        );
    }
  }

  return { scanned: candidates.length, resolved, errors };
}
