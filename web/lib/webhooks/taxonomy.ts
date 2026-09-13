// NOTE: intentionally NOT "server-only". This module is pure, secret-free data
// (the event-type list + envelope-shape builders) and the client subscription
// modal imports WEBHOOK_EVENT_TYPES for its event-type checkboxes. A
// "server-only" guard here makes the whole /settings webhooks panel fail to
// build ("server-only cannot be imported from a Client Component").

export const WEBHOOK_API_VERSION = 1 as const;

export const WEBHOOK_EVENT_TYPES = [
  "run.started",
  "run.needs_input",
  "run.escalated",
  // ADR-160 operator rework round-trip.
  "run.rework_claimed",
  "run.rework_returned",
  "hitl.requested",
  "hitl.responded",
  "run.review",
  "run.promoted",
  "run.done",
  "run.failed",
  "run.crashed",
  "run.abandoned",
  // ADR-140: PR lifecycle edges, emitted by the pr_state_scan handler.
  "run.pr_merged",
  "run.pr_closed",
  "run.pr_conflicts",
  "gate.decided",
  "ping",
  // ADR-173: the four USER-scoped attention facts. Their envelopes carry
  // `project: null` and `run: null` — a shape D4 notes consumers were already
  // obliged to handle, so there is no `apiVersion` bump.
  "attention.decision_opened",
  "attention.decision_closed",
  "attention.decisions_changed",
  "attention.digest",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

const WEBHOOK_EVENT_TYPE_SET = new Set<string>(WEBHOOK_EVENT_TYPES);

export function isWebhookEventType(s: string): s is WebhookEventType {
  return WEBHOOK_EVENT_TYPE_SET.has(s);
}

/**
 * The four `attention.*` types, as their own list. A notification subscription
 * may name only these, and only deltas and the digest exist — a per-event
 * stream is the anti-pattern `NTF-08` forbids.
 */
export const ATTENTION_WEBHOOK_EVENT_TYPES = [
  "attention.decision_opened",
  "attention.decision_closed",
  "attention.decisions_changed",
  "attention.digest",
] as const satisfies readonly WebhookEventType[];

export type AttentionWebhookEventType =
  (typeof ATTENTION_WEBHOOK_EVENT_TYPES)[number];

const ATTENTION_TYPE_SET: ReadonlySet<string> = new Set(
  ATTENTION_WEBHOOK_EVENT_TYPES,
);

export function isAttentionWebhookEventType(
  value: string,
): value is AttentionWebhookEventType {
  return ATTENTION_TYPE_SET.has(value);
}

export interface WebhookProjectRef {
  id: string;
  slug: string;
  name: string;
}

export interface WebhookRunRef {
  id: string;
  taskId: string | null;
  flowId: string | null;
  branch: string | null;
  status: string;
}

export interface WebhookEnvelopePayload {
  apiVersion: 1;
  id: string;
  type: WebhookEventType;
  occurredAt: string;
  project: WebhookProjectRef | null;
  run: WebhookRunRef | null;
  data: Record<string, unknown>;
}

export interface WebhookEnvelope extends WebhookEnvelopePayload {
  deliveryId: string;
  attempt: number;
}

export interface BuildEnvelopePayloadInput {
  eventId: string;
  type: WebhookEventType;
  occurredAt: Date | string;
  project: WebhookProjectRef | null;
  run: WebhookRunRef | null;
  data: Record<string, unknown>;
}

export function buildEnvelopePayload(
  input: BuildEnvelopePayloadInput,
): WebhookEnvelopePayload {
  return {
    apiVersion: WEBHOOK_API_VERSION,
    id: input.eventId,
    type: input.type,
    occurredAt: new Date(input.occurredAt).toISOString(),
    project: input.project,
    run: input.run,
    data: input.data,
  };
}

export function finalizeEnvelope(
  payload: WebhookEnvelopePayload,
  deliveryId: string,
  attempt: number,
): WebhookEnvelope {
  return { ...payload, deliveryId, attempt };
}
