import "server-only";

import type { WebhookErrorKind } from "./backoff";
import type { WebhookEventType } from "./taxonomy";

import { buildDeliveryHeaders } from "./signing";

const MAX_TEXT = 1024;

export function truncate(value: string | null | undefined): string | null {
  if (value == null) return null;

  return value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) : value;
}

export interface SignAndSendInput {
  url: string;
  method: string;
  type: WebhookEventType;
  eventId: string;
  deliveryId: string;
  subscriptionId: string;
  rawBody: string;
  secret: string;
  secondarySecret: string | null;
  extraHeaders: Record<string, string>;
  timeoutMs: number;
}

export interface SignAndSendResult {
  httpStatus?: number;
  // Only the network-level kinds (`http | timeout | network`). A `config`-kind
  // failure (unresolved env ref / credential-embedding URL) is decided by the
  // caller BEFORE signing — it never reaches the wire.
  errorKind?: WebhookErrorKind;
  responseSnippet: string | null;
  errorDetail: string | null;
  durationMs: number;
}

// Sign a webhook envelope and POST it once, sharing identical behavior between
// the drain's per-delivery send and the synchronous test-ping. Reject a
// credential-embedding URL BEFORE fetch: a `https://user:pass@host` URL makes
// fetch throw a TypeError carrying the password, which must never be persisted
// or returned. HTTP/timeout/network outcomes are reported inline; only the
// caller's own bugs throw.
export async function signAndSend(
  input: SignAndSendInput,
): Promise<SignAndSendResult> {
  let parsedUrl: URL | null;

  try {
    parsedUrl = new URL(input.url);
  } catch {
    parsedUrl = null;
  }

  if (
    parsedUrl === null ||
    parsedUrl.username !== "" ||
    parsedUrl.password !== ""
  ) {
    return {
      httpStatus: undefined,
      errorKind: "config",
      responseSnippet: null,
      errorDetail: "subscription url invalid or must not embed credentials",
      durationMs: 0,
    };
  }

  const t = Math.floor(Date.now() / 1000);
  const headers = buildDeliveryHeaders({
    type: input.type,
    eventId: input.eventId,
    deliveryId: input.deliveryId,
    subscriptionId: input.subscriptionId,
    t,
    rawBody: input.rawBody,
    secret: input.secret,
    secondarySecret: input.secondarySecret,
    extraHeaders: input.extraHeaders,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  const startedAt = Date.now();

  let httpStatus: number | undefined;
  let errorKind: WebhookErrorKind | undefined;
  let responseSnippet: string | null = null;
  let errorDetail: string | null = null;

  try {
    const res = await fetch(input.url, {
      method: input.method,
      headers,
      body: input.rawBody,
      redirect: "manual",
      signal: controller.signal,
    });

    httpStatus = res.status;

    const text = await res.text().catch(() => "");

    if (res.status < 200 || res.status > 299) {
      errorKind = "http";
      responseSnippet = truncate(text);
      errorDetail = `HTTP ${res.status}`;
    }
  } catch (err) {
    if (isAbortError(err)) {
      errorKind = "timeout";
      errorDetail = "request aborted after timeout";
    } else {
      errorKind = "network";
      errorDetail = truncate(err instanceof Error ? err.message : String(err));
    }
  } finally {
    clearTimeout(timer);
  }

  return {
    httpStatus,
    errorKind,
    responseSnippet,
    errorDetail,
    durationMs: Date.now() - startedAt,
  };
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.name === "TimeoutError")
  );
}
