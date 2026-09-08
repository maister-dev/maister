import "server-only";

import type { Db } from "./db";
import type { PromptOwnerRegistry } from "./prompt-owners";

import { randomUUID } from "node:crypto";

import pino from "pino";

import {
  applyClaimedPromptOwner,
  claimPromptOwner,
  releasePromptOwnerClaim,
} from "./prompt-owner-application";
import { projectionLimitsFromEnv } from "./events/projection-limits";
import { runEventWakeBus } from "./events/run-wake";

import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "prompt-owner-recovery",
  level: process.env.LOG_LEVEL ?? "info",
});

export type PromptOwnerWorker = Readonly<{
  stop: () => Promise<void>;
  health: () => {
    state: "running" | "degraded" | "stopped";
    reason: string | null;
  };
}>;

/** Durable commands are the queue. Two free slots claim directly from its
 * indexed due predicate; no process-local result or queued claim is required
 * after restart. Domain successor recovery remains owned by each adapter.
 */
export function startPromptOwnerWorker(input: {
  db: Db;
  owners: PromptOwnerRegistry;
}): PromptOwnerWorker {
  if (input.owners.size === 0)
    throw new MaisterError(
      "CONFIG",
      "prompt owner recovery requires registered adapters",
    );
  const controller = new AbortController();
  const workerId = `prompt-owner-worker:${randomUUID()}`;
  const failures = new Map<number, string>();
  let stopped = false;
  let shutdownFailure: { error: unknown } | undefined;
  let shutdown: Promise<void> | undefined;
  const serve = async (slot: number): Promise<void> => {
    while (!controller.signal.aborted) {
      try {
        const claim = await claimPromptOwner(input);

        if (!claim) {
          failures.delete(slot);
          await runEventWakeBus.waitForProjection(1_000, controller.signal);
          continue;
        }
        if (controller.signal.aborted) {
          await releasePromptOwnerClaim(input.db, claim);
          break;
        }
        await applyClaimedPromptOwner({
          ...input,
          claim,
          signal: controller.signal,
        });
        failures.delete(slot);
      } catch (error) {
        const reason =
          error instanceof MaisterError ? error.code : "service_failure";

        failures.set(slot, reason);
        if (controller.signal.aborted) shutdownFailure ??= { error };
        log.error({ workerId, slot, reason }, "prompt-owner-worker-degraded");
        await runEventWakeBus.waitForProjection(1_000, controller.signal);
      }
    }
  };
  const slots = Array.from(
    { length: projectionLimitsFromEnv().concurrency },
    (_, slot) => serve(slot),
  );

  log.info(
    {
      workerId,
      ownerKinds: [...input.owners.keys()],
      concurrency: slots.length,
    },
    "prompt-owner-worker-started",
  );

  return {
    health: () => ({
      state: failures.size > 0 ? "degraded" : stopped ? "stopped" : "running",
      reason: failures.values().next().value ?? null,
    }),
    stop: () => {
      shutdown ??= (async () => {
        controller.abort();
        await Promise.all(slots);
        if (shutdownFailure) throw shutdownFailure.error;
        stopped = true;
        log.info({ workerId }, "prompt-owner-worker-stopped");
      })();

      return shutdown;
    },
  };
}
