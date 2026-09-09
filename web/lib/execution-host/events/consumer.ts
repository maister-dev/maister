import "server-only";

import type { ExecutionHostTransport } from "@/lib/execution-host/contracts";
import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { and, eq, isNull, lt, or } from "drizzle-orm";
import pino, { type Logger } from "pino";

import { ingestRuntimeEvent } from "./ingest";
import { runEventWakeBus } from "./run-wake";

import { MaisterError } from "@/lib/errors";
import { executionEventStreams } from "@/lib/db/schema";
import { isApplicationStopping } from "@/lib/server-lifecycle";

const CLAIM_LEASE_MS = 30_000;
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 15_000;

/** A claim is a lease, so a consumer whose owner died cannot be distinguished
 * from one that is merely slow: another consumer only takes over after this
 * window. Callers that deliberately kill a claim holder must budget for it. */
export const RUNTIME_EVENT_CLAIM_LEASE_MS = CLAIM_LEASE_MS;
export const RUNTIME_EVENT_RECONNECT_MIN_MS = RECONNECT_MIN_MS;
export const RUNTIME_EVENT_RECONNECT_MAX_MS = RECONNECT_MAX_MS;

/** A contested claim resolves at a KNOWN bound — the holder's lease — so it
 * backs off only far enough to stop hot-spinning the shared database, never
 * far enough to delay takeover once that lease expires. A transport failure
 * has no such bound and keeps the longer cap. */
const CONTESTED_CLAIM_MAX_MS = 2_000;

export function nextReconnectDelayMs(
  previous: number,
  outcome: "progress" | "reconnect" | "error",
): number {
  if (outcome === "progress") return RECONNECT_MIN_MS;

  return Math.min(
    previous * 2,
    outcome === "reconnect" ? CONTESTED_CLAIM_MAX_MS : RECONNECT_MAX_MS,
  );
}

export const RUNTIME_EVENT_CONTESTED_CLAIM_MAX_MS = CONTESTED_CLAIM_MAX_MS;

const defaultLog = pino({
  name: "execution-host-events",
  level: process.env.LOG_LEVEL ?? "info",
}).child({ component: "consumer" });

export type RuntimeEventStreamClaim = {
  streamRowId: string;
  streamId: string;
  afterSequence: string | undefined;
  acknowledgedThrough: string | undefined;
};

export type RuntimeEventConsumerSummary = {
  received: number;
  acknowledged: number;
  duplicates: number;
  staleEpochs: number;
  reconnectRequired: boolean;
};

function activeClaimPredicate(now: Date, owner: string) {
  return or(
    isNull(executionEventStreams.claimExpiresAt),
    lt(executionEventStreams.claimExpiresAt, now),
    eq(executionEventStreams.claimOwner, owner),
  );
}

// Claims serialize host ACK ownership. Delivery is still at-least-once (a
// claim can expire while a web process is paused), so ingest remains the sole
// exactly-once boundary.
export async function claimRuntimeEventStream(input: {
  db: Db;
  executionHostId: string;
  owner: string;
  now?: Date;
  leaseMs?: number;
}): Promise<RuntimeEventStreamClaim | null> {
  const now = input.now ?? new Date();
  const leaseMs = input.leaseMs ?? CLAIM_LEASE_MS;
  const expiresAt = new Date(now.getTime() + leaseMs);

  return input.db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: executionEventStreams.id,
        streamId: executionEventStreams.streamId,
        lastContiguousSequence: executionEventStreams.lastContiguousSequence,
        lastAckConfirmedSequence:
          executionEventStreams.lastAckConfirmedSequence,
      })
      .from(executionEventStreams)
      .where(
        and(
          eq(executionEventStreams.executionHostId, input.executionHostId),
          eq(executionEventStreams.state, "active"),
        ),
      )
      .for("update")
      .limit(1);
    const stream = rows[0];

    if (!stream) return null;
    const updated = await tx
      .update(executionEventStreams)
      .set({ claimOwner: input.owner, claimExpiresAt: expiresAt })
      .where(
        and(
          eq(executionEventStreams.id, stream.id),
          activeClaimPredicate(now, input.owner),
        ),
      )
      .returning({ id: executionEventStreams.id });

    if (!updated[0]) return null;

    return {
      streamRowId: stream.id,
      streamId: stream.streamId,
      afterSequence: stream.lastContiguousSequence?.toString(),
      acknowledgedThrough: stream.lastAckConfirmedSequence?.toString(),
    };
  });
}

