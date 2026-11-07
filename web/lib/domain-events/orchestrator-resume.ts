import "server-only";

import type { DomainEventRow } from "@/lib/db/schema";
import type { DomainEventConsumer } from "@/lib/domain-events/consumers";
import type { Db } from "@/lib/execution-host/db";
import type { ResumeFlow } from "@/lib/flows/graph/coordinator-wake";

import pino from "pino";
import { eq } from "drizzle-orm";

import { taskLaunchIntents } from "@/lib/db/schema";
import { hasUnobservedChildOutcome } from "@/lib/orchestrator/child-obligations";
import { getDb } from "@/lib/db/client";
import { isRunSettledEventKind } from "@/lib/domain-events/taxonomy";
import { isMaisterError } from "@/lib/errors";
import {
  currentCoordinator,
  wakeParkedCoordinator,
} from "@/lib/flows/graph/coordinator-wake";

const log = pino({
  name: "orchestrator-resume",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Child events and the runner's post-park catch-up share the coordinator CAS. */
export function buildOrchestratorResumeConsumer(
  opts: { db?: unknown; resumeFlow?: ResumeFlow } = {},
): DomainEventConsumer {
  return {
    id: "orchestrator_resume",
    startFrom: "now",
    async handle(events: DomainEventRow[]): Promise<void> {
      const db = (opts.db ?? getDb()) as Db;

      for (const event of events) {
        try {
          const payload = (event.payload ?? {}) as Record<string, unknown>;
          let parentRunId = payload.parentRunId;

          if (event.kind === "task.launch_changed") {
            if (typeof payload.intentId !== "string") continue;
            const [intent] = await db
              .select()
              .from(taskLaunchIntents)
              .where(eq(taskLaunchIntents.id, payload.intentId));

            if (
              !intent ||
              intent.projectId !== event.projectId ||
              intent.basis.kind !== "execution_child" ||
              intent.runId !== null ||
              intent.originalRunId !== null ||
              !["failed", "cancelled"].includes(intent.state)
            )
              continue;
            const acceptedParentRunId = intent.basis.parent.parentRunId;

            parentRunId = acceptedParentRunId;
            if (!(await hasUnobservedChildOutcome(db, acceptedParentRunId)))
              continue;
          } else if (!isRunSettledEventKind(event.kind)) continue;
          if (typeof parentRunId !== "string" || !parentRunId) continue;
          const coordinator = await currentCoordinator(db, parentRunId);

          if (coordinator?.status === "Running") {
            log.warn(
              {
                eventId: event.id,
                childRunId: event.runId,
                parentRunId,
                nodeId: coordinator.nodeId,
                nodeAttemptId: coordinator.nodeAttemptId,
              },
              "child settled before parent parked — catch-up owns the wake",
            );
            continue;
          }
          if (!coordinator || coordinator.status !== "WaitingOnChildren")
            continue;
          const childFailed =
            event.kind === "run.failed" ||
            event.kind === "run.crashed" ||
            event.kind === "run.abandoned";
          const result = await wakeParkedCoordinator({
            db,
            parentRunId,
            cause: "settled_child",
            allowFailedOrchestratorChild: childFailed,
            expectedAttemptId: coordinator.nodeAttemptId,
            resumeFlow: opts.resumeFlow,
          });

          if (result.kind !== "woken")
            log.debug(
              { eventId: event.id, parentRunId, result },
              "coordinator-child-wake-skipped",
            );
        } catch (error) {
          log.warn(
            {
              eventId: event.id,
              code: isMaisterError(error) ? error.code : "UNKNOWN",
              error: error instanceof Error ? error.message : String(error),
            },
            "orchestrator-resume: event handling failed (logged, not thrown)",
          );
        }
      }
    },
  };
}

export const orchestratorResumeConsumer = buildOrchestratorResumeConsumer();
