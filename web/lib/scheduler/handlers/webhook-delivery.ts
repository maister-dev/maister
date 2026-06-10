import "server-only";

import { eq, sql } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import { platformRuntimeSettings } from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import {
  classifyResult,
  DEFAULT_MAX_ATTEMPTS,
  type WebhookErrorKind,
} from "@/lib/webhooks/backoff";
import { matchSubscriptions } from "@/lib/webhooks/match";
import {
  buildEnvelopePayload,
  finalizeEnvelope,
  isWebhookEventType,
  type WebhookEnvelopePayload,
  type WebhookEventType,
} from "@/lib/webhooks/taxonomy";
import {
  idempotencyKey,
  resolveEnvRef,
  resolveMaybeEnvRef,
} from "@/lib/webhooks/signing";
import { signAndSend, truncate } from "@/lib/webhooks/send";

// FIXME(any): dual drizzle-orm peer-dep variants — pg|sqlite union.
type Db = any;

export type WebhookDeliverySummary = {
  skipped?: "disabled";
  fanout: number;
  delivered: number;
  failed: number;
  dead: number;
  pruned: number;
};

export type RunWebhookDeliveryJobInput = {
  db?: Db;
};

const log = pino({
  name: "scheduler-webhook-delivery",
  level: process.env.LOG_LEVEL ?? "info",
});

const DEFAULT_BATCH = 20;
const DEFAULT_TIMEOUT_MS = 10_000;
const LEASE_MS = 5 * 60_000;
const HTTP_CONCURRENCY = 5;
const RETENTION_DAYS = 7;

function positiveEnvInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : defaultValue;

  if (!Number.isFinite(parsed) || parsed < 1) return defaultValue;

  return parsed;
}

export async function runWebhookDeliveryJob(
  input: RunWebhookDeliveryJobInput = {},
): Promise<WebhookDeliverySummary> {
  const db: Db = input.db ?? getDb();

  const rows = await db
    .select()
    .from(platformRuntimeSettings)
    .where(eq(platformRuntimeSettings.id, "singleton"));
  const webhooksEnabled = rows[0]?.webhooksEnabled !== false;

  if (!webhooksEnabled) {
    const summary: WebhookDeliverySummary = {
      skipped: "disabled",
      fanout: 0,
      delivered: 0,
      failed: 0,
      dead: 0,
      pruned: 0,
    };

    log.info(summary, "[scheduler.webhook_delivery] summary");

    return summary;
  }

  const batch = positiveEnvInt("MAISTER_WEBHOOK_DELIVERY_BATCH", DEFAULT_BATCH);
  const timeoutMs = positiveEnvInt(
    "MAISTER_WEBHOOK_TIMEOUT_MS",
    DEFAULT_TIMEOUT_MS,
  );
  const maxAttempts = positiveEnvInt(
    "MAISTER_WEBHOOK_MAX_ATTEMPTS",
    DEFAULT_MAX_ATTEMPTS,
  );

  const fanout = await runFanoutPass(db, batch);
  const drain = await runDrainPass(db, batch, timeoutMs, maxAttempts);
  const pruned = await runPrunePass(db);

  const summary: WebhookDeliverySummary = {
    fanout,
    delivered: drain.delivered,
    failed: drain.failed,
    dead: drain.dead,
    pruned,
  };

  log.info(summary, "[scheduler.webhook_delivery] summary");

  return summary;
}

// ---------------------------------------------------------------------------
// PRUNE — outbox retention tail-pass. The outbox grows on EVERY taxonomy
// transition; events that matched no subscription spawn zero deliveries and
// would otherwise accumulate forever. Delete fanned-out events older than the
// retention window that NO delivery references. The NOT EXISTS guard keeps
// every delivery-referenced event forever (replay/audit). fanout_at IS NOT NULL
// guards un-fanned events from being deleted out from under the fanout pass.
// ---------------------------------------------------------------------------

