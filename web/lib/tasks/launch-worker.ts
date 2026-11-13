import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { DurableWorkerHandle } from "@/lib/workers/health";

import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import { sql } from "drizzle-orm";
import pino from "pino";

import { runWorkerLoop } from "@/lib/workers/loop";
import { taskLaunchIntents, runs } from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { runEventWakeBus } from "@/lib/execution-host/events/run-wake";
import { projectionTransaction } from "@/lib/execution-host/events/projection-transaction";
import { operationalCauseChain } from "@/lib/agents/operational-diagnostics";
import { promoteNextPending } from "@/lib/scheduler";

const log = pino({
  name: "task-launch-worker",
  level: process.env.LOG_LEVEL ?? "info",
});
const TASK_LAUNCH_POOLS = ["flow", "agent"] as const;
const MAX_DRAIN_PASS = 25;
const MAX_RECONCILE_WAIT_MS = 1_000;

type LaunchPool = (typeof TASK_LAUNCH_POOLS)[number];

type PoolWork = Readonly<{ due: boolean; waitMs: number }>;

/** Deadlines are scheduling hints; only the shared scheduler authorizes a claim. */
async function readPoolWork(db: Db, pool: LaunchPool): Promise<PoolWork> {
  const pending = sql`${taskLaunchIntents.dispatchCommittedAt} IS NULL
    AND ${taskLaunchIntents.settingsSnapshot}->>'kind'=${pool}
    AND NOT (${taskLaunchIntents.settingsSnapshot}->>'kind'='agent'
      AND ${taskLaunchIntents.state}='run_bound' AND EXISTS (
        SELECT 1 FROM ${runs} WHERE ${runs.id}=${taskLaunchIntents.runId}
          AND ${runs.status}='Running'))`;
  const result = await projectionTransaction(db, (tx) =>
    tx.execute<{ due: boolean; waitMs: number }>(sql`
      WITH due AS (
        SELECT 1 FROM ${taskLaunchIntents} WHERE ${pending} AND (
          ${taskLaunchIntents.state} IN ('queued','run_bound')
            AND ${taskLaunchIntents.dueAt}<=clock_timestamp()
          OR ${taskLaunchIntents.state}='preparing'
            AND ${taskLaunchIntents.leaseExpiresAt}<=clock_timestamp()
        ) LIMIT 1
      ), future AS (
        (SELECT ${taskLaunchIntents.dueAt} AS deadline
          FROM ${taskLaunchIntents} WHERE ${pending}
          AND ${taskLaunchIntents.state}='queued'
          AND ${taskLaunchIntents.dueAt}>clock_timestamp()
          ORDER BY ${taskLaunchIntents.dueAt},${taskLaunchIntents.id} LIMIT 1)
        UNION ALL
        (SELECT ${taskLaunchIntents.dueAt} AS deadline
          FROM ${taskLaunchIntents} WHERE ${pending}
          AND ${taskLaunchIntents.state}='run_bound'
          AND ${taskLaunchIntents.dueAt}>clock_timestamp()
          ORDER BY ${taskLaunchIntents.dueAt},${taskLaunchIntents.id} LIMIT 1)
        UNION ALL
        (SELECT ${taskLaunchIntents.leaseExpiresAt} AS deadline
          FROM ${taskLaunchIntents} WHERE ${pending}
          AND ${taskLaunchIntents.state}='preparing'
          AND ${taskLaunchIntents.leaseExpiresAt}>clock_timestamp()
          ORDER BY ${taskLaunchIntents.leaseExpiresAt},${taskLaunchIntents.id} LIMIT 1)
      )
      SELECT exists(SELECT 1 FROM due) AS due,
        coalesce(least(${MAX_RECONCILE_WAIT_MS},greatest(1,
          ceil(extract(epoch FROM (min(deadline)-clock_timestamp()))*1000)
        )),${MAX_RECONCILE_WAIT_MS})::int AS "waitMs"
      FROM future
    `),
  );

  return result.rows[0];
}

/** Unrelated projection hints must not hot-loop a pool with unchanged ineligible work. */
async function waitAfterNoProgress(
  waitMs: number,
  signal: AbortSignal,
): Promise<void> {
  const deadline = performance.now() + waitMs;

  while (!signal.aborted) {
    const remaining = Math.ceil(deadline - performance.now());

    if (remaining <= 0) return;
    await runEventWakeBus.waitForProjection(remaining, signal);
  }
}

/** Durable intent deadlines survive lost HTTP wakes and process restarts; existing claims own every effect. */
export function startTaskLaunchWorker(input: { db: Db }): DurableWorkerHandle {
  const controller = new AbortController();
  const workerId = `task-launch-worker:${randomUUID()}`;
  const failures = new Map<LaunchPool, string>();
  let stopped = false;
  let shutdown: Promise<void> | undefined;
  let shutdownFailure: Readonly<{ error: unknown }> | undefined;
  const serve = async (pool: LaunchPool): Promise<void> => {
    let idleDeadline: number | null = null;

    await runWorkerLoop(controller.signal, async () => {
      try {
        let work = await readPoolWork(input.db, pool);

        if (work.due) idleDeadline = null;
        let noProgress = false;
        let serviced = 0;

        while (work.due && serviced < MAX_DRAIN_PASS) {
          if (controller.signal.aborted) return;
          const outcome = await promoteNextPending({ db: input.db, pool });
          const progress =
            outcome.taskLaunchProgress ?? outcome.promotedRunId !== null;

          serviced += 1;
          failures.delete(pool);
          const diagnostic = {
            workerId,
            pool,
            runId: outcome.promotedRunId,
            durableProgress: progress,
          };

          if (progress && outcome.promotedRunId)
            log.info(diagnostic, "[FIX:R18] accepted launch pool serviced");
          else log.debug(diagnostic, "[FIX:R18] accepted launch pool serviced");
          if (!progress) {
            noProgress = true;
            break;
          }
          work = await readPoolWork(input.db, pool);
        }
        failures.delete(pool);
        if (controller.signal.aborted) return;
        if (noProgress)
          await waitAfterNoProgress(work.waitMs, controller.signal);
        else if (!work.due) {
          const now = performance.now();

          if (idleDeadline !== null && now < idleDeadline) {
            await waitAfterNoProgress(
              Math.ceil(idleDeadline - now),
              controller.signal,
            );
            idleDeadline = null;
          } else {
            idleDeadline = now + work.waitMs;
            await runEventWakeBus.waitForProjection(
              work.waitMs,
              controller.signal,
            );
          }
        }
      } catch (error) {
        const reason = isMaisterError(error) ? error.code : "service_failure";

        failures.set(pool, reason);
        if (controller.signal.aborted) shutdownFailure ??= { error };
        log.error(
          { workerId, pool, reason, causeChain: operationalCauseChain(error) },
          "[FIX:R18] task launch worker degraded",
        );
        await waitAfterNoProgress(MAX_RECONCILE_WAIT_MS, controller.signal);
      }
    });
  };
  const slots = TASK_LAUNCH_POOLS.map(serve);

  log.info(
    { workerId, pools: TASK_LAUNCH_POOLS },
    "task-launch-worker-started",
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
        log.info({ workerId }, "task-launch-worker-stopped");
      })();

      return shutdown;
    },
  };
}
