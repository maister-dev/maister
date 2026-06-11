import "server-only";

import { randomUUID } from "node:crypto";

import pino from "pino";

import * as schemaModule from "@/lib/db/schema";

import type { TaskActivityEventKind } from "@/lib/db/schema";

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

// THE ONLY task_activity writer. Domain rule (ADR-078 D7): activity rows are
// written exclusively through this function, inside the same transaction as
// the triggering domain write — route handlers never insert directly.
export async function recordTaskActivity(
  tx: any,
  input: {
    taskId: string;
    projectId: string;
    actor: SocialActor;
    eventKind: TaskActivityEventKind;
    payload?: Record<string, unknown>;
  },
): Promise<string> {
  const id = randomUUID();

  await tx.insert(taskActivity).values({
    id,
    taskId: input.taskId,
    projectId: input.projectId,
    actorType: input.actor.type,
    actorId: input.actor.id,
    eventKind: input.eventKind,
    payload: input.payload ?? {},
  });

  log.debug(
    {
      taskId: input.taskId,
      eventKind: input.eventKind,
      actorType: input.actor.type,
    },
    "task activity recorded",
  );

  return id;
}