export async function recordConfirmedRuntimeEventAck(input: {
  db: Db;
  claim: RuntimeEventStreamClaim;
  owner: string;
  throughSequence: string;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  const through = BigInt(input.throughSequence);

  return input.db.transaction(async (tx) => {
    const rows = await tx
      .select({
        claimOwner: executionEventStreams.claimOwner,
        lastContiguousSequence: executionEventStreams.lastContiguousSequence,
        lastAckConfirmedSequence:
          executionEventStreams.lastAckConfirmedSequence,
      })
      .from(executionEventStreams)
      .where(eq(executionEventStreams.id, input.claim.streamRowId))
      .for("update")
      .limit(1);
    const stream = rows[0];

    if (
      !stream ||
      stream.claimOwner !== input.owner ||
      stream.lastContiguousSequence === null ||
      through > stream.lastContiguousSequence
    ) {
      return false;
    }
    const current = stream.lastAckConfirmedSequence ?? -1n;

    if (through <= current) return true;
    await tx
      .update(executionEventStreams)
      .set({
        lastAckConfirmedSequence: through,
        lastSeenAt: now,
        nextRetryAt: null,
        lastError: null,
      })
      .where(eq(executionEventStreams.id, input.claim.streamRowId));

    return true;
  });
}

async function recordConsumerFailure(input: {
  db: Db;
  executionHostId: string;
  streamRowId?: string;
  owner: string;
  error: unknown;
  now: Date;
  retryAt: Date;
}): Promise<void> {
  const reason =
    input.error instanceof MaisterError
      ? input.error.code
      : input.error instanceof Error
        ? input.error.name
        : "unknown";
  const details = {
    reason,
    message:
      input.error instanceof Error
        ? input.error.message.slice(0, 512)
        : "unknown event consumer failure",
  };
  const where = input.streamRowId
    ? eq(executionEventStreams.id, input.streamRowId)
    : and(
        eq(executionEventStreams.executionHostId, input.executionHostId),
        eq(executionEventStreams.claimOwner, input.owner),
      );

  await input.db
    .update(executionEventStreams)
    .set({
      nextRetryAt: input.retryAt,
      lastError: details,
      claimExpiresAt: input.now,
    })
    .where(where);
}

export async function consumeRuntimeEventStreamOnce(input: {
  db: Db;
  executionHostId: string;
  transport: ExecutionHostTransport;
  owner: string;
  maxEvents?: number;
  signal?: AbortSignal;
  now?: () => Date;
  logger?: Logger;
}): Promise<RuntimeEventConsumerSummary> {
  const now = input.now ?? (() => new Date());
  const logger = input.logger ?? defaultLog;
  const summary: RuntimeEventConsumerSummary = {
    received: 0,
    acknowledged: 0,
    duplicates: 0,
    staleEpochs: 0,
    reconnectRequired: false,
  };
  let claim = await claimRuntimeEventStream({
    db: input.db,
    executionHostId: input.executionHostId,
    owner: input.owner,
    now: now(),
  });
  const controller = new AbortController();
  const stop = (): void => controller.abort();

  input.signal?.addEventListener("abort", stop, { once: true });
  const maxEvents = input.maxEvents ?? Number.POSITIVE_INFINITY;

  try {
    // An abort received while the claim transaction waited is not replayed
    // when its listener is attached. Refuse before opening another stream.
    if (input.signal?.aborted) {
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        "runtime event consumer was cancelled",
        { details: { reason: "aborted" } },
      );
    }
    if (
      claim?.afterSequence !== undefined &&
      claim.acknowledgedThrough !== claim.afterSequence
    ) {
      const ack = await input.transport.acknowledgeRuntimeEvents({
        streamId: claim.streamId,
        throughSequence: claim.afterSequence,
      });

      if (
        ack.streamId !== claim.streamId ||
        ack.acknowledgedThrough !== claim.afterSequence
      ) {
        throw new MaisterError(
          "ACP_PROTOCOL",
          "execution host returned a mismatched runtime event acknowledgement",
        );
      }
      const recorded = await recordConfirmedRuntimeEventAck({
        db: input.db,
        claim,
        owner: input.owner,
        throughSequence: ack.acknowledgedThrough,
        now: now(),
      });

      if (!recorded) {
        summary.reconnectRequired = true;

        return summary;
      }
      summary.acknowledged += 1;
    }
    for await (const envelope of input.transport.streamRuntimeEvents({
      afterSequence: claim?.afterSequence,
      signal: controller.signal,
    })) {
      if (input.signal?.aborted) break;
      const result = await ingestRuntimeEvent({
        db: input.db,
        executionHostId: input.executionHostId,
        envelope,
        now: now(),
        logger,
      });

      summary.received += 1;
      summary.duplicates += result.disposition === "duplicate" ? 1 : 0;
      summary.staleEpochs += result.staleEpochCount;

      // A bootstrap connection has no stream row to claim until its first
      // durable insert. Claim before ACK so only one manager owns the durable
      // acknowledgement watermark thereafter.
      claim ??= await claimRuntimeEventStream({
        db: input.db,
        executionHostId: input.executionHostId,
        owner: input.owner,
        now: now(),
      });
      if (!claim || claim.streamId !== result.streamId) {
        summary.reconnectRequired = true;
        break;
      }
      if (result.contiguousThrough !== null) {
        const ack = await input.transport.acknowledgeRuntimeEvents({
          streamId: claim.streamId,
          throughSequence: result.contiguousThrough,
        });

        if (
          ack.streamId !== claim.streamId ||
          ack.acknowledgedThrough !== result.contiguousThrough
        ) {
          throw new MaisterError(
            "ACP_PROTOCOL",
            "execution host returned a mismatched runtime event acknowledgement",
          );
        }
        const recorded = await recordConfirmedRuntimeEventAck({
          db: input.db,
          claim,
          owner: input.owner,
          throughSequence: ack.acknowledgedThrough,
          now: now(),
        });

        if (!recorded) {
          summary.reconnectRequired = true;
          break;
        }
        summary.acknowledged += 1;
      }
      // ACK is deliberately independent from every read-model reducer. The
      // durable ingest row is sufficient for replay; a projection failure is
      // retried through its own cursor and cannot trap the host outbox.
      if (result.acceptedCount > 0) runEventWakeBus.wakeProjection();
      if (summary.received >= maxEvents) break;
    }
  } catch (error) {
    const retryAt = new Date(now().getTime() + RECONNECT_MIN_MS);

    await recordConsumerFailure({
      db: input.db,
      executionHostId: input.executionHostId,
      streamRowId: claim?.streamRowId,
      owner: input.owner,
      error,
      now: now(),
      retryAt,
    });
    throw error;
  } finally {
    controller.abort();
    input.signal?.removeEventListener("abort", stop);
  }

  return summary;
}

