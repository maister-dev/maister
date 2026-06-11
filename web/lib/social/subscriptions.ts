import "server-only";

import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import * as schemaModule from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/services/tasks.ts).
const { taskSubscribers } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "social-subscriptions",
  level: process.env.LOG_LEVEL ?? "info",
});

export type Subscriber = { type: "user" | "agent"; id: string };
export type SubscriptionReason =
  | "creator"
  | "commenter"
  | "mentioned"
  | "manual";

// Upsert is ON CONFLICT DO NOTHING against UNIQUE(task_id, subscriber_type,
// subscriber_id) — the FIRST reason wins and is never overwritten (ADR-078 D8).
export async function subscribe(
  tx: any,
  input: { taskId: string; subscriber: Subscriber; reason: SubscriptionReason },
): Promise<boolean> {
  const inserted = await tx
    .insert(taskSubscribers)
    .values({
      id: randomUUID(),
      taskId: input.taskId,
      subscriberType: input.subscriber.type,
      subscriberId: input.subscriber.id,
      reason: input.reason,
    })
    .onConflictDoNothing()
    .returning({ id: taskSubscribers.id });

  const created = inserted.length > 0;

  log.debug(
    {
      taskId: input.taskId,
      subscriberType: input.subscriber.type,
      reason: input.reason,
      created,
    },
    "subscription upserted",
  );

  return created;
}

export async function unsubscribe(
  tx: any,
  input: { taskId: string; subscriber: Subscriber },
): Promise<boolean> {
  const deleted = await tx
    .delete(taskSubscribers)
    .where(
      and(
        eq(taskSubscribers.taskId, input.taskId),
        eq(taskSubscribers.subscriberType, input.subscriber.type),
        eq(taskSubscribers.subscriberId, input.subscriber.id),
      ),
    )
    .returning({ id: taskSubscribers.id });

  const removed = deleted.length > 0;

  log.debug(
    { taskId: input.taskId, subscriberType: input.subscriber.type, removed },
    "subscription removed",
  );

  return removed;
}
