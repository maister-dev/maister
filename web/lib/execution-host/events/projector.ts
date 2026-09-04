import "server-only";

import { randomUUID } from "node:crypto";

import { and, eq, gt, isNull, lt, or } from "drizzle-orm";

import type { Db } from "@/lib/execution-host/db";
import {
  executionEventConsumers,
  executionEvents,
  type ExecutionEvent,
} from "@/lib/db/schema";

const CLAIM_LEASE_MS = 30_000;
const MAX_TRANSIENT_ATTEMPTS = 5;

export class ExecutionEventProjectionError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = "ExecutionEventProjectionError";
  }
}

export type ExecutionEventProjector = {
  consumerName: string;
  project: (tx: Db, event: ExecutionEvent) => Promise<void>;
  // A process-local wake is allowed only after both the event projection and
  // durable cursor advance commit. It is an optimization: readers still query
  // Postgres after a missed wake.
  afterCommit?: (events: readonly ExecutionEvent[]) => void;
};

export type ExecutionEventProjectorSummary = {
  projected: number;
  deferred: boolean;
  poisoned: boolean;
  lastRunSequence: string | null;
};

function retryDelayMs(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), 60_000);
}

function canClaim(now: Date, owner: string) {
  return or(
    isNull(executionEventConsumers.claimExpiresAt),
    lt(executionEventConsumers.claimExpiresAt, now),
    eq(executionEventConsumers.claimOwner, owner),
  );
}

async function ensureConsumer(tx: Db, consumerName: string, runId: string): Promise<void> {
  await tx
    .insert(executionEventConsumers)
    .values({ consumerName, runId })
    .onConflictDoNothing();
}

// Every projector owns only its `(consumerName, runId)` cursor. The handler is
// deliberately database-only and runs inside the same transaction as cursor
// advancement, so a retry can never advance a view past a failed event.
export async function projectExecutionEvents(input: {
  db: Db;
  runId: string;
  projector: ExecutionEventProjector;
  owner?: string;
  now?: Date;
  batchSize?: number;
}): Promise<ExecutionEventProjectorSummary> {
  const owner = input.owner ?? `execution-event-projector:${randomUUID()}`;
  const now = input.now ?? new Date();
  const batchSize = Math.min(Math.max(input.batchSize ?? 100, 1), 500);
  let failedEventId: string | null = null;
  let failure: unknown = null;

  const transactionResult = await input.db.transaction(async (tx) => {
    await ensureConsumer(tx, input.projector.consumerName, input.runId);
    const consumers = await tx
      .select()
      .from(executionEventConsumers)
      .where(
        and(
          eq(executionEventConsumers.consumerName, input.projector.consumerName),
          eq(executionEventConsumers.runId, input.runId),
        ),
      )
      .for("update")
      .limit(1);
    const consumer = consumers[0];
    if (!consumer) throw new Error("execution event consumer row disappeared");
    if (consumer.state === "poisoned") {
      return {
        summary: {
          projected: 0,
          deferred: false,
          poisoned: true,
          lastRunSequence: consumer.lastRunSequence?.toString() ?? null,
        },
        projectedEvents: [] as ExecutionEvent[],
      };
    }
    if (consumer.nextRetryAt && consumer.nextRetryAt > now) {
      return {
        summary: {
          projected: 0,
          deferred: true,
          poisoned: false,
          lastRunSequence: consumer.lastRunSequence?.toString() ?? null,
        },
        projectedEvents: [] as ExecutionEvent[],
      };
    }
    const claimed = await tx
      .update(executionEventConsumers)
      .set({
        claimOwner: owner,
        claimExpiresAt: new Date(now.getTime() + CLAIM_LEASE_MS),
      })
      .where(
        and(
          eq(executionEventConsumers.consumerName, input.projector.consumerName),
          eq(executionEventConsumers.runId, input.runId),
          canClaim(now, owner),
        ),
      )
      .returning({ consumerName: executionEventConsumers.consumerName });
    if (!claimed[0]) {
      return {
        summary: {
          projected: 0,
          deferred: true,
          poisoned: false,
          lastRunSequence: consumer.lastRunSequence?.toString() ?? null,
        },
        projectedEvents: [] as ExecutionEvent[],
      };
    }

    const events = await tx
      .select()
      .from(executionEvents)
      .where(
        and(
          eq(executionEvents.runId, input.runId),
          gt(executionEvents.runSequence, consumer.lastRunSequence ?? -1n),
          eq(executionEvents.ingestDisposition, "accepted"),
        ),
      )
      .orderBy(executionEvents.runSequence)
      .limit(batchSize);
    let last = consumer.lastRunSequence;
    let projected = 0;
    const projectedEvents: ExecutionEvent[] = [];
    for (const event of events) {
      if (event.runSequence === null) {
        throw new Error("accepted execution event has no run sequence");
      }
      failedEventId = event.id;
      try {
        await input.projector.project(tx, event);
      } catch (error) {
        failure = error;
        throw error;
      }
      last = event.runSequence;
      projected += 1;
      projectedEvents.push(event);
    }
    await tx
      .update(executionEventConsumers)
      .set({
        lastRunSequence: last,
        state: "ready",
        attempts: 0,
        nextRetryAt: null,
        poisonEventId: null,
        lastError: null,
        claimOwner: null,
        claimExpiresAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(executionEventConsumers.consumerName, input.projector.consumerName),
          eq(executionEventConsumers.runId, input.runId),
          eq(executionEventConsumers.claimOwner, owner),
        ),
      );
    return {
      summary: {
        projected,
        deferred: false,
        poisoned: false,
        lastRunSequence: last?.toString() ?? null,
      },
      projectedEvents,
    };
  }).catch(async (error) => {
    if (!failedEventId) throw error;
    const summary = await recordProjectionFailure({
      db: input.db,
      runId: input.runId,
      consumerName: input.projector.consumerName,
      eventId: failedEventId,
      error: failure ?? error,
      now,
    });
    return { summary, projectedEvents: [] as ExecutionEvent[] };
  });
  if (transactionResult.projectedEvents.length > 0) {
    input.projector.afterCommit?.(transactionResult.projectedEvents);
  }
  return transactionResult.summary;
}

