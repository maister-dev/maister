import "server-only";

import type { Db } from "@/lib/execution-host/db";
import { domainEvents, taskLaunchIntents } from "@/lib/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  parseWorkspaceIntegrityLimit,
  type WorkspaceIntegrityLimit,
} from "@/lib/agents/operational-diagnostics";
import type { DomainEventActor } from "@/lib/domain-events/outbox";

import { emitDomainEvent } from "@/lib/domain-events/outbox";

/** State and its content-free invalidation commit together; replay emits nothing. */
export async function emitTaskLaunchChanged(
  db: Db,
  intent: typeof taskLaunchIntents.$inferSelect,
  actor: DomainEventActor,
  integrityLimit?: WorkspaceIntegrityLimit,
): Promise<void> {
  await emitDomainEvent({
    db,
    kind: "task.launch_changed",
    projectId: intent.projectId,
    taskId: intent.taskId,
    actor,
    ...(integrityLimit && intent.runId ? { runId: intent.runId } : {}),
    payload: {
      intentId: intent.id,
      state: intent.state,
      stateVersion: intent.stateVersion,
      basis: intent.basis.kind,
      ...(intent.reason ? { reason: intent.reason } : {}),
      ...(integrityLimit ? { integrityLimit } : {}),
    },
  });
}

/** Read after run access is granted, matching the current held intent revision. */
export async function loadTaskLaunchIntegrityLimit(
  db: Db,
  runId: string,
): Promise<WorkspaceIntegrityLimit | undefined> {
  const [row] = await db
    .select({
      limit: sql<unknown>`${domainEvents.payload}->'integrityLimit'`,
    })
    .from(taskLaunchIntents)
    .innerJoin(
      domainEvents,
      and(
        eq(domainEvents.runId, taskLaunchIntents.runId),
        eq(domainEvents.projectId, taskLaunchIntents.projectId),
        eq(domainEvents.kind, "task.launch_changed"),
        sql`${domainEvents.payload}->>'intentId' = ${taskLaunchIntents.id}`,
        sql`${domainEvents.payload}->>'stateVersion' = ${taskLaunchIntents.stateVersion}::text`,
      ),
    )
    .where(
      and(
        eq(taskLaunchIntents.runId, runId),
        eq(taskLaunchIntents.state, "held"),
        eq(taskLaunchIntents.reason, "launch_agent_integrity_refused"),
      ),
    )
    .orderBy(desc(domainEvents.id))
    .limit(1);

  return parseWorkspaceIntegrityLimit(row?.limit);
}
