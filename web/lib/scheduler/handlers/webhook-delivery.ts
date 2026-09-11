import "server-only";

import { eq, sql } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import { platformRuntimeSettings } from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import {
  classifyResult,
  DEFAULT_MAX_ATTEMPTS,
  type DeliveryClassification,
  type WebhookErrorKind,
} from "@/lib/webhooks/backoff";
import { matchSubscriptions } from "@/lib/webhooks/match";
import { pushPayloadFor } from "@/lib/notifications/payload";
import { sendPush, type PushTarget } from "@/lib/notifications/push-sender";
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

// FIXME(any): narrow this scheduler injection seam to its database operations.
type Db = any;

export type WebhookDeliverySummary = {
  skipped?: "disabled";
  // Disabled-path accounting: un-fanned events stamped consumed-and-dropped
  // by the skip pass. Absent on the enabled path.
  skippedEvents?: number;
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

  const batch = positiveEnvInt("MAISTER_WEBHOOK_DELIVERY_BATCH", DEFAULT_BATCH);

  if (!webhooksEnabled) {
    // Skip, not buffer: disabled-window events are stamped consumed-and-dropped
    // so a re-enable never delivers the backlog. Drain (pending deliveries
    // pause until re-enable) and prune stay skipped.
    const skippedEvents = await runSkipPass(db, batch);

    const summary: WebhookDeliverySummary = {
      skipped: "disabled",
      skippedEvents,
      fanout: 0,
      delivered: 0,
      failed: 0,
      dead: 0,
      pruned: 0,
    };

    log.info(summary, "[scheduler.webhook_delivery] summary");

    return summary;
  }

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
// SKIP — the disabled-path counterpart of fanout. Claims un-fanned events
// (same FOR UPDATE SKIP LOCKED claim, same batch bound) and stamps
// fanout_at = now() with NO payload freeze and ZERO delivery inserts:
// consumed-and-dropped. The prune pass GCs the stamped rows after retention.
// ---------------------------------------------------------------------------

async function runSkipPass(db: Db, batch: number): Promise<number> {
  return db.transaction(async (tx: Db) => {
    const result = await tx.execute(sql`
      WITH claimed_events AS (
        SELECT id
        FROM webhook_events
        WHERE fanout_at IS NULL
        ORDER BY created_at
        LIMIT ${batch}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE webhook_events e
      SET fanout_at = now()
      FROM claimed_events c
      WHERE e.id = c.id
    `);

    return result.rowCount ?? 0;
  });
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

// ADR-172 D2 reader: `project_id` and `run_id` are nullable since the ADR-172 widening. The
// LEFT JOINs already tolerated a missing row; the TYPES now say so, which is
// what stops a later edit from assuming a project is always there.
type EventRow = {
  id: string;
  project_id: string | null;
  type: string;
  data: Record<string, unknown>;
  occurred_at: Date | string;
  run_id: string | null;
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
  /** ADR-172: the second scope axis. Non-null makes the row user-scoped. */
  owner_user_id: string | null;
  enabled: boolean;
  event_types: string[];
};

/**
 * The owner a user-scoped `attention.*` event belongs to, read back out of the
 * event's `data`. A project-scoped event has none, and a malformed value is
 * treated as none rather than as a match — failing closed here means a
 * notification is not sent, which is strictly better than sending it to the
 * wrong reader.
 */
export function ownerUserIdOf(
  data: Record<string, unknown> | null | undefined,
): string | null {
  const value = data?.ownerUserId;

  return typeof value === "string" && value.length > 0 ? value : null;
}

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
      SELECT id, project_id, owner_user_id, enabled, event_types
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
        project:
          event.project_id && event.project_slug
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
        {
          type,
          projectId: event.project_id,
          // The owner of a user-scoped event rides in `data` (ADR-172 rejected
          // a `user_id` column on the event: one scope expression over two
          // axes is D3's bug with an extra column).
          ownerUserId: ownerUserIdOf(event.data),
        },
        allSubs.map((s) => ({
          id: s.id,
          projectId: s.project_id,
          ownerUserId: s.owner_user_id,
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

      await fanoutPushTargets(tx, event);
    }

    return events.length;
  });
}

/**
 * The `web_push` half of fan-out (ADR-172). A user-scoped event whose owner holds
 * an ENABLED `web_push` intent naming this type gets one delivery row per
 * registered browser — "notify me on every browser I have" is why the intent
 * carries no FK to a single endpoint.
 *
 * Same table, same retry curve, same drain pass as an HTTP subscription: the one
 * engine ADR-172 insisted on. `ON CONFLICT DO NOTHING` over
 * `(push_subscription_id, event_id)` is what makes an at-least-once redelivery
 * converge to one notification (`EDGE-NTF-01`).
 */
async function fanoutPushTargets(tx: Db, event: EventRow): Promise<void> {
  const ownerUserId = ownerUserIdOf(event.data);

  if (!ownerUserId) return;

  const targets = await tx.execute(sql`
    SELECT ps.id
    FROM push_subscriptions ps
    WHERE ps.owner_user_id = ${ownerUserId}
      AND EXISTS (
        SELECT 1 FROM notification_subscriptions ns
        WHERE ns.owner_user_id = ${ownerUserId}
          AND ns.transport = 'web_push'
          AND ns.enabled = true
          AND ns.event_types ? ${event.type}
      )
  `);

  for (const row of (targets.rows ?? []) as Array<{ id: string }>) {
    await tx.execute(sql`
      INSERT INTO webhook_deliveries (
        id, event_id, push_subscription_id, status, attempt_count,
        next_attempt_at, idempotency_key, created_at, updated_at
      )
      VALUES (
        gen_random_uuid()::text,
        ${event.id},
        ${row.id},
        'pending',
        0,
        now(),
        ${idempotencyKey(row.id, event.id)},
        now(),
        now()
      )
      ON CONFLICT (push_subscription_id, event_id) DO NOTHING
    `);
  }
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
  /** NULL for a `web_push` delivery — see `push_subscription_id`. */
  subscription_id: string | null;
  push_subscription_id: string | null;
  event_id: string;
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
        SELECT id, event_id, subscription_id, push_subscription_id, attempt_count
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
  // ADR-172: one drain pass, two transports. The push branch is a different
  // WIRE, not a different engine — it shares the claim, the lease, the retry
  // curve, the attempt ledger and this function's return contract.
  if (claimed.push_subscription_id !== null) {
    return processPushDelivery(db, claimed, maxAttempts);
  }

  return processWebhookDelivery(
    db,
    // The CHECK constraint `webhook_deliveries_one_target` guarantees exactly one
    // target is set, so reaching here means `subscription_id` is non-null.
    claimed as ClaimedDeliveryRow & { subscription_id: string },
    timeoutMs,
    maxAttempts,
  );
}

/**
 * The `web_push` delivery (ADR-172 D7, `NTF-04`/`NTF-05`). The delivery row was
 * persisted at fanout — intent BEFORE the send — and `delivered_at` is stamped
 * by `finishDelivery` only after a 2xx.
 *
 * An expired endpoint is the one outcome that mutates a second row: the
 * subscription is deleted, which cascades its delivery rows away, so no further
 * notification re-fails on it forever.
 */
async function processPushDelivery(
  db: Db,
  claimed: ClaimedDeliveryRow,
  maxAttempts: number,
): Promise<"delivered" | "dead" | "retry"> {
  const attemptCount = claimed.attempt_count + 1;
  const targetResult = await db.execute(sql`
    SELECT id, endpoint, p256dh, auth
    FROM push_subscriptions
    WHERE id = ${claimed.push_subscription_id}
  `);
  const target = (targetResult.rows ?? [])[0] as PushTarget | undefined;
  const evResult = await db.execute(sql`
    SELECT payload, type FROM webhook_events WHERE id = ${claimed.event_id}
  `);
  const eventRow = (evResult.rows ?? [])[0] as
    | { payload: WebhookEnvelopePayload | null; type: string }
    | undefined;

  if (!target || !eventRow?.payload) {
    return finishDelivery(db, {
      claimed,
      attemptCount,
      maxAttempts,
      errorKind: "config",
      httpStatus: undefined,
      durationMs: 0,
      errorDetail: "push endpoint or frozen payload missing",
      responseSnippet: null,
    });
  }

  const sent = await sendPush(
    target,
    pushPayloadFor(eventRow.payload, eventRow.type),
  );

  if (sent.outcome === "expired") {
    await deleteExpiredPushEndpoint(db, claimed, sent);

    return "dead";
  }

  return finishDelivery(db, {
    claimed,
    attemptCount,
    maxAttempts,
    type: eventRow.type,
    errorKind: sent.outcome === "retryable" ? sent.errorKind : undefined,
    httpStatus: sent.httpStatus,
    durationMs: sent.durationMs,
    errorDetail: sent.outcome === "delivered" ? null : (sent.detail ?? null),
    responseSnippet: null,
    // `terminal` is the one outcome `classifyResult` cannot derive from the
    // status: it would see a non-2xx, non-410 4xx below the attempt ceiling and
    // schedule a retry. The sender already decided no retry can succeed.
    terminal: sent.outcome === "terminal",
  });
}

/**
 * `NTF-05` / `EDGE-NTF-02`: a `410 Gone` (or `404`) is terminal and removes the
 * endpoint. The reader's OTHER transports are untouched — only this browser is
 * gone — which is why the `notification_subscriptions` intent is left alone.
 *
 * The delete is the WHOLE operation. `webhook_deliveries.push_subscription_id`
 * cascades from `push_subscriptions`, and `webhook_delivery_attempts.delivery_id`
 * cascades from `webhook_deliveries`, so this row and every attempt on it go
 * with the endpoint — which is what the ADR-172 amendment asks for. Stamping the
 * delivery `dead` first, or recording a final attempt, would be two writes the
 * same transaction deletes.
 */
async function deleteExpiredPushEndpoint(
  db: Db,
  claimed: ClaimedDeliveryRow,
  sent: { httpStatus: number },
): Promise<void> {
  await db.execute(sql`
    DELETE FROM push_subscriptions WHERE id = ${claimed.push_subscription_id}
  `);

  log.info(
    {
      deliveryId: claimed.id,
      httpStatus: sent.httpStatus,
    },
    "[scheduler.webhook_delivery] push endpoint deleted (410/404 gone)",
  );
}

async function processWebhookDelivery(
  db: Db,
  claimed: ClaimedDeliveryRow & { subscription_id: string },
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
  /**
   * The caller already knows no retry can succeed, so the retry curve is not
   * consulted. Only the push branch sets it: a push service answering `400`,
   * `403` or `413` is rejecting the REQUEST, and re-sending the same bytes
   * seven more times over a day changes nothing. `classifyResult` cannot reach
   * that verdict on status alone, because `408` and `429` are 4xx and ARE
   * retryable — the sender classifies, this only records.
   */
  terminal?: boolean;
};

async function finishDelivery(
  db: Db,
  input: FinishInput,
): Promise<"delivered" | "dead" | "retry"> {
  const { claimed, attemptCount, maxAttempts, errorKind, httpStatus } = input;

  const classification: DeliveryClassification = input.terminal
    ? // `reason` is required by the union and read by nothing; "gone" is the
      // nearer of its two members for a request the service will never accept.
      { outcome: "dead", reason: "gone" }
    : classifyResult({
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
            last_error_kind = NULL,
            last_error_message = NULL,
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
