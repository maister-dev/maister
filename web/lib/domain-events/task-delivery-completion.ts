import "server-only";

import type { DomainEventRow } from "@/lib/db/schema";
import type { DomainEventConsumer } from "@/lib/domain-events/consumers";

import pino from "pino";

import { getDb } from "@/lib/db/client";
import { completeTaskFromConfirmedMerge } from "@/lib/services/task-completion";

// FIXME(any): narrow after the repository converges on one drizzle peer.
type Db = any;

const log = pino({
  name: "task-delivery-completion",
  level: process.env.LOG_LEVEL ?? "info",
});

// ADR-207: both orders of "PR merged" and "Run finalized" reach the same
// idempotent evaluation; whichever arrives last completes the task.
const TRIGGER_KINDS: readonly string[] = ["run.pr_merged", "run.done"];

export function buildTaskDeliveryCompletionConsumer(
  opts: { db?: Db } = {},
): DomainEventConsumer {
  return {
    id: "task_delivery_completion",
    // History before registration is the one-time reconciliation's job.
    startFrom: "now",
    async handle(events: DomainEventRow[]): Promise<void> {
      const db = opts.db ?? getDb();

      for (const event of events) {
        if (!TRIGGER_KINDS.includes(event.kind)) continue;
        if (!event.taskId || !event.runId) continue;

        const { taskId, runId } = event;

        // Deterministic skips and refusals return normally and the cursor
        // advances; only an unexpected error throws for dispatcher retry.
        try {
          await db.transaction((tx: Db) =>
            completeTaskFromConfirmedMerge(taskId, runId, tx),
          );
        } catch (err) {
          log.error(
            {
              eventId: event.id,
              taskId,
              runId,
              err: err instanceof Error ? err.message : String(err),
            },
            "[taskDeliveryCompletion] unexpected failure — will be retried",
          );
          throw err;
        }
      }
    },
  };
}

export const taskDeliveryCompletionConsumer =
  buildTaskDeliveryCompletionConsumer();
