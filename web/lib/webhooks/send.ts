import "server-only";

import type { WebhookErrorKind } from "./backoff";
import type { WebhookEventType } from "./taxonomy";

import { fetch as undiciFetch, type Dispatcher } from "undici";

import { buildDeliveryHeaders } from "./signing";
import { pinnedDispatcher, resolveAllowedDestination } from "./destination";

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
// or returned. The egress policy runs BEFORE signing: a blocked destination is
// a `config` failure that never reaches the wire, and a hostname destination
// connects through a dispatcher pinned to the vetted DNS answers (rebind-safe).
// HTTP/timeout/network outcomes are reported inline; only the caller's own
// bugs throw.
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

  const destination = await resolveAllowedDestination(parsedUrl.hostname);

  if (!destination.ok) {
    return {
      httpStatus: undefined,
      errorKind: "config",
      responseSnippet: null,
      errorDetail:
        destination.reason ?? "destination blocked by the egress policy",
      durationMs: 0,
    };
  }

  const dispatcher: Dispatcher | undefined = destination.addresses
    ? pinnedDispatcher(destination.addresses)
    : undefined;

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
    const res = await undiciFetch(input.url, {
      method: input.method,
      headers,
      body: input.rawBody,
      redirect: "manual",
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {}),
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
    await dispatcher?.close().catch(() => undefined);
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