type ConsumerLoop = { controller: AbortController; promise: Promise<void> };

declare global {
  var __maisterRuntimeEventConsumers: Map<string, ConsumerLoop> | undefined;
}

const consumers =
  globalThis.__maisterRuntimeEventConsumers ?? new Map<string, ConsumerLoop>();

globalThis.__maisterRuntimeEventConsumers = consumers;

export function startRuntimeEventConsumer(input: {
  db: Db;
  executionHostId: string;
  transport: ExecutionHostTransport;
  logger?: Logger;
}): () => void {
  if (isApplicationStopping())
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "event consumer is shutting down",
    );
  const existing = consumers.get(input.executionHostId);

  if (existing) return () => existing.controller.abort();
  const controller = new AbortController();
  const owner = `web-event-consumer:${randomUUID()}`;
  const logger = input.logger ?? defaultLog;
  const promise = (async (): Promise<void> => {
    let delayMs = RECONNECT_MIN_MS;

    while (!controller.signal.aborted) {
      try {
        const summary = await consumeRuntimeEventStreamOnce({
          ...input,
          owner,
          signal: controller.signal,
          logger,
        });

        delayMs = nextReconnectDelayMs(
          delayMs,
          summary.reconnectRequired ? "reconnect" : "progress",
        );
      } catch (error) {
        logger.warn(
          {
            hostId: input.executionHostId,
            delayMs,
            reason:
              error instanceof MaisterError ? error.code : "transport_failure",
          },
          "runtime-event-consumer-reconnect",
        );
        delayMs = nextReconnectDelayMs(delayMs, "error");
      }
      if (!controller.signal.aborted) {
        try {
          await delay(delayMs, undefined, {
            signal: controller.signal,
            ref: false,
          });
        } catch (error) {
          if (!controller.signal.aborted) throw error;
        }
      }
    }
  })().finally(() => {
    if (consumers.get(input.executionHostId)?.controller === controller) {
      consumers.delete(input.executionHostId);
    }
  });

  consumers.set(input.executionHostId, { controller, promise });

  return () => controller.abort();
}

export function resetRuntimeEventConsumersForTests(): void {
  for (const consumer of consumers.values()) consumer.controller.abort();
  consumers.clear();
}

/** Abort stream/body and retry waits, then await every owned consumer loop. */
export async function stopRuntimeEventConsumers(): Promise<void> {
  const active = [...consumers.values()];

  for (const consumer of active) consumer.controller.abort();
  await Promise.all(active.map((consumer) => consumer.promise));
}
