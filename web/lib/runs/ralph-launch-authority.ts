import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type {
  TaskLaunchServerSource,
  TaskLaunchServerSourceSnapshot,
} from "@/lib/tasks/launch-server-source";

import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { runs, tasks, taskLaunchIntents } from "@/lib/db/schema";
import { retryDigest } from "@/lib/agents/retry-guards";
import { ralphMaxAttempts } from "@/lib/instance-config";
import { crashRetryFromSnapshot } from "@/lib/runs/execution-policy";
import { launchRefusal } from "@/lib/tasks/launch-resolution";
import { createTaskLaunchServerSource } from "@/lib/tasks/launch-server-source";

const payloadSchema = z
  .object({
    kind: z.literal("ralph_retry"),
    sourceRunId: z.string().min(1),
    sourceAttemptNumber: z.number().int().nonnegative(),
  })
  .strict();

export async function loadRalphRetryLaunchScope(db: Db, sourceRunId: string) {
  const [facts] = await db
    .select({ run: runs, task: tasks })
    .from(runs)
    .innerJoin(
      tasks,
      and(eq(tasks.id, runs.taskId), eq(tasks.projectId, runs.projectId)),
    )
    .where(eq(runs.id, sourceRunId));

  if (!facts || !facts.run.projectId || !facts.run.taskId)
    throw launchRefusal("ralph_retry_source_unavailable", "PRECONDITION");

  return {
    ...facts,
    scope: {
      kind: "ralph_retry" as const,
      id: facts.run.id,
      projectId: facts.run.projectId,
      taskId: facts.run.taskId,
    },
    requestKey: `ralph_retry:${facts.run.id}`,
  };
}

function sourceSnapshot(
  facts: Awaited<ReturnType<typeof loadRalphRetryLaunchScope>>,
  sourceAttemptNumber: number,
): TaskLaunchServerSourceSnapshot {
  const payload = {
    kind: "ralph_retry" as const,
    sourceRunId: facts.run.id,
    sourceAttemptNumber,
  };

  return {
    version: 1,
    ...facts.scope,
    revisionDigest: retryDigest({
      version: 1,
      ...facts.scope,
      sourceAttemptNumber,
      executionPolicy: facts.run.executionPolicy,
      flowId: facts.run.flowId,
      flowRevisionId: facts.run.flowRevisionId,
    }),
    execution: { triggerSource: "domain_event", triggerPayload: payload },
  };
}

/** The failed root and its snapshotted loop policy own one automated retry, never a human grant. */
export async function createRalphRetryLaunchSource(
  db: Db,
  sourceRunId: string,
): Promise<TaskLaunchServerSource> {
  const facts = await loadRalphRetryLaunchScope(db, sourceRunId);

  return createTaskLaunchServerSource(
    db,
    sourceSnapshot(facts, facts.task.attemptNumber),
    assertStoredRalphRetryLaunchSource,
  );
}

/** Reconstruct after restart, allowing this intent's own next-attempt allocation and bound successor only. */
export async function assertStoredRalphRetryLaunchSource(
  db: Db,
  source: TaskLaunchServerSourceSnapshot,
): Promise<void> {
  const payload = payloadSchema.safeParse(source.execution.triggerPayload);

  if (
    source.kind !== "ralph_retry" ||
    !payload.success ||
    payload.data.sourceRunId !== source.id
  )
    throw launchRefusal("launch_source_snapshot_incomplete", "PRECONDITION");
  const facts = await loadRalphRetryLaunchScope(db, source.id);
  const sourceAttempt = payload.data.sourceAttemptNumber;

  if (
    facts.run.runKind !== "flow" ||
    facts.run.parentRunId ||
    !["Failed", "Crashed"].includes(facts.run.status) ||
    ["Done", "Abandoned"].includes(facts.task.status) ||
    crashRetryFromSnapshot(facts.run.executionPolicy) !== "ralph_loop" ||
    retryDigest(sourceSnapshot(facts, sourceAttempt)) !== retryDigest(source)
  )
    throw launchRefusal("ralph_retry_source_changed", "PRECONDITION");
  if (sourceAttempt >= ralphMaxAttempts())
    throw launchRefusal("ralph_retry_limit_reached", "PRECONDITION");
  const [owner] = await db
    .select()
    .from(taskLaunchIntents)
    .where(
      and(
        eq(taskLaunchIntents.principalKind, "system"),
        eq(taskLaunchIntents.principalId, `ralph_retry:${source.id}`),
        eq(taskLaunchIntents.operation, "retry"),
        eq(taskLaunchIntents.requestKey, facts.requestKey),
        eq(taskLaunchIntents.projectId, source.projectId),
        eq(taskLaunchIntents.taskId, source.taskId),
      ),
    );
  const allocated = owner?.preparationIdentity;

  if (
    allocated
      ? allocated.taskAttemptNumber !== sourceAttempt + 1 ||
        facts.task.attemptNumber !== allocated.taskAttemptNumber
      : facts.task.attemptNumber !== sourceAttempt
  )
    throw launchRefusal("ralph_retry_source_changed", "PRECONDITION");
  const [latest] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.taskId, facts.task.id), eq(runs.runKind, "flow")))
    .orderBy(desc(runs.startedAt), desc(runs.id))
    .limit(1);

  if (latest?.id !== facts.run.id && latest?.id !== owner?.originalRunId)
    throw launchRefusal("ralph_retry_source_changed", "PRECONDITION");
}
