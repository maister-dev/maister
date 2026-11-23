import "server-only";

import type { Db } from "@/lib/execution-host/db";

import {
  and,
  asc,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  notExists,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import {
  executionAssignments,
  executionCommands,
  executionEvents,
  nodeAttempts,
  projects,
  runs,
  runSessionIncarnations,
  specialistRunLinks,
  tasks,
} from "@/lib/db/schema";
import { TURN_LOST_DECISION } from "@/lib/flows/graph/attempt-decisions";
import { CRASH_RECOVER_CONTINUATION_MAX_ATTEMPTS } from "@/lib/runs/crash-recover";

export async function findHostRestartRecovery(
  db: Db,
  filter: { afterRunId?: string; runId?: string; assignmentId?: string },
) {
  const [candidate] = await db
    .select({
      runId: runs.id,
      projectId: projects.id,
      assignmentId: executionAssignments.id,
      hostId: executionAssignments.executionHostId,
    })
    .from(runs)
    .innerJoin(projects, eq(projects.id, runs.projectId))
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .innerJoin(
      executionAssignments,
      eq(executionAssignments.id, runs.executionAssignmentId),
    )
    .where(
      and(
        eq(runs.status, "Crashed"),
        eq(runs.runKind, "flow"),
        notInArray(tasks.status, ["Done", "Abandoned"]),
        isNull(runs.parentRunId),
        isNull(runs.agentKind),
        isNull(projects.archivedAt),
        eq(executionAssignments.state, "released"),
        eq(executionAssignments.releasedReason, "crashed"),
        filter.runId ? eq(runs.id, filter.runId) : undefined,
        filter.assignmentId
          ? eq(executionAssignments.id, filter.assignmentId)
          : undefined,
        filter.afterRunId ? gt(runs.id, filter.afterRunId) : undefined,
        lt(runs.crashRecoverAttempts, CRASH_RECOVER_CONTINUATION_MAX_ATTEMPTS),
        or(
          isNull(runs.crashRecoverNextRetryAt),
          lte(runs.crashRecoverNextRetryAt, sql`clock_timestamp()`),
        ),
        notExists(
          db
            .select({ id: specialistRunLinks.runId })
            .from(specialistRunLinks)
            .where(eq(specialistRunLinks.runId, runs.id)),
        ),
        exists(
          db
            .select({ id: executionEvents.id })
            .from(executionEvents)
            .innerJoin(
              executionCommands,
              and(
                eq(executionCommands.runId, executionEvents.runId),
                eq(
                  executionCommands.executionAssignmentId,
                  executionEvents.executionAssignmentId,
                ),
                eq(
                  executionCommands.assignmentEpoch,
                  executionEvents.assignmentEpoch,
                ),
                eq(
                  executionCommands.executionHostId,
                  executionEvents.executionHostId,
                ),
                eq(
                  executionCommands.targetSessionId,
                  executionEvents.hostSessionId,
                ),
              ),
            )
            .innerJoin(
              nodeAttempts,
              and(
                eq(
                  nodeAttempts.id,
                  sql`${executionCommands.ownerRef}->>'nodeAttemptId'`,
                ),
                eq(nodeAttempts.runId, runs.id),
                eq(nodeAttempts.executionAssignmentId, executionAssignments.id),
                eq(nodeAttempts.nodeId, runs.resumeTargetStepId),
              ),
            )
            .innerJoin(
              runSessionIncarnations,
              and(
                eq(
                  runSessionIncarnations.id,
                  sql`${executionCommands.ownerRef}->>'incarnationId'`,
                ),
                eq(runSessionIncarnations.runId, executionEvents.runId),
                eq(
                  runSessionIncarnations.executionAssignmentId,
                  executionEvents.executionAssignmentId,
                ),
                eq(
                  runSessionIncarnations.executionHostId,
                  executionEvents.executionHostId,
                ),
                eq(
                  runSessionIncarnations.hostSessionId,
                  executionEvents.hostSessionId,
                ),
                sql`${runSessionIncarnations.hostBootId} <> ${executionEvents.hostBootId}`,
              ),
            )
            .where(
              and(
                eq(executionEvents.runId, runs.id),
                eq(
                  executionEvents.executionAssignmentId,
                  executionAssignments.id,
                ),
                eq(executionEvents.eventType, "session.crashed"),
                eq(executionEvents.source, "host"),
                sql`${executionEvents.payload}->>'reason' = 'host_restart'`,
                // The lost prompt can release the assignment before this event arrives.
                or(
                  eq(executionEvents.ingestDisposition, "accepted"),
                  and(
                    eq(executionEvents.ingestDisposition, "stale_epoch"),
                    sql`${executionEvents.ingestError}->>'reason' = 'stale_assignment_epoch'`,
                  ),
                ),
                eq(executionCommands.kind, "session.prompt"),
                eq(executionCommands.ownerKind, "flow_node_attempt"),
                sql`${executionCommands.ownerRef}->>'variant' = 'node'`,
                sql`${executionCommands.ownerRef}->>'promptOrdinal' = ${nodeAttempts.actionPromptOrdinal}::text`,
                eq(executionCommands.state, "failed"),
                inArray(executionCommands.applicationState, [
                  "applied",
                  "superseded",
                ]),
                sql`COALESCE(${executionCommands.lastError}->'details'->>'reason', ${executionCommands.lastError}->>'reason') = 'turn_lost'`,
                eq(nodeAttempts.status, "Reworked"),
                eq(nodeAttempts.decision, TURN_LOST_DECISION),
                inArray(nodeAttempts.nodeType, ["ai_coding", "judge"]),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(runs.id))
    .limit(1);

  return candidate ?? null;
}

export async function deferHostRestartRecovery(
  db: Db,
  candidate: { runId: string; assignmentId: string },
): Promise<void> {
  await db
    .update(runs)
    .set({
      crashRecoverAttempts: sql`${runs.crashRecoverAttempts} + 1`,
      crashRecoverNextRetryAt: sql`clock_timestamp() + least(power(2, ${runs.crashRecoverAttempts} + 1), 60) * interval '1 second'`,
    })
    .where(
      and(
        eq(runs.id, candidate.runId),
        eq(runs.status, "Crashed"),
        eq(runs.executionAssignmentId, candidate.assignmentId),
        lt(runs.crashRecoverAttempts, CRASH_RECOVER_CONTINUATION_MAX_ATTEMPTS),
        or(
          isNull(runs.crashRecoverNextRetryAt),
          lte(runs.crashRecoverNextRetryAt, sql`clock_timestamp()`),
        ),
      ),
    );
}
