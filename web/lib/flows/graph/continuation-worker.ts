import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { RunFlowOptions } from "./runner-core";

import {
  and,
  asc,
  eq,
  exists,
  gt,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import pino from "pino";

import { runFlow } from "../runner";

import {
  executionAssignments,
  executionCommands,
  nodeAttempts,
  runs,
} from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { markResumedFromWait } from "@/lib/runs/state-transitions";
import { projectionTransaction } from "@/lib/execution-host/events/projection-transaction";
import { projectionLimitsFromEnv } from "@/lib/execution-host/events/projection-limits";
import { runEventWakeBus } from "@/lib/execution-host/events/run-wake";

const log = pino({
  name: "flow-continuation-worker",
  level: process.env.LOG_LEVEL ?? "info",
});

/** The run cursor and existing attempt are the queue. A keyset scan covers
 * already-applied commands even when no new host event arrives. Each free
 * worker slot enters the same leased driver as live dispatch; it retains no
 * claimed work in an in-memory backlog. A parked parent requires a persisted
 * child wake and the normal capacity-checked resume claim.
 */
export function startFlowContinuationWorker(input: {
  db: Db;
  runtimeRoot?: string;
  executionHosts?: RunFlowOptions["executionHosts"];
}): Readonly<{
  stop: () => Promise<void>;
  health: () => {
    state: "running" | "degraded" | "stopped";
    reason: string | null;
  };
}> {
  const controller = new AbortController();
  const failures = new Map<number, string>();
  let shutdownFailure: { error: unknown } | undefined;
  let stopped = false;
  const serve = async (slot: number): Promise<void> => {
    let cursor: string | null = null;

    while (!controller.signal.aborted) {
      try {
        const [candidate] = await projectionTransaction(input.db, (tx) =>
          tx
            .select({ id: runs.id, status: runs.status })
            .from(runs)
            .innerJoin(
              executionAssignments,
              eq(executionAssignments.id, runs.executionAssignmentId),
            )
            .where(
              and(
                eq(runs.runKind, "flow"),
                or(
                  and(
                    eq(runs.status, "Running"),
                    eq(executionAssignments.state, "active"),
                  ),
                  and(
                    eq(runs.status, "WaitingOnChildren"),
                    isNotNull(runs.resumeRequestedAt),
                  ),
                ),
                cursor ? gt(runs.id, cursor) : undefined,
                or(
                  isNull(runs.flowDriverToken),
                  lte(runs.flowDriverLeaseExpiresAt, sql`clock_timestamp()`),
                ),
                or(
                  exists(
                    tx
                      .select({ id: executionCommands.id })
                      .from(executionCommands)
                      .where(
                        and(
                          eq(executionCommands.runId, runs.id),
                          or(
                            eq(runs.status, "WaitingOnChildren"),
                            eq(
                              executionCommands.executionAssignmentId,
                              executionAssignments.id,
                            ),
                          ),
                          eq(executionCommands.kind, "session.prompt"),
                          eq(executionCommands.ownerKind, "flow_node_attempt"),
                        ),
                      ),
                  ),
                  exists(
                    tx
                      .select({ id: nodeAttempts.id })
                      .from(nodeAttempts)
                      .where(
                        and(
                          eq(nodeAttempts.runId, runs.id),
                          eq(nodeAttempts.nodeId, runs.currentStepId),
                          eq(
                            nodeAttempts.executionAssignmentId,
                            executionAssignments.id,
                          ),
                          isNotNull(nodeAttempts.actionResume),
                          sql`${nodeAttempts.actionResume}->>'assignmentId' = ${executionAssignments.id}`,
                        ),
                      ),
                  ),
                ),
              ),
            )
            .orderBy(asc(runs.id))
            .limit(1),
        );

        if (!candidate) {
          failures.delete(slot);
          cursor = null;
          await runEventWakeBus.waitForProjection(1_000, controller.signal);
          continue;
        }
        cursor = candidate.id;
        if (controller.signal.aborted) return;
        if (candidate.status === "WaitingOnChildren") {
          const resumed = await markResumedFromWait(candidate.id, {
            db: input.db,
          });

          if (!resumed.ok) continue;
        }
        await runFlow(candidate.id, { ...input, signal: controller.signal });
        failures.delete(slot);
      } catch (error) {
        const reason = isMaisterError(error) ? error.code : "service_failure";

        failures.set(slot, reason);
        if (controller.signal.aborted) shutdownFailure ??= { error };
        log.error({ slot, reason }, "flow-continuation-worker-degraded");
        await runEventWakeBus.waitForProjection(1_000, controller.signal);
      }
    }
  };
  const slots = Array.from(
    { length: projectionLimitsFromEnv().concurrency },
    (_, slot) => serve(slot),
  );
  let shutdown: Promise<void> | undefined;

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
      })();

      return shutdown;
    },
  };
}
