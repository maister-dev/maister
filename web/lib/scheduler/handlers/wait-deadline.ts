import "server-only";

import type { WaitDb, WaitTx } from "@/lib/waits/store";

import { and, asc, eq, sql } from "drizzle-orm";
import pino from "pino";

import {
  conditionParkDeadline,
  expireConditionWaitPark,
} from "@/lib/waits/lifecycle";
import { nodeAttempts, runWaits } from "@/lib/db/schema";
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
      state: runWaits.state,
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

  const parking = await db
    .select({
      state: runWaits.state,
      waitId: runWaits.id,
      runId: runWaits.runId,
      projectId: runWaits.projectId,
    })
    .from(runWaits)
    .innerJoin(nodeAttempts, eq(nodeAttempts.id, runWaits.nodeAttemptId))
    .where(
      and(
        eq(runWaits.state, "parking"),
        sql`greatest(${conditionParkDeadline},${runWaits.deadlineRetryAt}) <= statement_timestamp()`,
      ),
    )
    .orderBy(asc(conditionParkDeadline), asc(runWaits.id))
    .limit(BATCH_SIZE);
  const errors: string[] = [];
  let resolved = 0;

  for (const address of [...parking, ...candidates]) {
    try {
      const changed =
        address.state === "parking"
          ? await db.transaction((tx) => expireConditionWaitPark(tx, address))
          : await resolveObservedWait(db, address);

      if (changed) resolved++;
    } catch (error: unknown) {
      errors.push(address.waitId);
      log.warn({ ...address, err: error }, "due wait resolution failed");
      await db
        .update(runWaits)
        .set({ deadlineRetryAt: sql`clock_timestamp() + interval '2 minutes'` })
        .where(
          and(
            eq(runWaits.id, address.waitId),
            eq(runWaits.state, address.state),
          ),
        );
    }
  }

  return { scanned: candidates.length + parking.length, resolved, errors };
}
