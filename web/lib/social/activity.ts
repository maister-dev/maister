import "server-only";

import type { TaskActivityEventKind } from "@/lib/db/schema";

import { randomUUID } from "node:crypto";

import pino from "pino";

import * as schemaModule from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/services/tasks.ts).
const { taskActivity } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "social-activity",
  level: process.env.LOG_LEVEL ?? "info",
});

export type SocialActor =
  | { type: "user"; id: string }
  | { type: "agent"; id: string }
  | { type: "system"; id: null };

export function actorForUserId(userId: string | null | undefined): SocialActor {
  return userId ? { type: "user", id: userId } : { type: "system", id: null };
}

export type TaskActivityInput = {
  taskId: string;
  projectId: string;
  actor: SocialActor;
  eventKind: TaskActivityEventKind;
  payload?: Record<string, unknown>;
};

async function insertActivity(
  tx: any,
  input: TaskActivityInput,
  idempotent: boolean,
): Promise<string | null> {
  const id = randomUUID();
  const values = {
    id,
    taskId: input.taskId,
    projectId: input.projectId,
    actorType: input.actor.type,
    actorId: input.actor.id,
    eventKind: input.eventKind,
    payload: input.payload ?? {},
  };
  const insert = tx.insert(taskActivity).values(values);
  let inserted = true;

  if (idempotent) {
    const rows = await insert
      .onConflictDoNothing()
      .returning({ id: taskActivity.id });

    inserted = rows.length > 0;
  } else {
    await insert;
  }

  log.debug(
    {
      taskId: input.taskId,
      eventKind: input.eventKind,
      actorType: input.actor.type,
      inserted,
    },
    "task activity recorded",
  );

  return inserted ? id : null;
}

// THE ONLY task_activity writer. Domain rule (ADR-078 D7, restated by
// ADR-151): activity rows are written exclusively through this module, by
// either the originating domain transaction or a system-actored async
// consumer/job whose write is idempotent by construction. Route handlers
// never insert directly.
export async function recordTaskActivity(
  tx: any,
  input: TaskActivityInput,
): Promise<string> {
  return (await insertActivity(tx, input, false)) as string;
}

/**
 * The idempotent variant for a system-actored async consumer (ADR-151).
 *
 * Returns false when a unique backstop collapsed the write — for
 * `agent_summon_suppressed` that is `task_activity_agent_summon_uq`, which
 * makes at-least-once event redelivery a no-op WITHOUT a read-then-write
 * TOCTOU window.
 */
export async function recordTaskActivityOnce(
  tx: any,
  input: TaskActivityInput,
): Promise<boolean> {
  return (await insertActivity(tx, input, true)) !== null;
}
