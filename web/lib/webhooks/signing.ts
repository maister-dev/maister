import "server-only";

import type { WebhookEventType } from "./taxonomy";

import { createHash, createHmac } from "node:crypto";

import { MaisterError } from "@/lib/errors";

type WebhookEnv = Record<string, string | undefined>;

const ENV_REF = /^env:[A-Za-z_][A-Za-z0-9_]*$/;

export function isEnvRef(s: string): boolean {
  return ENV_REF.test(s);
}

export function resolveEnvRef(
  ref: string,
  env: WebhookEnv = process.env,
): string {
  if (!isEnvRef(ref)) {
    throw new MaisterError(
      "CONFIG",
      `webhook signing secret "${ref}" is not an env: reference`,
    );
  }

  const name = ref.slice("env:".length);
  const value = env[name];

  if (value === undefined || value === "") {
    throw new MaisterError(
      "CONFIG",
      `webhook signing secret env var "${name}" is not set`,
    );
  }

  return value;
}

export function resolveMaybeEnvRef(
  value: string,
  env: WebhookEnv = process.env,
): string {
  return isEnvRef(value) ? resolveEnvRef(value, env) : value;
}

export function idempotencyKey(
  subscriptionId: string,
  eventId: string,
): string {
  return createHash("sha256")
    .update(`${subscriptionId}:${eventId}`)
    .digest("hex");
}

export function signatureBaseString(
  t: number,
  deliveryId: string,
  rawBody: string,
): string {
  return `${t}.${deliveryId}.${rawBody}`;
}

export function hmacHex(secret: string, base: string): string {
  return createHmac("sha256", secret).update(base).digest("hex");
}

export interface BuildSignatureHeaderInput {
  t: number;
  deliveryId: string;
  rawBody: string;
  secret: string;
  secondarySecret?: string | null;
}

export function buildSignatureHeader(input: BuildSignatureHeaderInput): string {
  const base = signatureBaseString(input.t, input.deliveryId, input.rawBody);
  const parts = [`v1=${hmacHex(input.secret, base)}`];

  if (input.secondarySecret) {
    parts.push(`v1=${hmacHex(input.secondarySecret, base)}`);
  }

  return `t=${input.t},${parts.join(",")}`;
}

export interface BuildDeliveryHeadersInput {
  type: WebhookEventType;
  eventId: string;
  deliveryId: string;
  subscriptionId: string;
  t: number;
  rawBody: string;
  secret: string;
  secondarySecret?: string | null;
  extraHeaders?: Record<string, string>;
}

export function buildDeliveryHeaders(
  input: BuildDeliveryHeadersInput,
): Record<string, string> {
  const headers: Record<string, string> = { ...(input.extraHeaders ?? {}) };

  headers["Content-Type"] = "application/json";
  headers["User-Agent"] = "MAIster-Webhooks/1";
  headers["X-Maister-Event"] = input.type;
  headers["X-Maister-Event-Id"] = input.eventId;
  headers["X-Maister-Delivery-Id"] = input.deliveryId;
  headers["X-Maister-Idempotency-Key"] = idempotencyKey(
    input.subscriptionId,
    input.eventId,
  );
  headers["X-Maister-Signature"] = buildSignatureHeader({
    t: input.t,
    deliveryId: input.deliveryId,
    rawBody: input.rawBody,
    secret: input.secret,
    secondarySecret: input.secondarySecret,
  });

  return headers;
}
