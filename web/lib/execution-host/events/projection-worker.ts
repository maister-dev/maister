import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionEventProjector } from "./projector";

import { randomUUID } from "node:crypto";

import { and, eq, gt, inArray, sql } from "drizzle-orm";
import pino from "pino";

import {
  applyClaimedExecutionProjection,
  claimNextExecutionProjection,
  releaseExecutionProjectionClaim,
} from "./projector";
import { projectionLimitsFromEnv } from "./projection-limits";
import { runEventWakeBus } from "./run-wake";
import { projectionTransaction } from "./projection-transaction";

import {
  executionEventConsumers,
  executionEvents,
  executionProjectionBackfills,
  runs,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const logger = pino({
  name: "execution-projection-worker",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Seeds a page and its scan cursor together. Deleting a run cannot reset the
 * keyset; concurrently inserted events seed their own consumers at ingest. */
export async function backfillProjectionConsumers(
  db: Db,
  consumerName: string,
): Promise<{ complete: boolean; seeded: number }> {
  return projectionTransaction(db, async (tx) => {
    await tx
      .insert(executionProjectionBackfills)
      .values({ consumerName })
      .onConflictDoNothing();
    const [cursor] = await tx
      .select()
      .from(executionProjectionBackfills)
      .where(eq(executionProjectionBackfills.consumerName, consumerName))
      .for("update", { skipLocked: true })
      .limit(1);

    if (!cursor) return { complete: false, seeded: 0 };
    if (cursor.completedAt) return { complete: true, seeded: 0 };
    const page = await tx
      .select({ runId: runs.id })
      .from(runs)
      .where(
        and(
          cursor.afterRunId === null
            ? undefined
            : gt(runs.id, cursor.afterRunId),
          sql`EXISTS (SELECT 1 FROM ${executionEvents} WHERE ${executionEvents.runId} = ${runs.id} AND ${executionEvents.ingestDisposition} = 'accepted')`,
        ),
      )
      .orderBy(runs.id)
      .limit(100);

    if (page.length > 0) {
      await tx
        .insert(executionEventConsumers)
        .values(page.map(({ runId }) => ({ consumerName, runId })))
        .onConflictDoNothing();
    }
    const complete = page.length < 100;

    await tx
      .update(executionProjectionBackfills)
      .set({
        afterRunId: page.at(-1)?.runId ?? cursor.afterRunId,
        completedAt: complete ? sql`clock_timestamp()` : null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(executionProjectionBackfills.consumerName, consumerName));

    return { complete, seeded: page.length };
  });
}

export type ProjectionWorker = {
  stop: () => Promise<void>;
  health: () => Promise<{
    state: "running" | "degraded" | "stopped";
    reason: string | null;
  }>;
};

/** Two slots claim only when free. PostgreSQL owns backlog, leases and retry
 * deadlines; wake hints merely shorten the bounded idle wait. */
export function startProjectionWorker(input: {
  db: Db;
  projectors: readonly ExecutionEventProjector[];
}): ProjectionWorker {
  const limits = projectionLimitsFromEnv();
  const registry = new Map(
    input.projectors.map((projector) => [projector.consumerName, projector]),
  );

  if (registry.size === 0 || registry.size !== input.projectors.length) {
    throw new MaisterError(
      "ACP_PROTOCOL",
      "projection registry must contain unique named consumers",
    );
  }
  const controller = new AbortController();
  const workerId = `projection-worker:${randomUUID()}`;
  const consumerNames = [...registry.keys()];
  const failures = new Map<string, string>();
  let stopped = false;

  const serviceFailure = (slot: string, error: unknown): void => {
    const reason =
      error instanceof MaisterError ? error.code : "database_failure";

    failures.set(slot, reason);
    logger.error({ workerId, slot, reason }, "projection-service-degraded");
  };
  const wait = (): Promise<void> =>
    runEventWakeBus.waitForProjection(1_000, controller.signal);
  const backfill = async (): Promise<void> => {
    for (const consumerName of consumerNames) {
      while (!controller.signal.aborted) {
        try {
          const page = await backfillProjectionConsumers(
            input.db,
            consumerName,
          );

          failures.delete("backfill");
          logger.debug(
            { workerId, consumerName, ...page },
            "projection-backfill-page",
          );
          if (page.seeded > 0) runEventWakeBus.wakeProjection();
          if (page.complete) break;
          if (page.seeded === 0) await wait();
        } catch (error) {
          serviceFailure("backfill", error);
          await wait();
        }
      }
    }
  };
  const serve = async (slot: string): Promise<void> => {
    while (!controller.signal.aborted) {
      try {
        const claim = await claimNextExecutionProjection({
          db: input.db,
          consumerNames,
          owner: `${workerId}:${slot}`,
          limits,
        });

        if (!claim) {
          failures.delete(slot);
          await wait();
          continue;
        }
        // Shutdown may race the short claim transaction. Release only this
        // token; never clear another process's replacement lease.
        if (controller.signal.aborted) {
          await releaseExecutionProjectionClaim(input.db, claim);
          break;
        }
        const projector = registry.get(claim.consumerName);

        if (!projector)
          throw new MaisterError(
            "ACP_PROTOCOL",
            "claimed projection has no registered handler",
          );
        const result = await applyClaimedExecutionProjection({
          db: input.db,
          runId: claim.runId,
          projector,
          claim,
          limits,
          signal: controller.signal,
        });

        failures.delete(slot);
        logger.debug(
          {
            workerId,
            slot,
            consumerName: claim.consumerName,
            runId: claim.runId,
            ...result,
          },
          "projection-quantum-finished",
        );
      } catch (error) {
        serviceFailure(slot, error);
        await wait();
      }
    }
  };

  logger.info(
    { workerId, consumers: consumerNames, ...limits },
    "projection-worker-started",
  );
  const finished = Promise.all([
    backfill(),
    ...Array.from({ length: limits.concurrency }, (_, index) =>
      serve(String(index)),
    ),
  ]);

  return {
    health: async () => {
      if (stopped) return { state: "stopped", reason: null };
      try {
        const poisoned = await projectionTransaction(input.db, (tx) =>
          tx
            .select({ runId: executionEventConsumers.runId })
            .from(executionEventConsumers)
            .where(
              and(
                inArray(executionEventConsumers.consumerName, consumerNames),
                eq(executionEventConsumers.state, "poisoned"),
              ),
            )
            .limit(1),
        );

        failures.delete("health");
        if (poisoned.length > 0)
          return { state: "degraded", reason: "projection_poisoned" };
      } catch (error) {
        serviceFailure("health", error);
      }

      return {
        state: failures.size > 0 ? "degraded" : "running",
        reason: failures.values().next().value ?? null,
      };
    },
    stop: async () => {
      controller.abort();
      await finished;
      stopped = true;
      logger.info({ workerId }, "projection-worker-stopped");
      await new Promise<void>((resolve, reject) => {
        logger.flush((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
