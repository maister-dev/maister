import "server-only";

import { sql } from "drizzle-orm";
import pino from "pino";

import type { InboxSourceRef, TaskActivityEventKind } from "@/lib/db/schema";
import type { SocialActor } from "@/lib/social/activity";

import { getDb } from "@/lib/db/client";

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "social-inbox",
  level: process.env.LOG_LEVEL ?? "info",
});

// One batch INSERT … SELECT over the task's subscribers, excluding the acting
// pair, inside the caller's transaction (ADR-078 D9). Stage-1 triggers are
// comment_added and task_mentioned only.
export async function fanoutToSubscribers(
  tx: any,
  input: {
    taskId: string;
    projectId: string;
    eventKind: TaskActivityEventKind;
    sourceRef: InboxSourceRef;
    excludeActor: SocialActor;
  },
): Promise<number> {
  const result = await tx.execute(sql`
    insert into inbox_items
      (id, recipient_type, recipient_id, project_id, task_id, event_kind, source_ref)
    select
      gen_random_uuid()::text,
      s.subscriber_type,
      s.subscriber_id,
      ${input.projectId},
      ${input.taskId},
      ${input.eventKind},
      ${JSON.stringify(input.sourceRef)}::jsonb
    from task_subscribers s
    where s.task_id = ${input.taskId}
      and not (
        s.subscriber_type = ${input.excludeActor.type}
        and s.subscriber_id is not distinct from ${input.excludeActor.id}
      )
  `);

  const fanout = Number(result.rowCount ?? 0);

  log.debug(
    { taskId: input.taskId, eventKind: input.eventKind, fanout },
    "inbox fanout",
  );

  return fanout;
}

// Recipient-owned read mutations (ADR-078 D9): a session user can mark only
// their own items; a foreign or missing itemId is indistinguishable (404 at
// the route). The first read_at is preserved on repeat marks.
export async function markInboxItemRead(
  input: { itemId: string; userId: string },
  db?: Db,
): Promise<boolean> {
  const _db = (db ?? getDb()) as unknown as { execute: any };
  const result = await _db.execute(sql`
    update inbox_items
    set read_at = coalesce(read_at, now())
    where id = ${input.itemId}
      and recipient_type = 'user'
      and recipient_id = ${input.userId}
  `);

  const marked = Number(result.rowCount ?? 0) > 0;

  log.debug({ itemId: input.itemId, marked }, "inbox item read");

  return marked;
}

export async function markAllInboxRead(
  input: { userId: string },
  db?: Db,
): Promise<number> {
  const _db = (db ?? getDb()) as unknown as { execute: any };
  const result = await _db.execute(sql`
    update inbox_items
    set read_at = now()
    where recipient_type = 'user'
      and recipient_id = ${input.userId}
      and read_at is null
  `);

  const updated = Number(result.rowCount ?? 0);

  log.info({ userId: input.userId, updated }, "inbox read-all");

  return updated;
}
