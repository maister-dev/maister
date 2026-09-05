import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import { and, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import pino from "pino";

import { projectionTransaction } from "./projection-transaction";
import { runEventWakeBus } from "./run-wake";

import {
  executionEventConsumers,
  executionEvents,
  type ExecutionEvent,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const CLAIM_LEASE_MS = 30_000;
const MAX_TRANSIENT_ATTEMPTS = 5;
const logger = pino({
  name: "execution-event-projector",
  level: process.env.LOG_LEVEL ?? "info",
});

export type ExecutionEventClaim = typeof executionEventConsumers.$inferSelect;
type ConsumerRow = ExecutionEventClaim;

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
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), 300_000);
}

function canClaim(now: Date) {
  return or(
    isNull(executionEventConsumers.claimExpiresAt),
    lt(executionEventConsumers.claimExpiresAt, now),
  );
}

function deferredSummary(
  consumer: ConsumerRow,
): ExecutionEventProjectorSummary {
  return {
    projected: 0,
    deferred: consumer.state !== "poisoned",
    poisoned: consumer.state === "poisoned",
    lastRunSequence: consumer.lastRunSequence?.toString() ?? null,
  };
}

type ClaimResult =
  | { kind: "claimed"; consumer: ConsumerRow }
  | { kind: "unavailable"; summary: ExecutionEventProjectorSummary };

async function projectionClock(tx: Db, observedAt?: Date): Promise<Date> {
  if (observedAt) return observedAt;
  const result = await tx.execute<{ milliseconds: number }>(
    sql`SELECT (extract(epoch FROM clock_timestamp()) * 1000)::double precision AS milliseconds`,
  );

  return new Date(result.rows[0].milliseconds);
}

async function claimConsumer(input: {
  db: Db;
  consumerName: string;
  runId: string;
  owner: string;
  now?: Date;
}): Promise<ClaimResult> {
  return projectionTransaction(input.db, async (tx) => {
    const now = await projectionClock(tx, input.now);

    await ensureConsumer(tx, input.consumerName, input.runId);
    const [consumer] = await tx
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

    if (!consumer)
      throw new MaisterError(
        "ACP_PROTOCOL",
        "execution event consumer row disappeared",
      );
    if (
      consumer.state === "poisoned" ||
      (consumer.nextRetryAt && consumer.nextRetryAt > now)
    ) {
      return { kind: "unavailable", summary: deferredSummary(consumer) };
    }
    const [claimed] = await tx
      .update(executionEventConsumers)
      .set({
        claimOwner: input.owner,
        claimExpiresAt: new Date(now.getTime() + CLAIM_LEASE_MS),
      })
      .where(
        and(
          eq(executionEventConsumers.consumerName, input.consumerName),
          eq(executionEventConsumers.runId, input.runId),
          canClaim(now),
        ),
      )
      .returning();

    return claimed
      ? { kind: "claimed", consumer: claimed }
      : { kind: "unavailable", summary: deferredSummary(consumer) };
  });
}

async function ensureConsumer(
  tx: Db,
  consumerName: string,
  runId: string,
): Promise<void> {
  await tx
    .insert(executionEventConsumers)
    .values({ consumerName, runId })
    .onConflictDoNothing();
}

/** Claims one due pair at processing time; callers never queue leased work. */
export async function claimNextExecutionProjection(input: {
  db: Db;
  consumerNames: readonly string[];
  owner: string;
}): Promise<ExecutionEventClaim | null> {
  if (input.consumerNames.length === 0) return null;

  return projectionTransaction(input.db, async (tx) => {
    const [candidate] = await tx
      .select()
      .from(executionEventConsumers)
      .where(
        and(
          inArray(executionEventConsumers.consumerName, [
            ...input.consumerNames,
          ]),
          sql`${executionEventConsumers.state} <> 'poisoned'`,
          sql`(${executionEventConsumers.nextRetryAt} IS NULL OR ${executionEventConsumers.nextRetryAt} <= clock_timestamp())`,
          sql`(${executionEventConsumers.claimExpiresAt} IS NULL OR ${executionEventConsumers.claimExpiresAt} <= clock_timestamp())`,
          sql`EXISTS (SELECT 1 FROM ${executionEvents} WHERE ${executionEvents.runId} = ${executionEventConsumers.runId} AND ${executionEvents.ingestDisposition} = 'accepted' AND ${executionEvents.runSequence} > COALESCE(${executionEventConsumers.lastRunSequence}, -1))`,
        ),
      )
      .orderBy(
        sql`${executionEventConsumers.lastServedAt} ASC NULLS FIRST`,
        sql`COALESCE(${executionEventConsumers.nextRetryAt}, ${executionEventConsumers.createdAt})`,
        executionEventConsumers.runId,
        executionEventConsumers.consumerName,
      )
      .for("update", { skipLocked: true })
      .limit(1);

    if (!candidate) return null;
    const [claimed] = await tx
      .update(executionEventConsumers)
      .set({
        claimOwner: `${input.owner}:${randomUUID()}`,
        claimExpiresAt: sql`clock_timestamp() + interval '30 seconds'`,
        lastServedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(executionEventConsumers.consumerName, candidate.consumerName),
          eq(executionEventConsumers.runId, candidate.runId),
        ),
      )
      .returning();

    return claimed;
  });
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
  // A worker label is reusable; a claim token never is.
  const owner = `${input.owner ?? "execution-event-projector"}:${randomUUID()}`;
  // Initialization and claim survive a rollback of the first domain apply.
  const claim = await claimConsumer({
    db: input.db,
    consumerName: input.projector.consumerName,
    runId: input.runId,
    owner,
    now: input.now,
  });

  if (claim.kind === "unavailable") return claim.summary;

  return applyClaimedExecutionProjection({ ...input, claim: claim.consumer });
}