async function runPrunePass(db: Db): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM webhook_events
    WHERE fanout_at IS NOT NULL
      AND fanout_at < now() - ${`${RETENTION_DAYS} days`}::interval
      AND NOT EXISTS (
        SELECT 1 FROM webhook_deliveries d WHERE d.event_id = webhook_events.id
      )
  `);

  const pruned = result.rowCount ?? 0;

  if (pruned > 0) {
    log.info({ pruned }, `[scheduler.webhook_delivery] pruned ${pruned}`);
  }

  return pruned;
}

// ---------------------------------------------------------------------------
// FANOUT — claim un-fanned events (FOR UPDATE SKIP LOCKED), build+freeze the
// envelope payload from the runs⋈projects⋈workspaces join, match enabled subs,
// insert one pending delivery per match, and stamp payload + fanout_at. All in
// one tx per pass so an event's freeze and its delivery rows commit atomically.
// ---------------------------------------------------------------------------

type EventRow = {
  id: string;
  project_id: string;
  type: string;
  data: Record<string, unknown>;
  occurred_at: Date | string;
  run_id: string;
  run_status: string | null;
  task_id: string | null;
  flow_id: string | null;
  project_slug: string | null;
  project_name: string | null;
  branch: string | null;
};

type SubRow = {
  id: string;
  project_id: string | null;
  enabled: boolean;
  event_types: string[];
};

async function runFanoutPass(db: Db, batch: number): Promise<number> {
  return db.transaction(async (tx: Db) => {
    // FOR UPDATE SKIP LOCKED can only lock the base relation, never the nullable
    // side of an outer join, so the lock claim is isolated to webhook_events in a
    // CTE; the run/project enrichment joins happen in the outer (unlocked) query.
    // branch is a scalar subquery (a run may have >1 workspaces row) to keep the
    // result one-row-per-event.
    const claimed = await tx.execute(sql`
      WITH claimed_events AS (
        SELECT id
        FROM webhook_events
        WHERE fanout_at IS NULL
        ORDER BY created_at
        LIMIT ${batch}
        FOR UPDATE SKIP LOCKED
      )
      SELECT
        e.id,
        e.project_id,
        e.type,
        e.data,
        e.occurred_at,
        e.run_id,
        r.status AS run_status,
        r.task_id,
        r.flow_id,
        p.slug AS project_slug,
        p.name AS project_name,
        (
          SELECT w.branch
          FROM workspaces w
          WHERE w.run_id = e.run_id
          ORDER BY w.created_at
          LIMIT 1
        ) AS branch
      FROM claimed_events c
      JOIN webhook_events e ON e.id = c.id
      LEFT JOIN runs r ON r.id = e.run_id
      LEFT JOIN projects p ON p.id = e.project_id
      ORDER BY e.created_at
    `);

    const events = (claimed.rows ?? []) as EventRow[];

    if (events.length === 0) return 0;

    const subResult = await tx.execute(sql`
      SELECT id, project_id, enabled, event_types
      FROM webhook_subscriptions
      WHERE enabled = true
    `);
    const allSubs = (subResult.rows ?? []) as SubRow[];

    for (const event of events) {
      const type = event.type;
      const payload: WebhookEnvelopePayload = buildEnvelopePayload({
        eventId: event.id,
        type: isWebhookEventType(type) ? type : (type as WebhookEventType),
        occurredAt: new Date(event.occurred_at),
        project: event.project_slug
          ? {
              id: event.project_id,
              slug: event.project_slug,
              name: event.project_name ?? "",
            }
          : null,
        run: event.run_id
          ? {
              id: event.run_id,
              taskId: event.task_id,
              flowId: event.flow_id,
              branch: event.branch,
              status: event.run_status ?? "",
            }
          : null,
        data: event.data ?? {},
      });

      await tx.execute(sql`
        UPDATE webhook_events
        SET payload = ${JSON.stringify(payload)}::jsonb, fanout_at = now()
        WHERE id = ${event.id}
      `);

      const matched = matchSubscriptions(
        { type, projectId: event.project_id },
        allSubs.map((s) => ({
          id: s.id,
          projectId: s.project_id,
          enabled: s.enabled,
          eventTypes: s.event_types,
        })),
      );

      for (const sub of matched) {
        await tx.execute(sql`
          INSERT INTO webhook_deliveries (
            id, event_id, subscription_id, status, attempt_count,
            next_attempt_at, idempotency_key, created_at, updated_at
          )
          VALUES (
            gen_random_uuid()::text,
            ${event.id},
            ${sub.id},
            'pending',
            0,
            now(),
            ${idempotencyKey(sub.id, event.id)},
            now(),
            now()
          )
          ON CONFLICT (subscription_id, event_id) DO NOTHING
        `);
      }
    }

    return events.length;
  });
}

// ---------------------------------------------------------------------------
// DRAIN — two-phase, at-least-once:
//   (1) Claim tx: select due pending deliveries (FOR UPDATE SKIP LOCKED), stamp
//       a 5-min lease, COMMIT. Committing the lease before any HTTP send is what
//       prevents a concurrent drain from re-claiming the same row.
//   (2) Send + record: per claimed delivery, fetch the subscription + the frozen
//       event payload, sign, POST (bounded concurrency 5), classify, then in ONE
//       tx insert the attempt row + CAS the delivery to delivered/dead/pending.
//
//   CRASH WINDOW (DQ6, intentional): if the process dies between the POST and the
//   attempt-write tx, the row stays `pending` with a now-expired lease; the next
//   drain reclaims and re-POSTs it. The duplicate send carries the identical
//   X-Maister-Idempotency-Key (sha256(subId:eventId)) so the consumer dedupes it.
// ---------------------------------------------------------------------------

type ClaimedDeliveryRow = {
  id: string;
  event_id: string;
  subscription_id: string;
  attempt_count: number;
};

type DrainSubRow = {
  url: string;
  method: string;
  headers: Record<string, string> | null;
  signing_secret_ref: string;
  secondary_signing_secret_ref: string | null;
};

type DrainCounts = { delivered: number; failed: number; dead: number };

async function runDrainPass(
  db: Db,
  batch: number,
  timeoutMs: number,
  maxAttempts: number,
): Promise<DrainCounts> {
  const claimed: ClaimedDeliveryRow[] = await db.transaction(async (tx: Db) => {
    const due = await tx.execute(sql`
        SELECT id, event_id, subscription_id, attempt_count
        FROM webhook_deliveries
        WHERE status = 'pending'
          AND next_attempt_at <= now()
          AND (lease_expires_at IS NULL OR lease_expires_at < now())
        ORDER BY next_attempt_at
        LIMIT ${batch}
        FOR UPDATE SKIP LOCKED
      `);
    const rows = (due.rows ?? []) as ClaimedDeliveryRow[];

    if (rows.length === 0) return rows;

    const ids = rows.map((r) => r.id);
    const leaseExpiresAt = new Date(Date.now() + LEASE_MS);

    await tx.execute(sql`
        UPDATE webhook_deliveries
        SET lease_expires_at = ${leaseExpiresAt}, updated_at = now()
        WHERE id IN (${sql.join(ids, sql`, `)})
      `);

    return rows;
  });

  const counts: DrainCounts = { delivered: 0, failed: 0, dead: 0 };

  if (claimed.length === 0) return counts;

  // Fixed-size HTTP worker pool: pull from the shared queue so at most
  // HTTP_CONCURRENCY sends are in flight at once.
  const queue = [...claimed];
  const workers: Promise<void>[] = [];

  for (let i = 0; i < Math.min(HTTP_CONCURRENCY, queue.length); i++) {
    workers.push(
      (async () => {
        for (;;) {
          const next = queue.shift();

          if (!next) return;

          try {
            const outcome = await processDelivery(
              db,
              next,
              timeoutMs,
              maxAttempts,
            );

            if (outcome === "delivered") counts.delivered += 1;
            else if (outcome === "dead") counts.dead += 1;
            else counts.failed += 1;
          } catch (err) {
            // HTTP/timeout/network/config never throw — they're recorded inline.
            // A truly unexpected error here (e.g. a transient DB failure in the
            // phase-2 tx) must NOT abort the batch: log it (no secret/url), leave
            // the row leased so it reclaims on lease expiry (at-least-once), and
            // move on to the next queued delivery.
            log.warn(
              {
                deliveryId: next.id,
                error: err instanceof Error ? err.message : String(err),
              },
              "[scheduler.webhook_delivery] delivery aborted unexpectedly",
            );
          }
        }
      })(),
    );
  }

  await Promise.all(workers);

  return counts;
}

async function processDelivery(
  db: Db,
  claimed: ClaimedDeliveryRow,
  timeoutMs: number,
  maxAttempts: number,
): Promise<"delivered" | "dead" | "retry"> {
  // Retry-curve position: drives classifyResult's max-attempts decision and the
  // written webhook_deliveries.attempt_count. A replay resets attempt_count to 0
  // (fresh budget), so this restarts at 1 — distinct from the append-only audit
  // attempt_no, which finishDelivery computes from the running max in its tx.
  const attemptCount = claimed.attempt_count + 1;

  const subResult = await db.execute(sql`
    SELECT url, method, headers, signing_secret_ref, secondary_signing_secret_ref
    FROM webhook_subscriptions
    WHERE id = ${claimed.subscription_id}
  `);
  const sub = (subResult.rows ?? [])[0] as DrainSubRow | undefined;

  const evResult = await db.execute(sql`
    SELECT payload, type FROM webhook_events WHERE id = ${claimed.event_id}
  `);
  const eventRow = (evResult.rows ?? [])[0] as
    | { payload: WebhookEnvelopePayload | null; type: string }
    | undefined;

  if (!sub || !eventRow?.payload) {
    // Subscription or frozen payload vanished — record a config failure rather
    // than leaving the row leased. classifyResult routes this to retry/dead.
    return finishDelivery(db, {
      claimed,
      attemptCount,
      maxAttempts,
      errorKind: "config",
      httpStatus: undefined,
      durationMs: 0,
      errorDetail: "subscription or frozen payload missing",
      responseSnippet: null,
    });
  }

  const eventType = eventRow.payload.type;
  const envelope = finalizeEnvelope(eventRow.payload, claimed.id, attemptCount);
  const rawBody = JSON.stringify(envelope);

  let secret: string;
  let secondarySecret: string | null = null;
  const resolvedHeaders: Record<string, string> = {};

  try {
    secret = resolveEnvRef(sub.signing_secret_ref);

    if (sub.secondary_signing_secret_ref) {
      secondarySecret = resolveEnvRef(sub.secondary_signing_secret_ref);
    }

    for (const [k, v] of Object.entries(sub.headers ?? {})) {
      resolvedHeaders[k] = resolveMaybeEnvRef(v);
    }
  } catch (err) {
    // A secret/header ref points at an env var the operator has not exported
    // yet. Never log the ref's value; treat as a config-kind failure so the
    // delivery retries once the var is available.
    if (isMaisterError(err) && err.code === "CONFIG") {
      return finishDelivery(db, {
        claimed,
        attemptCount,
        maxAttempts,
        type: eventType,
        errorKind: "config",
        httpStatus: undefined,
        durationMs: 0,
        errorDetail: "signing secret env reference unset",
        responseSnippet: null,
      });
    }

    throw err;
  }

  const sent = await signAndSend({
    url: sub.url,
    method: sub.method,
    type: eventType,
    eventId: claimed.event_id,
    deliveryId: claimed.id,
    subscriptionId: claimed.subscription_id,
    rawBody,
    secret,
    secondarySecret,
    extraHeaders: resolvedHeaders,
    timeoutMs,
  });

  return finishDelivery(db, {
    claimed,
    attemptCount,
    maxAttempts,
    type: eventType,
    errorKind: sent.errorKind,
    httpStatus: sent.httpStatus,
    durationMs: sent.durationMs,
    errorDetail: sent.errorDetail,
    responseSnippet: sent.responseSnippet,
  });
}

type FinishInput = {
  claimed: ClaimedDeliveryRow;
  attemptCount: number;
  maxAttempts: number;
  type?: string;
  errorKind?: WebhookErrorKind;
  httpStatus?: number;
  durationMs: number;
  errorDetail: string | null;
  responseSnippet: string | null;
};

async function finishDelivery(
  db: Db,
  input: FinishInput,
): Promise<"delivered" | "dead" | "retry"> {
  const { claimed, attemptCount, maxAttempts, errorKind, httpStatus } = input;

  const classification = classifyResult({
    attemptCount,
    maxAttempts,
    httpStatus,
    errorKind,
    rng: Math.random,
  });

  const httpStatusValue = httpStatus ?? null;
  const errorKindValue = errorKind ?? null;
  const errorDetail = truncate(input.errorDetail);
  const responseSnippet = truncate(input.responseSnippet);

  await db.transaction(async (tx: Db) => {
    // Audit attempt_no is append-only and decoupled from the retry curve: it
    // continues from the running max so a replay (which resets attempt_count to
    // 0) does NOT collide with the preserved prior attempts under
    // UNIQUE(delivery_id, attempt_no). Computed inside the tx for consistency.
    await tx.execute(sql`
      INSERT INTO webhook_delivery_attempts (
        id, delivery_id, attempt_no, requested_at, duration_ms,
        http_status, error_kind, error_detail, response_snippet
      )
      VALUES (
        gen_random_uuid()::text,
        ${claimed.id},
        COALESCE(
          (SELECT max(attempt_no) FROM webhook_delivery_attempts
           WHERE delivery_id = ${claimed.id}),
          0
        ) + 1,
        now(),
        ${input.durationMs},
        ${httpStatusValue},
        ${errorKindValue},
        ${errorDetail},
        ${responseSnippet}
      )
    `);

    if (classification.outcome === "delivered") {
      await tx.execute(sql`
        UPDATE webhook_deliveries
        SET status = 'delivered',
            delivered_at = now(),
            attempt_count = ${attemptCount},
            last_http_status = ${httpStatusValue},
            lease_expires_at = NULL,
            updated_at = now()
        WHERE id = ${claimed.id}
      `);
    } else if (classification.outcome === "dead") {
      await tx.execute(sql`
        UPDATE webhook_deliveries
        SET status = 'dead',
            attempt_count = ${attemptCount},
            last_http_status = ${httpStatusValue},
            last_error_kind = ${errorKindValue},
            last_error_message = ${errorDetail},
            lease_expires_at = NULL,
            updated_at = now()
        WHERE id = ${claimed.id}
      `);
    } else {
      const nextAttemptAt = new Date(Date.now() + classification.delayMs);

      await tx.execute(sql`
        UPDATE webhook_deliveries
        SET status = 'pending',
            attempt_count = ${attemptCount},
            next_attempt_at = ${nextAttemptAt},
            last_http_status = ${httpStatusValue},
            last_error_kind = ${classification.errorKind},
            last_error_message = ${errorDetail},
            lease_expires_at = NULL,
            updated_at = now()
        WHERE id = ${claimed.id}
      `);
    }
  });

  if (classification.outcome === "delivered") {
    log.info(
      {
        deliveryId: claimed.id,
        type: input.type,
        httpStatus,
        durationMs: input.durationMs,
        attempt: attemptCount,
      },
      "[scheduler.webhook_delivery] delivered",
    );

    return "delivered";
  }

  const nextAttemptAt =
    classification.outcome === "retry"
      ? new Date(Date.now() + classification.delayMs).toISOString()
      : null;

  log.warn(
    {
      deliveryId: claimed.id,
      errorKind: errorKind ?? null,
      attempt: attemptCount,
      nextAttemptAt,
    },
    "[scheduler.webhook_delivery] failed",
  );

  return classification.outcome === "dead" ? "dead" : "retry";
}
