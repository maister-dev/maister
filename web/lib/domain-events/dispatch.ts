import "server-only";

import { and, asc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import {
  DOMAIN_EVENT_CONSUMERS,
  type DomainEventConsumer,
} from "@/lib/domain-events/consumers";

export type { DomainEventConsumer } from "@/lib/domain-events/consumers";

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/services/tasks.ts).
const { domainEvents, domainEventConsumers } =
  schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "domain-events-dispatch",
  level: process.env.LOG_LEVEL ?? "info",
});

// Code constants until a real consumer needs tuning (ADR-086 — no env knobs
// in this stage).
const BATCH_SIZE = 100;
const MAX_BATCHES_PER_PASS = 10;
const LEASE_MS = 5 * 60_000;
const LAST_ERROR_MAX = 1024;
// Base = one scheduler tick, so the first retry always skips at least one
// tick; a permanently failing head batch (e.g. a paid LLM call behind a
// revoked key) settles at one retry per hour instead of one per minute.
const FAILURE_BACKOFF_BASE_MS = 60_000;
const FAILURE_BACKOFF_CAP_MS = 60 * 60_000;

// 2^cf overflows to Infinity for absurd counters; Math.min caps it either way.
function failureBackoffMs(consecutiveFailures: number): number {
  return Math.min(
    FAILURE_BACKOFF_BASE_MS * 2 ** consecutiveFailures,
    FAILURE_BACKOFF_CAP_MS,
  );
}

// A type alias (not an interface) so the summary satisfies the scheduler's
// Record<string, unknown> attempt-summary column via TS's implicit index
// signature (matches WebhookDeliverySummary).
export type DispatchSummary = {
  consumers: number;
  totalDispatched: number;
  failures: number;
  skipped: number;
  deferred: number;
};

// Idempotent registration: "beginning" seeds cursor 0; "now" seeds the current
// MAX(domain_events.id) in the same statement so the consumer skips the
// backlog that existed before it registered.
export async function ensureConsumerRows(
  db: Db,
  consumers: DomainEventConsumer[],
): Promise<void> {
  for (const consumer of consumers) {
    if (consumer.startFrom === "now") {
      await db.execute(sql`
        insert into domain_event_consumers (consumer_id, cursor_event_id)
        values (${consumer.id}, coalesce((select max(id) from domain_events), 0))
        on conflict (consumer_id) do nothing
      `);
    } else {
      await db
        .insert(domainEventConsumers)
        .values({ consumerId: consumer.id, cursorEventId: 0 })
        .onConflictDoNothing();
    }
  }
}

