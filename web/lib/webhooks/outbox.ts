import "server-only";

import type {
  AttentionWebhookEventType,
  WebhookEventType,
} from "@/lib/webhooks/taxonomy";

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

/**
 * ADR-172 D2 reader #1. `projectId` and `runId` are OPTIONAL since the ADR-172 widening: a
 * user-scoped `attention.*` fact has neither. They stay required-looking for
 * every existing caller because `emitWebhookEvent` is typed as a union —
 * omitting them is only legal on the user-scoped overload, so a run-scoped
 * caller cannot silently drop its ids.
 */
interface EmitProjectScopedInput {
  db: Db;
  type: WebhookEventType;
  projectId: string;
  runId: string;
  data: Record<string, unknown>;
  occurredAt?: Date;
}

interface EmitUserScopedInput {
  db: Db;
  type: AttentionWebhookEventType;
  /** The reader the fact belongs to. Fan-out matches on this, not on a project. */
  ownerUserId: string;
  data: Record<string, unknown>;
  occurredAt?: Date;
}

export type EmitWebhookEventInput =
  | EmitProjectScopedInput
  | EmitUserScopedInput;

function isUserScoped(
  input: EmitWebhookEventInput,
): input is EmitUserScopedInput {
  return "ownerUserId" in input;
}

export async function emitWebhookEvent(
  input: EmitWebhookEventInput,
): Promise<string> {
  const id = randomUUID();
  const userScoped = isUserScoped(input);

  await input.db.insert(webhookEvents).values({
    id,
    projectId: userScoped ? null : input.projectId,
    runId: userScoped ? null : input.runId,
    type: input.type,
    // The owner travels in `data` rather than in a column of its own: ADR-172
    // rejected adding `user_id` to the table (it would be D3's bug with an
    // extra column). Fan-out reads it back from here.
    data: userScoped
      ? { ...input.data, ownerUserId: input.ownerUserId }
      : input.data,
    payload: null,
    occurredAt: input.occurredAt ?? new Date(),
  });

  log.debug(
    {
      type: input.type,
      runId: userScoped ? null : input.runId,
      ownerUserId: userScoped ? input.ownerUserId : null,
      eventId: id,
    },
    "[webhooks.outbox] emitted",
  );

  return id;
}
