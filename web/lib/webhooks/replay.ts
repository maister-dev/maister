import "server-only";

import { sql } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";

// FIXME(any): dual drizzle-orm peer-dep variants — pg|sqlite union.
type Db = any;

const log = pino({
  name: "webhooks-replay",
  level: process.env.LOG_LEVEL ?? "info",
});

// DQ8 replay: re-queue a terminal delivery for another delivery cycle. Single
// tx, row-locked. Allowed only from `delivered|dead` — a still-`pending` row is
// already queued, so replaying it is a CONFLICT. Resets the retry budget
// (attempt_count=0, next_attempt_at=now, lease cleared) WITHOUT re-emitting the
// event or rotating the idempotency_key: the key is stable per (subscription,
// event), so the duplicate send is consumer-deduped. The webhook_delivery_attempts
// audit trail is left intact — its attempt_no sequence keeps climbing on the
// next drain (decoupled from attempt_count in the drain handler).
//
// Ownership (subscription/project) is resolved by the route layer (404 on
// mismatch) BEFORE this is called — replay assumes the row belongs to the caller.
export async function replayDelivery(
  deliveryId: string,
  db?: Db,
): Promise<void> {
  const handle: Db = db ?? getDb();

  await handle.transaction(async (tx: Db) => {
    const r = await tx.execute(sql`
      SELECT status FROM webhook_deliveries
      WHERE id = ${deliveryId}
      FOR UPDATE
    `);
    const row = (r.rows ?? [])[0] as { status: string } | undefined;

    if (!row) {
      throw new MaisterError(
        "CONFLICT",
        `webhook delivery ${deliveryId} not found`,
      );
    }

    if (row.status !== "delivered" && row.status !== "dead") {
      throw new MaisterError(
        "CONFLICT",
        `webhook delivery ${deliveryId} is ${row.status}; only delivered or dead deliveries can be replayed`,
      );
    }

    await tx.execute(sql`
      UPDATE webhook_deliveries
      SET status = 'pending',
          attempt_count = 0,
          next_attempt_at = now(),
          lease_expires_at = NULL,
          updated_at = now()
      WHERE id = ${deliveryId}
    `);
  });

  log.info({ deliveryId }, "[webhooks.replay]");
}
