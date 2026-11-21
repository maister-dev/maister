import "server-only";

import type { DomainEventRow } from "@/lib/db/schema";
import type { DomainEventConsumer } from "@/lib/domain-events/consumers";
import type { SQL } from "drizzle-orm";
import type { WaitDb, WaitTx } from "@/lib/waits/store";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import { runWaits } from "@/lib/db/schema";
import { WAIT_RUN_FACTS } from "@/lib/waits/facts";
import { resolveObservedWait } from "@/lib/waits/resolve";

const log = pino({
  name: "wait-resolver",
  level: process.env.LOG_LEVEL ?? "info",
});

function sourcePredicate(event: DomainEventRow): SQL | undefined {
  if (
    [
      "run.workspace_head_changed",
      "run.ci_observed",
      "run.pr_observed",
      "run.publication_observed",
    ].includes(event.kind) &&
    event.runId
  ) {
    const publicationId = event.payload.publicationId;

    return and(
      eq(runWaits.runId, event.runId),
      typeof publicationId === "string"
        ? eq(runWaits.publicationId, publicationId)
        : eq(runWaits.conditionKind, "signal"),
    );
  }
  if (
    event.kind === "run.wait_registered" ||
    event.kind === "run.wait_delivery_recorded"
  ) {
    const waitId = event.payload.waitId;

    if (event.runId && typeof waitId === "string")
      return and(eq(runWaits.id, waitId), eq(runWaits.runId, event.runId));
  }

  if (event.kind === "task.comment_added" && event.taskId)
    return and(
      eq(runWaits.conditionKind, "comment"),
      eq(runWaits.sourceTargetId, event.taskId),
    );
  if (event.kind in WAIT_RUN_FACTS && event.runId)
    return and(
      eq(runWaits.conditionKind, "run"),
      eq(runWaits.sourceTargetId, event.runId),
    );

  return undefined;
}

export function buildWaitResolver(
  getDatabase: () => WaitDb & Pick<WaitTx, "select">,
): DomainEventConsumer {
  return {
    id: "wait_resolver",
    // The first pass must replay waits parked before this worker first boots.
    startFrom: "beginning",
    async handle(events) {
      const db = getDatabase();
      const failures: unknown[] = [];

      for (const event of events) {
        const source = sourcePredicate(event);

        if (!source || !event.projectId) continue;

        const candidates = await db
          .select({
            waitId: runWaits.id,
            projectId: runWaits.projectId,
            runId: runWaits.runId,
          })
          .from(runWaits)
          .where(
            and(
              eq(runWaits.projectId, event.projectId),
              eq(runWaits.state, "open"),
              source,
            ),
          );

        for (const address of candidates) {
          try {
            await resolveObservedWait(db, address);
          } catch (error: unknown) {
            log.warn(
              { ...address, eventId: event.id, err: error },
              "wait event resolution deferred",
            );
            failures.push(error);
          }
        }
      }

      if (failures.length)
        throw new AggregateError(
          failures,
          "Condition wait event resolution failed",
        );
    },
  };
}

export const waitResolverConsumer = buildWaitResolver(getDb);
