import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { and, eq, exists, inArray, sql } from "drizzle-orm";

import { nodeAttempts, runs } from "@/lib/db/schema";

/** Record an orchestrator failure wake in the child's terminal transaction. */
export async function armFailedCoordinatorWake(
  db: Db,
  parentRunId: string,
): Promise<boolean> {
  const armed = await db
    .update(runs)
    .set({
      resumeRequestedAt: sql`coalesce(${runs.resumeRequestedAt}, clock_timestamp())`,
    })
    .where(
      and(
        eq(runs.id, parentRunId),
        inArray(runs.status, ["Running", "WaitingOnChildren"]),
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
