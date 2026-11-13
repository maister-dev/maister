import "server-only";

import type { DomainEventRow } from "@/lib/db/schema";
import type { DomainEventConsumer } from "@/lib/domain-events/consumers";
import type { Db } from "@/lib/execution-host/db";
import type { ResumeFlow } from "@/lib/flows/graph/coordinator-wake";

import pino from "pino";
import { eq, sql } from "drizzle-orm";

import { taskLaunchIntents } from "@/lib/db/schema";
import { hasUnobservedChildOutcome } from "@/lib/orchestrator/child-obligations";
import { isProjectDomainEvent } from "@/lib/domain-events/scope";
import { getDb } from "@/lib/db/client";
import {
  isRunSettledEventKind,
  isRunTerminalEventKind,
  isTerminalCauseStatus,
  TERMINAL_CAUSE_KIND_FOR_STATUS,
} from "@/lib/domain-events/taxonomy";
import { isMaisterError } from "@/lib/errors";
import {
  currentCoordinator,
  wakeParkedCoordinator,
} from "@/lib/flows/graph/coordinator-wake";

const log = pino({
  name: "orchestrator-resume",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Company facts can wake only the actual parent of an exact governed child appointment. */
async function hasCompanyChildAppointment(
  db: Db,
  event: DomainEventRow,
  parentRunId: string,
): Promise<boolean> {
  if (!event.runId || !event.companyId || event.projectId !== null)
    return false;
  const [appointment] = (
    await db.execute<{ status: string }>(sql`
    SELECT child.status FROM runs child
    JOIN runs parent ON parent.id=child.parent_run_id AND parent.company_id=child.company_id
    JOIN specialist_run_links child_link ON child_link.run_id=child.id
    JOIN specialist_run_links parent_link ON parent_link.run_id=parent.id AND parent_link.assignment_id=child_link.assignment_id
    JOIN specialist_work work ON work.id=child_link.work_id AND work.work_revision=child_link.work_revision
      AND work.assignment_id=child_link.assignment_id AND work.child_run_id=child.id AND work.parent_run_id=parent.id
    WHERE child.id=${event.runId} AND parent.id=${parentRunId} AND child.company_id=${event.companyId}
      AND child.project_id IS NULL AND parent.project_id IS NULL AND child_link.work_witness IS NOT NULL
    LIMIT 1
  `)
  ).rows;

  if (!appointment) return false;
  if (appointment.status === "Done") return event.kind === "run.done";

  return (
    isTerminalCauseStatus(appointment.status) &&
    TERMINAL_CAUSE_KIND_FOR_STATUS[appointment.status] === event.kind
  );
}

/** Child events and the runner's post-park catch-up share the coordinator CAS. */
export function buildOrchestratorResumeConsumer(
  opts: { db?: unknown; resumeFlow?: ResumeFlow } = {},
): DomainEventConsumer {
  return {
    id: "orchestrator_resume",
    startFrom: "now",
    async handle(receivedEvents: DomainEventRow[]): Promise<void> {
      const events = receivedEvents.filter(
        (event) =>
          isProjectDomainEvent(event) ||
          (event.companyId && isRunTerminalEventKind(event.kind)),
      );

      if (events.length === 0) return;
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
          if (
            event.companyId &&
            !(await hasCompanyChildAppointment(db, event, parentRunId))
          ) {
            log.debug(
              { eventId: event.id, childRunId: event.runId, parentRunId },
              "company child wake refused without an exact appointment",
            );
            continue;
          }
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
