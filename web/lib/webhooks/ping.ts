import "server-only";

import type { WebhookErrorKind } from "./backoff";

import { randomUUID } from "node:crypto";

import pino from "pino";

import { buildEnvelopePayload, finalizeEnvelope } from "./taxonomy";
import { resolveEnvRef, resolveMaybeEnvRef } from "./signing";
import { signAndSend } from "./send";

// FIXME(any): dual drizzle-orm peer-dep variants — pg|sqlite union.
type Db = any;

const DEFAULT_TIMEOUT_MS = 10_000;

function pingTimeoutMs(): number {
  const raw = process.env.MAISTER_WEBHOOK_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_TIMEOUT_MS;

  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_TIMEOUT_MS;

  return parsed;
}

const log = pino({
  name: "webhooks-ping",
  level: process.env.LOG_LEVEL ?? "info",
});

export interface PingSubscriptionRow {
  id: string;
  url: string;
  method: string;
  headers: Record<string, string> | null;
  signingSecretRef: string;
  secondarySigningSecretRef: string | null;
}

export interface PingSubscriptionInput {
  subscription: PingSubscriptionRow;
  // Accepted for call-site symmetry with the route/test; ping persists NOTHING
  // (documented 2PC exemption), so the handle is never read here.
  db?: Db;
}

export interface PingResult {
  ok: boolean;
  httpStatus?: number;
  durationMs: number;
  errorKind?: WebhookErrorKind;
}

// DQ8 test-ping: a user-initiated, synchronous signed POST of a synthetic `ping`
// envelope to the subscription endpoint. NO persistence — no webhook_events /
// _deliveries / _attempts row is written (so there is no two-phase-commit
// obligation). The secret/url/headers are NEVER logged.
export async function pingSubscription(
  input: PingSubscriptionInput,
): Promise<PingResult> {
  const { subscription } = input;

  const deliveryId = randomUUID();
  const payload = buildEnvelopePayload({
    eventId: randomUUID(),
    type: "ping",
    occurredAt: new Date(),
    data: { message: "MAIster webhook ping" },
    project: null,
    run: null,
  });
  const envelope = finalizeEnvelope(payload, deliveryId, 1);
  const rawBody = JSON.stringify(envelope);

  const secret = resolveEnvRef(subscription.signingSecretRef);
  const secondarySecret = subscription.secondarySigningSecretRef
    ? resolveEnvRef(subscription.secondarySigningSecretRef)
    : null;
  const resolvedHeaders: Record<string, string> = {};

  for (const [k, v] of Object.entries(subscription.headers ?? {})) {
    resolvedHeaders[k] = resolveMaybeEnvRef(v);
  }

  const sent = await signAndSend({
    url: subscription.url,
    method: subscription.method,
    type: "ping",
    eventId: payload.id,
    deliveryId,
    subscriptionId: subscription.id,
    rawBody,
    secret,
    secondarySecret,
    extraHeaders: resolvedHeaders,
    timeoutMs: pingTimeoutMs(),
  });

  const ok =
    sent.httpStatus != null && sent.httpStatus >= 200 && sent.httpStatus <= 299;

  log.info(
    { subscriptionId: subscription.id, ok, httpStatus: sent.httpStatus },
    "[webhooks.ping]",
  );

  return {
    ok,
    httpStatus: sent.httpStatus,
    durationMs: sent.durationMs,
    errorKind: sent.errorKind,
  };
}
