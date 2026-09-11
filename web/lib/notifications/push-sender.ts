import "server-only";

/**
 * The web-push sender (ADR-172 D7, `NTF-04`, `NTF-05`).
 *
 * It is NOT a second delivery engine. The outbox is `webhook_events`, the
 * drainer is the `webhook_delivery` scheduler job, the retry curve is
 * `classifyResult`/`baseDelayMs`, and the ledger is `webhook_deliveries` — this
 * module only knows how to put an encrypted payload on a browser endpoint and
 * how to classify what comes back.
 *
 * TWO-PHASE COMMIT (D7): the caller persists the delivery row BEFORE calling
 * `sendPush`, and stamps `delivered_at` only after it returns `delivered`. That
 * ordering is what makes a crash between the two a duplicate send rather than a
 * lost notification, and at-least-once is the contract the service worker's
 * per-kind `tag` absorbs.
 */

import type { WebhookErrorKind } from "@/lib/webhooks/backoff";

import pino from "pino";
import webpush from "web-push";

import { resolveVapidConfig } from "@/lib/notifications/vapid";

const log = pino({
  name: "notifications-push",
  level: process.env.LOG_LEVEL ?? "info",
});

const DEFAULT_TIMEOUT_MS = 10_000;

export interface PushTarget {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** What the service worker shows. Built server-side; no secrets, ever. */
export interface PushPayload {
  title: string;
  body: string;
  url: string;
  /** One tag per notification KIND, so a redelivery replaces rather than stacks. */
  tag: string;
}

/**
 * The failure table `NTF-05` asks for, stated once and exhaustively.
 *
 * | result                    | outcome    | row after                       | on retry |
 * | ------------------------- | ---------- | ------------------------------- | -------- |
 * | 2xx                       | delivered  | `delivered_at` stamped          | —        |
 * | 404 / 410 (gone)          | expired    | endpoint DELETED with its rows  | never    |
 * | other 4xx                 | terminal   | `dead`, `delivered_at` null     | never    |
 * | 5xx                       | retryable  | `pending`, next_attempt_at set  | re-sent  |
 * | network / timeout         | retryable  | `pending`, next_attempt_at set  | re-sent  |
 * | VAPID unconfigured        | retryable  | `pending`, kind `config`        | re-sent once configured |
 *
 * `expired` is its own outcome rather than a flavour of `terminal` because it
 * mutates a SECOND row: the endpoint is gone, so keeping the subscription would
 * re-fail forever on every future notification.
 */
export type PushOutcome =
  | { outcome: "delivered"; httpStatus: number; durationMs: number }
  | { outcome: "expired"; httpStatus: number; durationMs: number }
  | {
      outcome: "terminal";
      httpStatus: number;
      durationMs: number;
      detail: string;
    }
  | {
      outcome: "retryable";
      httpStatus?: number;
      errorKind: WebhookErrorKind;
      durationMs: number;
      detail: string;
    };

/** 404 and 410 both mean "this endpoint is permanently gone" to a push service. */
const GONE_STATUSES = new Set([404, 410]);

function timeoutMs(): number {
  const raw = process.env.MAISTER_WEBHOOK_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_TIMEOUT_MS;

  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function statusOf(err: unknown): number | undefined {
  const status = (err as { statusCode?: unknown } | null)?.statusCode;

  return typeof status === "number" ? status : undefined;
}

export async function sendPush(
  target: PushTarget,
  payload: PushPayload,
): Promise<PushOutcome> {
  const vapid = resolveVapidConfig();
  const startedAt = Date.now();

  if (!vapid.ok) {
    // RETRYABLE, not terminal: an operator who exports the keys later must see
    // the queued notifications arrive rather than find them dead.
    return {
      outcome: "retryable",
      errorKind: "config",
      durationMs: 0,
      detail: `vapid unconfigured (${vapid.missing.join(", ")})`,
    };
  }

  try {
    const result = await webpush.sendNotification(
      {
        endpoint: target.endpoint,
        keys: { p256dh: target.p256dh, auth: target.auth },
      },
      JSON.stringify(payload),
      {
        vapidDetails: {
          subject: vapid.config.subject,
          publicKey: vapid.config.publicKey,
          privateKey: vapid.config.privateKey,
        },
        timeout: timeoutMs(),
        TTL: 60 * 60,
      },
    );
    const durationMs = Date.now() - startedAt;

    // The endpoint and the keys are NEVER logged: they identify a browser, and
    // the endpoint is a bearer capability for sending that browser push.
    log.debug(
      { pushSubscriptionId: target.id, httpStatus: result.statusCode },
      "push delivered",
    );

    return {
      outcome: "delivered",
      httpStatus: result.statusCode,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const httpStatus = statusOf(err);
    const detail = err instanceof Error ? err.message : String(err);

    if (httpStatus !== undefined && GONE_STATUSES.has(httpStatus)) {
      log.info(
        { pushSubscriptionId: target.id, httpStatus },
        "push endpoint gone — subscription will be deleted",
      );

      return { outcome: "expired", httpStatus, durationMs };
    }

    if (httpStatus !== undefined && httpStatus >= 400 && httpStatus <= 499) {
      return { outcome: "terminal", httpStatus, durationMs, detail };
    }

    if (httpStatus !== undefined) {
      return {
        outcome: "retryable",
        httpStatus,
        errorKind: "http",
        durationMs,
        detail,
      };
    }

    const aborted =
      detail.toLowerCase().includes("timeout") ||
      detail.toLowerCase().includes("aborted");

    return {
      outcome: "retryable",
      errorKind: aborted ? "timeout" : "network",
      durationMs,
      detail,
    };
  }
}
