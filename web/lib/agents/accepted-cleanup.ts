import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { eq } from "drizzle-orm";
import pino from "pino";

import { acquirePreparationWorkspace } from "./preparation-workspace";
import { assertTerminalAgentCleanupExecutionQuiescent } from "./execution-quiescence";

import { runs } from "@/lib/db/schema";
import { taskAgentPreparationWorkspace } from "@/lib/tasks/launch-agent-execution";
import { MaisterError } from "@/lib/errors";

const log = pino({ name: "accepted-agent-cleanup" });

/** Terminal rows and their materialization leases remain durable GC candidates when physical ownership is busy. */
export async function withAcceptedAgentCleanup<Result>(
  db: Db,
  runId: string,
  effect: () => Promise<Result>,
): Promise<Result> {
  const [initial] = await db.select().from(runs).where(eq(runs.id, runId));

  if (
    !initial?.taskLaunchIntentId ||
    initial.runKind !== "agent" ||
    initial.agentKind !== "code_delivery" ||
    !["Done", "Failed", "Abandoned"].includes(initial.status)
  )
    throw new MaisterError(
      "PRECONDITION",
      "Accepted agent resources are retained for their current run owner",
      { details: { reason: "launch_cleanup_retained", runId } },
    );
  const descriptor = await taskAgentPreparationWorkspace(db, initial);
  let fence: Awaited<ReturnType<typeof acquirePreparationWorkspace>>;

  try {
    fence = await acquirePreparationWorkspace(descriptor);
  } catch (error) {
    log.warn(
      {
        runId,
        status: initial.status,
        reason: "launch_cleanup_deferred",
        errorType: error instanceof Error ? error.name : "unknown",
      },
      "accepted agent cleanup remains queued in terminal-run GC",
    );
    throw error;
  }
  try {
    return await fence.run(async () => {
      const [current] = await db.select().from(runs).where(eq(runs.id, runId));

      if (
        !current ||
        current.status !== initial.status ||
        current.endedAt?.getTime() !== initial.endedAt?.getTime() ||
        current.executionAssignmentId !== initial.executionAssignmentId
      )
        throw new MaisterError(
          "CONFLICT",
          "Accepted agent cleanup no longer owns the terminal generation",
          { details: { reason: "assignment_fenced", runId } },
        );
      await assertTerminalAgentCleanupExecutionQuiescent(db, current);

      return effect();
    });
  } finally {
    await fence.release();
  }
}
