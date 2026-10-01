import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHosts } from "@/lib/execution-host/client";

import { randomUUID } from "node:crypto";

import {
  and,
  asc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import pino from "pino";

import { startAgentSession } from "./launch";
import { GENERATION_TURN_VARIANTS, OWNED_TURN_VARIANTS } from "./turn-variants";
import { AgentPromptContinuationPending } from "./prompt-owner";

import {
  agentTurns,
  executionAssignments,
  executionCommands,
  hitlRequests,
  runMessages,
  runs,
  runSessionIncarnations,
  runSessions,
  scratchRuns,
} from "@/lib/db/schema";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { ADMISSIBLE_PROMPT_INCARNATION_STATES } from "@/lib/execution-host/session-binding";
import { projectionTransaction } from "@/lib/execution-host/events/projection-transaction";
import { runEventWakeBus } from "@/lib/execution-host/events/run-wake";
import { isMaisterError } from "@/lib/errors";
import { claimAgentResumeSlot } from "@/lib/services/hitl";

const log = pino({
  name: "agent-continuation-worker",
  level: process.env.LOG_LEVEL ?? "info",
});

// A dialog that has just gone `WaitingForUser` belongs to its own `afterCommit`
// dispatch for this long; only a row still queued after it was left behind by
// a process death or a retryable failure (ADR-182 open item A4).
export const SCRATCH_REDRIVE_SETTLE_MS = 5_000;

/** Detached, like every other wake of the scratch dispatcher: it awaits the
 * whole turn it starts (ADR-182 C27). Single-winner by the dispatcher's own
 * `lockRunRows` + `queued → prompted` CAS + `WaitingForUser` check, so a live
 * `afterCommit` wake racing this one makes it a no-op; FIFO by its
 * `ORDER BY sequence`. No attempt counter: a retryable failure returns the row
 * to the queue and stamps the dialog, which re-arms the settle window. */
function redriveScratchContinuation(
  db: Db,
  runId: string,
  hosts: ExecutionHosts,
): void {
  void (async () => {
    const [scratch] = await db
      .select({ status: scratchRuns.dialogStatus })
      .from(scratchRuns)
      .where(eq(scratchRuns.runId, runId));

    if (scratch?.status === "Running") {
      const { redriveRunningScratchPrompt } = await import(
        "@/lib/scratch-runs/dispatch-recovery"
      );

      await redriveRunningScratchPrompt(db, runId, hosts);

      return;
    }
    const { dispatchQueuedScratchMessages } = await import(
      "@/lib/scratch-runs/service"
    );
    const { dispatched, skipped } = await dispatchQueuedScratchMessages(
      db as never,
      runId,
      hosts,
      { source: "redrive" },
    );

    if (!dispatched)
      log.debug({ runId, reason: skipped }, "scratch-redrive-skipped");
  })().catch((error: unknown) =>
    log.warn(
      {
        runId,
        code: isMaisterError(error) ? error.code : "UNKNOWN",
        err: error instanceof Error ? error.message : String(error),
      },
      "scratch-redrive-failed",
    ),
  );
}

/** Accepted turns and pending choices are the queue. Each bounded pass enters
 * the ordinary cap claim and idempotent create/prompt/application paths. It
 * cannot mint authority from an event or keep a hung run ahead of its siblings.
 * A single loop, unlike its two-slot siblings.
 */
export function startAgentContinuationWorker(input: {
  db: Db;
  executionHosts?: ExecutionHosts;
}): Readonly<{
  stop: () => Promise<void>;
  health: () => {
    state: "running" | "degraded" | "stopped";
    reason: string | null;
  };
}> {
  const controller = new AbortController();
  const workerId = `agent-continuation-worker:${randomUUID()}`;
  const hosts = input.executionHosts ?? createExecutionHosts({ db: input.db });
  let reason: string | null = null;
  let stopped = false;
  const serve = async (): Promise<void> => {
    let cursor: string | null = null;
    let tick = 0;

    while (!controller.signal.aborted) {
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(5_000),
      ]);

      try {
        tick += 1;
        const [candidate] = await projectionTransaction(input.db, (tx) =>
          tx
            .select({ id: runs.id, status: runs.status, runKind: runs.runKind })
            .from(runs)
            .where(
              and(
                inArray(runs.runKind, ["agent", "scratch"]),
                cursor ? gt(runs.id, cursor) : undefined,
                or(
                  // Age only selects a wake; admission proves ledger absence
                  // and current ownership under the run lock (ADR-192).
                  and(
                    eq(runs.runKind, "scratch"),
                    eq(runs.status, "Running"),
                    exists(
                      tx
                        .select({ runId: scratchRuns.runId })
                        .from(scratchRuns)
                        .where(
                          and(
                            eq(scratchRuns.runId, runs.id),
                            or(
                              and(
                                isNotNull(runs.projectId),
                                eq(scratchRuns.dialogStatus, "WaitingForUser"),
                                sql`${scratchRuns.updatedAt} < now() - make_interval(secs => ${SCRATCH_REDRIVE_SETTLE_MS / 1_000})`,
                                exists(
                                  tx
                                    .select({ id: runMessages.id })
                                    .from(runMessages)
                                    .where(
                                      and(
                                        eq(runMessages.runId, runs.id),
                                        eq(runMessages.delivery, "queued"),
                                      ),
                                    ),
                                ),
                              ),
                              and(
                                eq(scratchRuns.dialogStatus, "Running"),
                                sql`${scratchRuns.updatedAt} < now() - interval '1 second'`,
                                or(
                                  and(
                                    sql`${scratchRuns.activePromptIntent} IS NULL`,
                                    sql`${scratchRuns.errorMetadata}->>'reason' IS DISTINCT FROM 'scratch_dispatch_unknown'`,
                                  ),
                                  and(
                                    isNotNull(scratchRuns.activePromptIntent),
                                    notExists(
                                      tx
                                        .select({ id: executionCommands.id })
                                        .from(executionCommands)
                                        .where(
                                          and(
                                            eq(
                                              executionCommands.runId,
                                              runs.id,
                                            ),
                                            eq(
                                              executionCommands.kind,
                                              "session.prompt",
                                            ),
                                            sql`${executionCommands.logicalOperationKey} = ${scratchRuns.activePromptIntent}->>'logicalOperationKey'`,
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
                    exists(
                      tx
                        .select({ id: runSessions.id })
                        .from(runSessions)
                        .innerJoin(
                          runSessionIncarnations,
                          eq(
                            runSessionIncarnations.runSessionId,
                            runSessions.id,
                          ),
                        )
                        .where(
                          and(
                            eq(runSessions.runId, runs.id),
                            eq(runSessions.sessionName, "default"),
                            eq(
                              runSessions.executionAssignmentId,
                              runs.executionAssignmentId,
                            ),
                            eq(
                              runSessionIncarnations.hostSessionId,
                              runSessions.hostSessionId,
                            ),
                            inArray(runSessionIncarnations.state, [
                              ...ADMISSIBLE_PROMPT_INCARNATION_STATES,
                            ]),
                          ),
                        ),
                    ),
                  ),
                  and(
                    eq(runs.runKind, "agent"),
                    eq(runs.status, "Running"),
                    // No GENERATION turn — a message accepted in the launch
                    // window is not one, and must not hide the run (D-M2).
                    notExists(
                      tx
                        .select({ id: agentTurns.id })
                        .from(agentTurns)
                        .where(
                          and(
                            eq(agentTurns.runId, runs.id),
                            inArray(agentTurns.variant, [
                              ...GENERATION_TURN_VARIANTS,
                            ]),
                          ),
                        ),
                    ),
                    exists(
                      tx
                        .select({ id: executionAssignments.id })
                        .from(executionAssignments)
                        .where(
                          and(
                            eq(
                              executionAssignments.id,
                              runs.executionAssignmentId,
                            ),
                            eq(executionAssignments.state, "active"),
                            inArray(executionAssignments.placementReason, [
                              "launch",
                              "legacy_backfill",
                            ]),
                          ),
                        ),
                    ),
                  ),
                  and(
                    eq(runs.runKind, "agent"),
                    inArray(runs.status, ["Running", "NeedsInput"]),
                    exists(
                      tx
                        .select({ id: agentTurns.id })
                        .from(agentTurns)
                        .where(
                          and(
                            eq(agentTurns.runId, runs.id),
                            eq(
                              agentTurns.executionAssignmentId,
                              runs.executionAssignmentId,
                            ),
                            inArray(agentTurns.state, [
                              "claimed",
                              "dispatched",
                            ]),
                            inArray(agentTurns.variant, [
                              ...OWNED_TURN_VARIANTS,
                            ]),
                          ),
                        ),
                    ),
                  ),
                  and(
                    eq(runs.runKind, "agent"),
                    eq(runs.status, "NeedsInputIdle"),
                    or(
                      isNotNull(runs.resumeRequestedAt),
                      exists(
                        tx
                          .select({ id: hitlRequests.id })
                          .from(hitlRequests)
                          .where(
                            and(
                              eq(hitlRequests.runId, runs.id),
                              sql`${hitlRequests.supersededAt} IS NULL`,
                              sql`${hitlRequests.response}->'_agentResume' IS NULL`,
                              sql`${hitlRequests.schema}->'agentPrompt' IS NOT NULL`,
                              sql`jsonb_typeof(${hitlRequests.response}->'optionId') = 'string'`,
                            ),
                          ),
                      ),
                    ),
                  ),
                  and(
                    eq(runs.runKind, "agent"),
                    eq(runs.status, "Running"),
                    exists(
                      tx
                        .select({ id: hitlRequests.id })
                        .from(hitlRequests)
                        .where(
                          and(
                            eq(hitlRequests.runId, runs.id),
                            sql`${hitlRequests.response}->'_agentResume'->>'assignmentId' = ${runs.executionAssignmentId}`,
                            sql`${hitlRequests.response}->'_agentResume'->>'kind' = 'result'`,
                            sql`${hitlRequests.response}->'_agentResume'->>'applied' IS NULL`,
                          ),
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
          cursor = null;
          reason = null;
          await runEventWakeBus.waitForProjection(1_000, controller.signal);
          continue;
        }
        cursor = candidate.id;
        if (candidate.runKind === "scratch") {
          log.info(
            { workerId, tick, runId: candidate.id },
            "scratch-continuation-visit",
          );
          redriveScratchContinuation(input.db, candidate.id, hosts);
          reason = null;
          continue;
        }
        const [pause] =
          candidate.status === "NeedsInput"
            ? await input.db
                .select({ id: hitlRequests.id })
                .from(hitlRequests)
                .where(
                  and(
                    eq(hitlRequests.runId, candidate.id),
                    inArray(hitlRequests.kind, ["hook_trip", "budget_breach"]),
                    isNotNull(hitlRequests.respondedAt),
                    sql`${hitlRequests.schema}->'agentPrompt' IS NOT NULL`,
                    sql`${hitlRequests.response}->'_agentResume' IS NULL`,
                    sql`${hitlRequests.response}->>'optionId' IN ('resume', 'raise')`,
                  ),
                )
                .limit(1)
            : [];

        if (candidate.status === "NeedsInputIdle" || pause) {
          const claim = await claimAgentResumeSlot(
            input.db,
            candidate.id,
            hosts,
          );

          if (claim.outcome !== "claimed") continue;
        }
        await startAgentSession(candidate.id, {
          ...input,
          executionHosts: hosts,
          signal,
        });
        reason = null;
      } catch (error) {
        if (controller.signal.aborted) break;
        if (error instanceof AgentPromptContinuationPending || signal.aborted)
          continue;
        reason = isMaisterError(error) ? error.code : "service_failure";
        log.error(
          { workerId, reason, runId: cursor },
          "agent-continuation-worker-degraded",
        );
        await runEventWakeBus.waitForProjection(1_000, controller.signal);
      }
    }
  };
  const running = serve();
  let shutdown: Promise<void> | undefined;

  // Concurrency is 1 by construction here: a single loop, not the two slots
  // its prompt-owner and flow siblings take from `projectionLimitsFromEnv`.
  log.info({ workerId, concurrency: 1 }, "agent-continuation-worker-started");

  return {
    health: () => ({
      state: stopped ? "stopped" : reason ? "degraded" : "running",
      reason,
    }),
    stop: () => {
      shutdown ??= (async () => {
        controller.abort();
        await running;
        stopped = true;
        log.info({ workerId }, "agent-continuation-worker-stopped");
      })();

      return shutdown;
    },
  };
}
