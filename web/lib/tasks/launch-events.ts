import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { taskLaunchIntents } from "@/lib/db/schema";
import type { DomainEventActor } from "@/lib/domain-events/outbox";

import { emitDomainEvent } from "@/lib/domain-events/outbox";

/** State and its content-free invalidation commit together; replay emits nothing. */
export async function emitTaskLaunchChanged(
  db: Db,
  intent: typeof taskLaunchIntents.$inferSelect,
  actor: DomainEventActor,
): Promise<void> {
  await emitDomainEvent({
    db,
    kind: "task.launch_changed",
    projectId: intent.projectId,
    taskId: intent.taskId,
    actor,
    payload: {
      intentId: intent.id,
      state: intent.state,
      stateVersion: intent.stateVersion,
      basis: intent.basis.kind,
      ...(intent.reason ? { reason: intent.reason } : {}),
    },
  });
}