async function recordProjectionFailure(input: {
  db: Db;
  runId: string;
  consumerName: string;
  eventId: string;
  error: unknown;
  now: Date;
}): Promise<ExecutionEventProjectorSummary> {
  return input.db.transaction(async (tx) => {
    const consumers = await tx
      .select()
      .from(executionEventConsumers)
      .where(
        and(
          eq(executionEventConsumers.consumerName, input.consumerName),
          eq(executionEventConsumers.runId, input.runId),
        ),
      )
      .for("update")
      .limit(1);
    const consumer = consumers[0];
    if (!consumer) throw new Error("execution event consumer row disappeared after projection failure");
    const attempts = consumer.attempts + 1;
    const permanent = input.error instanceof ExecutionEventProjectionError && input.error.permanent;
    const poisoned = permanent || attempts >= MAX_TRANSIENT_ATTEMPTS;
    const lastError = {
      reason: permanent ? "deterministic_projection_failure" : "projection_failure",
      type: input.error instanceof Error ? input.error.name : "unknown",
      message: input.error instanceof Error ? input.error.message.slice(0, 512) : "unknown projection failure",
    };
    await tx
      .update(executionEventConsumers)
      .set({
        state: poisoned ? "poisoned" : "retrying",
        attempts,
        nextRetryAt: poisoned ? null : new Date(input.now.getTime() + retryDelayMs(attempts)),
        poisonEventId: poisoned ? input.eventId : null,
        lastError,
        claimOwner: null,
        claimExpiresAt: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(executionEventConsumers.consumerName, input.consumerName),
          eq(executionEventConsumers.runId, input.runId),
        ),
      );
    return {
      projected: 0,
      deferred: !poisoned,
      poisoned,
      lastRunSequence: consumer.lastRunSequence?.toString() ?? null,
    };
  });
}
