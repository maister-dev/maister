import type { Pool } from "pg";

import { randomUUID } from "node:crypto";

import { runEventWakeBus } from "@/lib/execution-host/events/run-wake";

/** Hold ONE canonical projector for ONE run: a claim no worker can take, so the
 * run's events stay ingested but unprojected for exactly that consumer while
 * every other consumer keeps running. `projectExecutionEvents` answers
 * `unavailable` for a claimed cursor, which is the whole mechanism — no mock.
 * The returned release clears only this hold's own claim and wakes projection.
 */
export async function holdProjection(
  pool: Pool,
  input: { consumerName: string; runId: string },
): Promise<() => Promise<void>> {
  const owner = `test-hold:${randomUUID()}`;

  // The insert's FK check locks the run row, which an ingest transaction may
  // hold while it seeds this run's consumer rows: Postgres breaks that cycle
  // by aborting one side (40P01), and the hold is simply taken again.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await pool.query(
        `INSERT INTO execution_event_consumers (consumer_name, run_id, claim_owner, claim_expires_at)
         VALUES ($1, $2, $3, clock_timestamp() + interval '1 hour')
         ON CONFLICT (consumer_name, run_id)
         DO UPDATE SET claim_owner = EXCLUDED.claim_owner, claim_expires_at = EXCLUDED.claim_expires_at`,
        [input.consumerName, input.runId, owner],
      );
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== "40P01" || attempt >= 5)
        throw error;
    }
  }

  return async () => {
    await pool.query(
      `UPDATE execution_event_consumers SET claim_owner = NULL, claim_expires_at = NULL
       WHERE consumer_name = $1 AND run_id = $2 AND claim_owner = $3`,
      [input.consumerName, input.runId, owner],
    );
    runEventWakeBus.wakeProjection();
  };
}
