import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { and, eq, exists, inArray, sql } from "drizzle-orm";

import { nodeAttempts, runs } from "@/lib/db/schema";

// Every parent status in which the orchestrator node's attempt can still be
// open. A parent paused on its own HITL must keep the intent too, or it parks
// later behind pending siblings with the failure unhandled.
const ARMABLE_PARENT_STATUSES = [
  "Running",
  "NeedsInput",
  "NeedsInputIdle",
  "WaitingOnChildren",
] as const;

/** Record an orchestrator failure wake in the child's terminal transaction. */
export async function armFailedCoordinatorWake(
  db: Db,
  parentRunId: string,
): Promise<boolean> {
  const armed = await db
    .update(runs)
    .set({
      failedChildWakeAt: sql`coalesce(${runs.failedChildWakeAt}, clock_timestamp())`,
    })
    .where(
      and(
        eq(runs.id, parentRunId),
        inArray(runs.status, [...ARMABLE_PARENT_STATUSES]),
        exists(
          db
            .select({ id: nodeAttempts.id })
            .from(nodeAttempts)
            .where(
              and(
                eq(nodeAttempts.runId, runs.id),
                eq(nodeAttempts.nodeId, runs.currentStepId),
                eq(nodeAttempts.nodeType, "orchestrator"),
                inArray(nodeAttempts.status, ["Running", "NeedsInput"]),
              ),
            ),
        ),
      ),
    )
    .returning({ id: runs.id });

  return armed.length > 0;
}

/** The coordinator's turn has started and will observe every settled child. */
export async function clearFailedCoordinatorWake(
  db: Db,
  runId: string,
): Promise<void> {
  await db
    .update(runs)
    .set({ failedChildWakeAt: null })
    .where(eq(runs.id, runId));
}
