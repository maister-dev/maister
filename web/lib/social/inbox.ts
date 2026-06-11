import "server-only";

import { sql } from "drizzle-orm";
import pino from "pino";

import type { InboxSourceRef, TaskActivityEventKind } from "@/lib/db/schema";
import type { SocialActor } from "@/lib/social/activity";

const log = pino({
  name: "social-inbox",
  level: process.env.LOG_LEVEL ?? "info",
});

// One batch INSERT … SELECT over the task's subscribers, excluding the acting
// pair, inside the caller's transaction (ADR-075 D9). Stage-1 triggers are
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