// One dispatch pass over the registered consumers (ADR-086 DD3):
//   1. defer the consumer while it is inside its failure-backoff window —
//      min(base · 2^consecutive_failures, cap) since the failure write. The
//      anchor is updated_at: a deferral happens BEFORE any write, so while a
//      consumer backs off, updated_at keeps carrying the failure timestamp
//      (the failed head event stays visible — the horizon is monotonic — so
//      the empty-batch release can't touch the row either);
//   2. claim the cursor row by CAS on lease_expires_at AND on the pre-read
//      consecutive_failures (zero rows ⇒ another dispatcher is live, or it
//      recorded a new failure after our backoff check ⇒ skip — no
//      double-claim and no retry inside a freshly opened backoff window);
//   3. read `id > cursor AND tx_id < pg_snapshot_xmin(pg_current_snapshot())
//      ORDER BY id LIMIT batch` — the xid8 horizon holds back everything past
//      the oldest active transaction so a late-committing lower id is never
//      skipped;
//   4. invoke consumer.handle(events);
//   5. advance by a CAS fenced on the cursor value this pass last observed —
//      a zombie returning after lease reap + reclaim no-ops (and must NOT
//      touch the reclaimer's lease);
//   6. loop up to MAX_BATCHES_PER_PASS; the lease is held across batches and
//      released by the final advance (or the fenced failure update).
// Delivery is at-least-once; consumers are idempotent by contract — backoff
// only delays redelivery of the same window, never skips past it.
export async function dispatchDomainEvents(
  opts: {
    db?: Db;
    now?: Date;
    consumers?: DomainEventConsumer[];
    batchSize?: number;
    maxBatches?: number;
    leaseMs?: number;
  } = {},
): Promise<DispatchSummary> {
  const db = opts.db ?? getDb();
  const consumers = opts.consumers ?? DOMAIN_EVENT_CONSUMERS;
  const batchSize = opts.batchSize ?? BATCH_SIZE;
  const maxBatches = opts.maxBatches ?? MAX_BATCHES_PER_PASS;
  const leaseMs = opts.leaseMs ?? LEASE_MS;

  await ensureConsumerRows(db, consumers);

  const summary: DispatchSummary = {
    consumers: consumers.length,
    totalDispatched: 0,
    failures: 0,
    skipped: 0,
    deferred: 0,
  };

  for (const consumer of consumers) {
    const now = opts.now ?? new Date();

    const preRead = await db
      .select({
        consecutiveFailures: domainEventConsumers.consecutiveFailures,
        updatedAt: domainEventConsumers.updatedAt,
      })
      .from(domainEventConsumers)
      .where(eq(domainEventConsumers.consumerId, consumer.id));
    const cursor = preRead.at(0);

    if (cursor && cursor.consecutiveFailures > 0) {
      const retryAt = new Date(
        (cursor.updatedAt as Date).getTime() +
          failureBackoffMs(cursor.consecutiveFailures as number),
      );

      if (now < retryAt) {
        summary.deferred += 1;
        log.info(
          {
            consumer: consumer.id,
            consecutiveFailures: cursor.consecutiveFailures,
            retryAt,
          },
          "[domain-events.dispatch] deferred — failure backoff",
        );
        continue;
      }
    }

    const claimed = await db
      .update(domainEventConsumers)
      .set({
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(domainEventConsumers.consumerId, consumer.id),
          or(
            isNull(domainEventConsumers.leaseExpiresAt),
            lt(domainEventConsumers.leaseExpiresAt, now),
          ),
          eq(
            domainEventConsumers.consecutiveFailures,
            cursor?.consecutiveFailures ?? 0,
          ),
        ),
      )
      .returning({ cursorEventId: domainEventConsumers.cursorEventId });

    if (claimed.length === 0) {
      summary.skipped += 1;
      log.debug(
        { consumer: consumer.id },
        "[domain-events.dispatch] skip — live lease held elsewhere",
      );
      continue;
    }

    // The fence value: every later write of this pass CASes on it so a
    // reclaiming pass that moved the cursor wins over this (possibly zombie)
    // pass unconditionally.
    let fence = claimed[0].cursorEventId as number;
    let dispatchedForConsumer = 0;

    for (let batch = 0; batch < maxBatches; batch += 1) {
      const events = await db
        .select()
        .from(domainEvents)
        .where(
          and(
            gt(domainEvents.id, fence),
            sql`${domainEvents.txId} < pg_snapshot_xmin(pg_current_snapshot())`,
          ),
        )
        .orderBy(asc(domainEvents.id))
        .limit(batchSize);

      if (events.length === 0) {
        // Nothing visible past the cursor (empty backlog or horizon
        // hold-back): release the lease we still own (fenced — a reclaimed
        // lease is not ours to touch) and end the pass.
        await db
          .update(domainEventConsumers)
          .set({ leaseExpiresAt: null, updatedAt: new Date() })
          .where(
            and(
              eq(domainEventConsumers.consumerId, consumer.id),
              eq(domainEventConsumers.cursorEventId, fence),
            ),
          );
        break;
      }

      const startedAt = Date.now();

      try {
        await consumer.handle(events);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        summary.failures += 1;

        const failed = await db
          .update(domainEventConsumers)
          .set({
            leaseExpiresAt: null,
            lastError: message.slice(0, LAST_ERROR_MAX),
            consecutiveFailures: sql`${domainEventConsumers.consecutiveFailures} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(domainEventConsumers.consumerId, consumer.id),
              eq(domainEventConsumers.cursorEventId, fence),
            ),
          )
          .returning({ consumerId: domainEventConsumers.consumerId });

        log.warn(
          {
            consumer: consumer.id,
            error: message,
            fencedOut: failed.length === 0,
          },
          "[domain-events.dispatch] consumer failed",
        );
        break;
      }

      const lastId = events.at(-1)!.id as number;
      const isFinalBatch =
        events.length < batchSize || batch === maxBatches - 1;

      const advanced = await db
        .update(domainEventConsumers)
        .set({
          cursorEventId: lastId,
          consecutiveFailures: 0,
          lastError: null,
          lastDispatchedAt: new Date(),
          updatedAt: new Date(),
          ...(isFinalBatch ? { leaseExpiresAt: null } : {}),
        })
        .where(
          and(
            eq(domainEventConsumers.consumerId, consumer.id),
            eq(domainEventConsumers.cursorEventId, fence),
          ),
        )
        .returning({ cursorEventId: domainEventConsumers.cursorEventId });

      if (advanced.length === 0) {
        // Zombie path: the lease was reaped and another pass moved the cursor.
        // Converges to a duplicate delivery (at-least-once), never a loss —
        // and the reclaimer's lease stays untouched.
        log.warn(
          { consumer: consumer.id, staleFence: fence },
          "[domain-events.dispatch] advance fenced out — reclaimed elsewhere",
        );
        break;
      }

      dispatchedForConsumer += events.length;
      summary.totalDispatched += events.length;

      log.info(
        {
          consumer: consumer.id,
          claimed: events.length,
          fromId: events[0].id,
          toId: lastId,
          count: dispatchedForConsumer,
          ms: Date.now() - startedAt,
        },
        "[domain-events.dispatch] batch dispatched",
      );

      fence = lastId;

      if (isFinalBatch) break;
    }
  }

  return summary;
}
