import "server-only";

import type { WebhookEventType } from "@/lib/webhooks/taxonomy";

import { randomUUID } from "node:crypto";

import pino from "pino";

import { webhookEvents } from "@/lib/db/schema";

const log = pino({
  name: "webhooks-outbox",
  level: process.env.LOG_LEVEL ?? "info",
});

// FIXME(any): dual drizzle-orm peer-dep variants — accepts both a plain db and
// a tx handle so the capture rides the caller's transaction (matches the
// state-transitions.ts / gate-store.ts idiom).
type Db = any;

export interface EmitWebhookEventInput {
  db: Db;
  type: WebhookEventType;
  projectId: string;
  runId: string;
  data: Record<string, unknown>;
  occurredAt?: Date;
}

export async function emitWebhookEvent(
  input: EmitWebhookEventInput,
): Promise<string> {
  const id = randomUUID();

  await input.db.insert(webhookEvents).values({
    id,
    projectId: input.projectId,
    runId: input.runId,
    type: input.type,
    data: input.data,
    payload: null,
    occurredAt: input.occurredAt ?? new Date(),
  });

  log.debug(
    { type: input.type, runId: input.runId, eventId: id },
    "[webhooks.outbox] emitted",
  );

  return id;
}
