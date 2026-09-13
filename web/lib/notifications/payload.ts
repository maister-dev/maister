import "server-only";

/**
 * Envelope → notification payload (ADR-173 D6, `NTF-08`).
 *
 * The sentence is NOT written here. The digest's text is built by
 * `formatDigest` (`lib/queries/digest.ts`) at emit time and carried in the
 * event's `data`, because determinism is the property that makes an
 * at-least-once notification safe: the same window and the same rows produce
 * byte-identical output, so a redelivery reads as the same notification rather
 * than as a second, slightly different one.
 *
 * This module only chooses the title, the click target, and the replace-tag.
 */

import type { PushPayload } from "@/lib/notifications/push-sender";
import type { WebhookEnvelopePayload } from "@/lib/webhooks/taxonomy";

/**
 * One tag per notification KIND, never per event. Two banners for the same fact
 * is the shape that gets a channel muted, and at-least-once delivery means the
 * same fact WILL sometimes arrive twice.
 */
const TAG_BY_TYPE: Record<string, string> = {
  "attention.decision_opened": "maister-decisions",
  "attention.decision_closed": "maister-decisions",
  "attention.decisions_changed": "maister-decisions",
  "attention.digest": "maister-digest",
};

const URL_BY_TYPE: Record<string, string> = {
  "attention.decision_opened": "/inbox",
  "attention.decision_closed": "/inbox",
  "attention.decisions_changed": "/inbox",
  "attention.digest": "/",
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function pushPayloadFor(
  payload: WebhookEnvelopePayload,
  type: string,
): PushPayload {
  const data = payload.data ?? {};
  const decisions = count(data.decisions);
  // The pre-rendered, locale-resolved sentence. Absent means the emitter had
  // nothing to say, and an empty body is better than an invented one.
  const sentence = text(data.sentence);

  const body =
    sentence ??
    (decisions !== null
      ? `${decisions} ${decisions === 1 ? "decision" : "decisions"} waiting`
      : "");

  return {
    title: text(data.title) ?? "MAIster",
    body,
    url: text(data.url) ?? URL_BY_TYPE[type] ?? "/",
    tag: TAG_BY_TYPE[type] ?? "maister",
  };
}
