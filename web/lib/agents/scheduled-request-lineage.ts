import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ScheduledAgentRequestSnapshot } from "@/lib/agents/scheduled-request";

import { eq } from "drizzle-orm";

import { runs } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { parseScheduledRequestSnapshot } from "@/lib/agents/scheduled-request";

function mismatch(): MaisterError {
  return new MaisterError(
    "PRECONDITION",
    "Scheduled request source does not belong to this launch",
    { details: { reason: "scheduled_request_source_mismatch" } },
  );
}

export async function loadFlowScheduledRequestSource(
  db: Db,
  input: { sourceRunId: string; projectId: string; taskId: string },
): Promise<{
  snapshot: ScheduledAgentRequestSnapshot;
  agentId: string;
  executionPolicy: typeof runs.$inferSelect.executionPolicy;
} | null> {
  const [source] = await db
    .select({
      projectId: runs.projectId,
      taskId: runs.taskId,
      runKind: runs.runKind,
      agentId: runs.agentId,
      executionPolicy: runs.executionPolicy,
      snapshot: runs.scheduledRequestSnapshot,
    })
    .from(runs)
    .where(eq(runs.id, input.sourceRunId));

  if (
    !source ||
    source.projectId !== input.projectId ||
    source.taskId !== input.taskId ||
    source.runKind !== "flow"
  )
    throw mismatch();
  const snapshot = parseScheduledRequestSnapshot(source.snapshot);

  if (!snapshot) return null;
  if (!source.agentId) throw mismatch();

  return {
    snapshot,
    agentId: source.agentId,
    executionPolicy: source.executionPolicy,
  };
}

export async function loadAgentBudgetRestartRequest(
  db: Db,
  input: {
    sourceRunId: string;
    projectId: string;
    taskId: string | null;
    agentId: string;
  },
): Promise<ScheduledAgentRequestSnapshot | null> {
  const [source] = await db
    .select({
      projectId: runs.projectId,
      taskId: runs.taskId,
      runKind: runs.runKind,
      agentId: runs.agentId,
      snapshot: runs.scheduledRequestSnapshot,
    })
    .from(runs)
    .where(eq(runs.id, input.sourceRunId));

  if (
    !source ||
    source.projectId !== input.projectId ||
    source.taskId !== input.taskId ||
    source.agentId !== input.agentId ||
    source.runKind !== "agent"
  )
    throw mismatch();

  return parseScheduledRequestSnapshot(source.snapshot);
}
