import "server-only";

export const WEBHOOK_API_VERSION = 1 as const;

export const WEBHOOK_EVENT_TYPES = [
  "run.started",
  "run.needs_input",
  "hitl.requested",
  "hitl.responded",
  "run.review",
  "run.promoted",
  "run.done",
  "run.failed",
  "run.crashed",
  "run.abandoned",
  "gate.decided",
  "ping",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

const WEBHOOK_EVENT_TYPE_SET = new Set<string>(WEBHOOK_EVENT_TYPES);

export function isWebhookEventType(s: string): s is WebhookEventType {
  return WEBHOOK_EVENT_TYPE_SET.has(s);
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
