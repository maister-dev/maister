import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { RunFlowOptions } from "./runner-core";

import { randomUUID } from "node:crypto";

import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  isNotNull,
  isNull,
  inArray,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import pino from "pino";

import { runFlow } from "../runner";

import { openFlowPromptExists } from "./prompt-permission";
import { pendingGatePermissionResumeExists } from "./gate-permission-resume";

import {
  executionAssignments,
  executionCommands,
  gateResults,
  nodeAttempts,
  runs,
} from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { reconcileGraceSeconds } from "@/lib/instance-config";
import {
  CRASH_RECOVER_CONTINUATION_MAX_ATTEMPTS,
  recordCrashRecoverContinuationOutcome,
} from "@/lib/runs/crash-recover";
import { routeCrashRecover } from "@/lib/runs/crash-recover-route";
import { driveResume } from "@/lib/runs/recover";
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
  const workerId = `flow-continuation-worker:${randomUUID()}`;
  const failures = new Map<number, string>();
  let shutdownFailure: { error: unknown } | undefined;
  let stopped = false;
  const serve = async (slot: number): Promise<void> => {
    let cursor: string | null = null;

    while (!controller.signal.aborted) {
      try {
        const [candidate] = await projectionTransaction(input.db, (tx) =>
          tx
            .select({
              id: runs.id,
              status: runs.status,
              // ADR-176: the routed branch discriminates on these without a
              // second read of the row it just selected.
              resumeStartedAt: runs.resumeStartedAt,
              currentStepId: runs.currentStepId,
            })
            .from(runs)
            .innerJoin(
              executionAssignments,
              eq(executionAssignments.id, runs.executionAssignmentId),
            )
            .where(
              and(
                eq(runs.runKind, "flow"),
                cursor ? gt(runs.id, cursor) : undefined,
                or(
                  isNull(runs.flowDriverToken),
                  lte(runs.flowDriverLeaseExpiresAt, sql`clock_timestamp()`),
                ),
                or(
                  and(
                    or(
                      and(
                        or(
                          eq(runs.status, "Running"),
                          and(
                            eq(runs.status, "NeedsInput"),
                            openFlowPromptExists(),
                          ),
                        ),
                        eq(executionAssignments.state, "active"),
                      ),
                      and(
                        eq(runs.status, "WaitingOnChildren"),
                        isNotNull(runs.resumeRequestedAt),
                      ),
                    ),
                    or(
                      pendingGatePermissionResumeExists(),
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
                              or(
                                and(
                                  eq(executionCommands.kind, "session.prompt"),
                                  eq(
                                    executionCommands.ownerKind,
                                    "flow_node_attempt",
                                  ),
                                ),
                                and(
                                  eq(executionCommands.kind, "session.create"),
                                  isNotNull(executionCommands.createIntent),
                                ),
                              ),
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
                              or(
                                and(
                                  isNotNull(nodeAttempts.actionResume),
                                  sql`${nodeAttempts.actionResume}->>'assignmentId' = ${executionAssignments.id}`,
                                ),
                                and(
                                  isNull(nodeAttempts.finishContinuation),
                                  or(
                                    and(
                                      eq(nodeAttempts.status, "Running"),
                                      isNull(nodeAttempts.endedAt),
                                      inArray(nodeAttempts.nodeType, [
                                        "ai_coding",
                                        "judge",
                                        "orchestrator",
                                      ]),
                                    ),
                                    exists(
                                      tx
                                        .select({ id: gateResults.id })
                                        .from(gateResults)
                                        .where(
                                          and(
                                            eq(
                                              gateResults.nodeAttemptId,
                                              nodeAttempts.id,
                                            ),
                                            eq(gateResults.runId, runs.id),
                                            inArray(gateResults.kind, [
                                              "ai_judgment",
                                              "skill_check",
                                            ]),
                                            eq(gateResults.status, "running"),
                                          ),
                                        ),
                                    ),
                                  ),
                                ),
                              ),
                            ),
                          ),
                      ),
                    ),
                  ),
                  // ADR-176 C: the committed recover intent. It satisfies NONE
                  // of the evidence arms above — the crashed attempt is bound to
                  // the RETIRED assignment epoch, so E3's
                  // `nodeAttempts.executionAssignmentId = executionAssignments.id`
                  // (active) can never match. That is why the arm is a sibling of
                  // the whole status+evidence conjunction rather than another
                  // member of the evidence `or`.
                  //
                  // The inner join above means a run with a NULL
                  // `execution_assignment_id` (a pre-Stage-A row) is not a
                  // candidate here at all; `driveResume` would refuse it anyway,
                  // and the reconcile sweep still reaches it.
                  and(
                    eq(runs.status, "Running"),
                    isNotNull(runs.resumeStartedAt),
                    isNotNull(runs.currentStepId),
                    eq(executionAssignments.state, "active"),
                    lt(
                      runs.crashRecoverAttempts,
                      CRASH_RECOVER_CONTINUATION_MAX_ATTEMPTS,
                    ),
                    // `lte`, not `lt`: a deadline exactly equal to now IS due.
                    or(
                      isNull(runs.crashRecoverNextRetryAt),
                      lte(runs.crashRecoverNextRetryAt, sql`clock_timestamp()`),
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
        // ADR-176: a committed recover intent is routed BEFORE the
        // WaitingOnChildren arm and always `continue`s, so it can never fall
        // through to the ordinary `runFlow` dispatch below.
        if (candidate.status === "Running" && candidate.resumeStartedAt) {
          await serveCrashRecover(candidate);
          continue;
        }
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
        log.error(
          { workerId, slot, reason },
          "flow-continuation-worker-degraded",
        );
        await runEventWakeBus.waitForProjection(1_000, controller.signal);
      }
    }
  };
  // ADR-176 — the routed crash-recover re-entry.
  //
  // The SQL predicate identifies a candidate; it does not authorize
  // `driveResume`. Liveness decides, and it is a PROBE, not a column: the
  // sweep resolves it from one `listSessions()` per tick and skips the whole
  // tick when that call throws. Here the probe runs only for a candidate that
  // has already passed the cheap SQL filter AND the grace guard — a state that
  // exists only after a web death — so it is per-rare-candidate, never
  // per-tick. A throwing probe YIELDS the candidate to the sweep and
  // dispatches nothing, mirroring the sweep's own skip-on-probe-failure.
  //
  // The worker deliberately does NOT take `claimFlowDriver`: the claim already
  // serializes dispatch inside `runFlow`, from its single call site, and a
  // second claim here would make that call return null and the dispatch a
  // silent no-op.
  const serveCrashRecover = async (candidate: {
    id: string;
    resumeStartedAt: Date | null;
    currentStepId: string | null;
  }): Promise<void> => {
    const hosts =
      input.executionHosts ?? createExecutionHosts({ db: input.db });
    const [latestAttempt] = await input.db
      .select({ startedAt: nodeAttempts.startedAt })
      .from(nodeAttempts)
      .where(eq(nodeAttempts.runId, candidate.id))
      .orderBy(desc(nodeAttempts.startedAt))
      .limit(1);
    const graceSeconds = reconcileGraceSeconds();
    const anchorRoute = routeCrashRecover({
      // Probe only past the grace guard: inside grace the answer is `wait`
      // whatever liveness says, and the probe is a supervisor round trip.
      liveSession: false,
      resumeStartedAt: candidate.resumeStartedAt,
      latestAttemptStartedAt: latestAttempt?.startedAt ?? null,
      nowMs: Date.now(),
      graceSeconds,
    });

    if (anchorRoute === "wait") return;

    let liveSession: boolean;

    try {
      const records = await hosts.local().listSessions();

      liveSession = records.some(
        (record: { runId: string; status: string }) =>
          record.runId === candidate.id && record.status === "live",
      );
    } catch (error) {
      log.warn(
        {
          workerId,
          runId: candidate.id,
          reason: error instanceof Error ? error.message : String(error),
        },
        "flow-continuation-crash-recover-probe-failed",
      );

      return;
    }
    const route = routeCrashRecover({
      liveSession,
      resumeStartedAt: candidate.resumeStartedAt,
      latestAttemptStartedAt: latestAttempt?.startedAt ?? null,
      nowMs: Date.now(),
      graceSeconds,
    });

    if (route === "wait") return;
    log.info(
      {
        workerId,
        runId: candidate.id,
        targetStepId: candidate.currentStepId,
        route,
      },
      "flow-continuation-crash-recover-reentry",
    );
    if (route === "reattach") {
      // A live session is re-entered through the graph, NEVER through
      // `driveResume`: its `closeCrashedNodeAttempts` would close an attempt
      // the session is still producing and the re-prompt would double-spend
      // that turn. This arm is the sweep's existing behaviour and carries no
      // new per-run bound, so it writes no budget.
      await runFlow(candidate.id, {
        ...input,
        executionHosts: hosts,
        crashResume: { targetStepId: candidate.currentStepId as string },
        signal: controller.signal,
      });

      return;
    }

    const outcome = await driveResume(candidate.id, {
      db: input.db,
      executionHosts: hosts,
    });

    log.info(
      { workerId, runId: candidate.id, route, state: outcome.state },
      "flow-continuation-crash-recover-reentry",
    );
    await recordCrashRecoverContinuationOutcome(
      input.db,
      candidate.id,
      outcome.state,
    );
  };

  const slots = Array.from(
    { length: projectionLimitsFromEnv().concurrency },
    (_, slot) => serve(slot),
  );
  let shutdown: Promise<void> | undefined;

  log.info(
    { workerId, concurrency: slots.length },
    "flow-continuation-worker-started",
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
        log.info({ workerId }, "flow-continuation-worker-stopped");
      })();

      return shutdown;
    },
  };
}