export async function applyClaimedExecutionProjection(input: {
  db: Db;
  runId: string;
  projector: ExecutionEventProjector;
  claim: ExecutionEventClaim;
  now?: Date;
  batchSize?: number;
}): Promise<ExecutionEventProjectorSummary> {
  const owner = input.claim.claimOwner;
  const claim = input.claim;
  const batchSize = Math.min(Math.max(input.batchSize ?? 100, 1), 100);
  let failedEventId: string | null = null;
  let failedSequence: bigint | null = null;
  let failure: unknown = null;

  if (
    !owner ||
    claim.runId !== input.runId ||
    claim.consumerName !== input.projector.consumerName
  ) {
    throw new MaisterError(
      "ACP_PROTOCOL",
      "projection claim does not match its handler and run",
    );
  }

  const transactionResult = await projectionTransaction(
    input.db,
    async (tx) => {
      const now = await projectionClock(tx, input.now);
      const consumers = await tx
        .select()
        .from(executionEventConsumers)
        .where(
          and(
            eq(
              executionEventConsumers.consumerName,
              input.projector.consumerName,
            ),
            eq(executionEventConsumers.runId, input.runId),
          ),
        )
        .for("update")
        .limit(1);
      const consumer = consumers[0];

      if (!consumer)
        throw new MaisterError(
          "ACP_PROTOCOL",
          "execution event consumer row disappeared",
        );
      if (
        consumer.claimOwner !== owner ||
        consumer.lastRunSequence !== claim.lastRunSequence ||
        consumer.claimExpiresAt === null ||
        consumer.claimExpiresAt <= now
      ) {
        return {
          summary: deferredSummary(consumer),
          projectedEvents: [] as ExecutionEvent[],
        };
      }

      // Read sizes before payloads so a batch of maximum-sized legal events
      // does not allocate 100 MiB before applying the one-MiB quantum bound.
      const candidates = await tx
        .select({
          id: executionEvents.id,
          bytes: sql<number>`COALESCE(${executionEvents.payloadBytes}, octet_length(${executionEvents.payload}::text), 0)`,
        })
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
      let payloadBytes = 0;
      const ids: string[] = [];

      for (const candidate of candidates) {
        if (ids.length > 0 && payloadBytes + candidate.bytes > 1_048_576) break;
        ids.push(candidate.id);
        payloadBytes += candidate.bytes;
      }
      const events =
        ids.length === 0
          ? []
          : await tx
              .select()
              .from(executionEvents)
              .where(inArray(executionEvents.id, ids))
              .orderBy(executionEvents.runSequence);
      let last = consumer.lastRunSequence;
      let projected = 0;
      const projectedEvents: ExecutionEvent[] = [];
      const softDeadline = performance.now() + 1_000;

      for (const event of events) {
        if (projected > 0 && performance.now() >= softDeadline) break;
        if (event.runSequence === null) {
          throw new MaisterError(
            "ACP_PROTOCOL",
            "accepted execution event has no run sequence",
          );
        }
        failedEventId = event.id;
        failedSequence = event.runSequence;
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
          lastServedAt: sql`clock_timestamp()`,
          updatedAt: now,
        })
        .where(
          and(
            eq(
              executionEventConsumers.consumerName,
              input.projector.consumerName,
            ),
            eq(executionEventConsumers.runId, input.runId),
            eq(executionEventConsumers.claimOwner, owner),
            sql`${executionEventConsumers.lastRunSequence} is not distinct from ${claim.lastRunSequence}`,
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
    },
  ).catch(async (error: unknown) => {
    if (error instanceof MaisterError && error.code === "EXECUTOR_UNAVAILABLE")
      throw error;
    if (!failedEventId || failedSequence === null) throw error;
    const summary = await recordProjectionFailure({
      db: input.db,
      runId: input.runId,
      consumerName: input.projector.consumerName,
      eventId: failedEventId,
      eventSequence: failedSequence,
      startingCursor: claim.lastRunSequence,
      owner,
      error: failure ?? error,
      now: input.now,
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
  eventSequence: bigint;
  startingCursor: bigint | null;
  owner: string;
  error: unknown;
  now?: Date;
}): Promise<ExecutionEventProjectorSummary> {
  return projectionTransaction(input.db, async (tx) => {
    const now = await projectionClock(tx, input.now);
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

    if (!consumer)
      throw new MaisterError(
        "ACP_PROTOCOL",
        "execution event consumer row disappeared after projection failure",
      );
    if (
      consumer.claimOwner !== input.owner ||
      consumer.lastRunSequence !== input.startingCursor ||
      input.eventSequence <= (consumer.lastRunSequence ?? -1n)
    ) {
      logger.debug(
        {
          consumerName: input.consumerName,
          runId: input.runId,
          eventId: input.eventId,
        },
        "stale-projection-failure-ignored",
      );

      return deferredSummary(consumer);
    }
    const attempts = consumer.attempts + 1;
    const permanent =
      input.error instanceof ExecutionEventProjectionError &&
      input.error.permanent;
    const poisoned = permanent || attempts >= MAX_TRANSIENT_ATTEMPTS;
    const lastError = {
      errorGeneration: randomUUID(),
      eventId: input.eventId,
      reason: permanent
        ? "deterministic_projection_failure"
        : "projection_failure",
      type:
        input.error instanceof ExecutionEventProjectionError
          ? input.error.name
          : "unexpected_error",
      message:
        input.error instanceof ExecutionEventProjectionError &&
        /^[a-zA-Z0-9 .:_()[\]-]{1,512}$/.test(input.error.message)
          ? input.error.message.slice(0, 512)
          : "projection failed; inspect the identified event and error fingerprint",
      fingerprint: createHash("sha256")
        .update(
          input.error instanceof Error
            ? `${input.error.name}:${input.error.message}`
            : "unknown",
        )
        .digest("hex"),
    };

    await tx
      .update(executionEventConsumers)
      .set({
        state: poisoned ? "poisoned" : "retrying",
        attempts,
        nextRetryAt: poisoned
          ? null
          : new Date(now.getTime() + retryDelayMs(attempts)),
        poisonEventId: poisoned ? input.eventId : null,
        lastError,
        claimOwner: null,
        claimExpiresAt: null,
        lastServedAt: sql`clock_timestamp()`,
        updatedAt: now,
      })
      .where(
        and(
          eq(executionEventConsumers.consumerName, input.consumerName),
          eq(executionEventConsumers.runId, input.runId),
          eq(executionEventConsumers.claimOwner, input.owner),
          sql`${executionEventConsumers.lastRunSequence} is not distinct from ${input.startingCursor}`,
        ),
      );

    logger.warn(
      {
        consumerName: input.consumerName,
        runId: input.runId,
        eventId: input.eventId,
        attempts,
        poisoned,
        reason: lastError.reason,
        fingerprint: lastError.fingerprint,
      },
      "execution-event-projection-failed",
    );

    return {
      projected: 0,
      deferred: !poisoned,
      poisoned,
      lastRunSequence: consumer.lastRunSequence?.toString() ?? null,
    };
  });
}

/** Rearms repaired evidence only when the operator's observed failure is
 * still current. A delayed repair must not clear a newer error or claim. */
export async function rearmExecutionProjection(input: {
  db: Db;
  consumerName: string;
  runId: string;
  eventId: string;
  expectedCursor: bigint | null;
  errorGeneration: string;
}): Promise<void> {
  if (
    !input.consumerName ||
    !input.runId ||
    !input.eventId ||
    !/^[a-f0-9-]{36}$/i.test(input.errorGeneration)
  ) {
    throw new MaisterError(
      "PRECONDITION",
      "projection rearm requires consumer, run, event, cursor and error generation",
    );
  }
  await projectionTransaction(input.db, async (tx) => {
    const rows = await tx
      .update(executionEventConsumers)
      .set({
        state: "ready",
        attempts: 0,
        nextRetryAt: null,
        poisonEventId: null,
        lastError: null,
        claimOwner: null,
        claimExpiresAt: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(executionEventConsumers.consumerName, input.consumerName),
          eq(executionEventConsumers.runId, input.runId),
          sql`${executionEventConsumers.state} IN ('poisoned', 'retrying')`,
          sql`${executionEventConsumers.lastRunSequence} IS NOT DISTINCT FROM ${input.expectedCursor}`,
          sql`${executionEventConsumers.lastError}->>'eventId' = ${input.eventId}`,
          sql`${executionEventConsumers.lastError}->>'errorGeneration' = ${input.errorGeneration}`,
          sql`(${executionEventConsumers.claimExpiresAt} IS NULL OR ${executionEventConsumers.claimExpiresAt} <= clock_timestamp())`,
        ),
      )
      .returning({ runId: executionEventConsumers.runId });

    if (rows.length !== 1)
      throw new MaisterError(
        "CONFLICT",
        "projection repair does not match the current unclaimed failure",
        {
          details: {
            reason: "projection_rearm_conflict",
            runId: input.runId,
            consumerName: input.consumerName,
          },
        },
      );
  });
  logger.info(
    {
      consumerName: input.consumerName,
      runId: input.runId,
      eventId: input.eventId,
      errorGeneration: input.errorGeneration,
      cursor: input.expectedCursor?.toString() ?? null,
    },
    "execution-projection-rearmed",
  );
  runEventWakeBus.wake(input.runId);
}
