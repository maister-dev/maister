import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHosts } from "@/lib/execution-host/client";

import {
  and,
  asc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  or,
  sql,
} from "drizzle-orm";
import pino from "pino";

import { startAgentSession } from "./launch";
import { AgentPromptContinuationPending } from "./prompt-owner";

import { agentTurns, hitlRequests, runs } from "@/lib/db/schema";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { projectionTransaction } from "@/lib/execution-host/events/projection-transaction";
import { runEventWakeBus } from "@/lib/execution-host/events/run-wake";
import { isMaisterError } from "@/lib/errors";
import { claimAgentResumeSlot } from "@/lib/services/hitl";

const log = pino({
  name: "agent-continuation-worker",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Accepted turns and pending choices are the queue. Each bounded pass enters
 * the ordinary cap claim and idempotent create/prompt/application paths. It
 * cannot mint authority from an event or keep a hung run ahead of its siblings.
 * Activation is held until the S2 owner gate is qualified.
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
  const hosts = input.executionHosts ?? createExecutionHosts({ db: input.db });
  let reason: string | null = null;
  let stopped = false;
  const serve = async (): Promise<void> => {
    let cursor: string | null = null;

    while (!controller.signal.aborted) {
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(5_000),
      ]);

      try {
        const [candidate] = await projectionTransaction(input.db, (tx) =>
          tx
            .select({ id: runs.id, status: runs.status })
            .from(runs)
            .where(
              and(
                eq(runs.runKind, "agent"),
                cursor ? gt(runs.id, cursor) : undefined,
                or(
                  and(
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
                          ),
                        ),
                    ),
                  ),
                  and(
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
                              sql`${hitlRequests.respondedAt} IS NULL`,
                              sql`${hitlRequests.schema}->'agentPrompt' IS NOT NULL`,
                              sql`jsonb_typeof(${hitlRequests.response}->'optionId') = 'string'`,
                            ),
                          ),
                      ),
                    ),
                  ),
                  and(
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
        if (candidate.status === "NeedsInputIdle") {
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
          { reason, runId: cursor },
          "agent-continuation-worker-degraded",
        );
        await runEventWakeBus.waitForProjection(1_000, controller.signal);
      }
    }
  };
  const running = serve();
  let shutdown: Promise<void> | undefined;

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
      })();

      return shutdown;
    },
  };
}
