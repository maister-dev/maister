import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { and, desc, eq, sql } from "drizzle-orm";

import { isAutomaticTaskLaunchDrain } from "./launch-capacity";
import {
  assertFrozenTaskAgentCurrent,
  assertFrozenTaskAgentRepository,
  taskAgentPreparationWorkspace,
} from "./launch-agent-execution";
import {
  assertFrozenTaskLaunchCurrent,
  assertFrozenTaskLaunchRepository,
  assertTaskLaunchBoundWorkspace,
} from "./launch-execution";
import { lockTaskLaunchExecutionParent } from "./launch-parent-admission";
import { lockTaskLaunchReservation } from "./launch-locks";
import { launchRefusal } from "./launch-resolution";
import { emitTaskLaunchChanged } from "./launch-events";

import { takeSchedulerLock } from "@/lib/scheduler";
import { retryDigest } from "@/lib/agents/retry-guards";
import { agentPreparationResourceId } from "@/lib/agents/preparation-resource";
import {
  runs,
  taskLaunchIntents,
  executionAssignments,
  tasks,
  agentPreparationOperations,
} from "@/lib/db/schema";

export type PreparedTaskLaunchDispatch = Readonly<{
  intentId: string;
  taskId: string;
  projectId: string;
  basis: "manual" | "automatic" | "execution_child";
  ownsCapacity: boolean;
  automaticDrain: boolean;
  apply: (tx: Db) => Promise<void>;
  releaseCapacity: (tx: Db) => Promise<void>;
}>;

/** Repository probing precedes the short atomic dispatch transaction. */
export async function prepareTaskLaunchFirstDispatch(
  db: Db,
  runId: string,
): Promise<PreparedTaskLaunchDispatch | null> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));

  if (!run?.taskLaunchIntentId) return null;
  const [intent] = await db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, run.taskLaunchIntentId));

  if (
    !intent ||
    intent.originalRunId !== run.id ||
    intent.runId !== run.id ||
    intent.taskId !== run.taskId ||
    intent.projectId !== run.projectId
  )
    throw launchRefusal("launch_worker_fenced");
  if (intent.dispatchCommittedAt) {
    if (!intent.dispatchReceipt)
      throw launchRefusal("launch_input_snapshot_incomplete", "PRECONDITION");

    return null;
  }
  if (intent.state !== "run_bound")
    throw launchRefusal(intent.reason ?? "launch_state_changed");
  if (run.taskAdmissionCheckedAt)
    throw launchRefusal("launch_input_snapshot_incomplete", "PRECONDITION");
  const agent = intent.settingsSnapshot.kind === "agent";
  const validateCurrent = agent
    ? assertFrozenTaskAgentCurrent
    : assertFrozenTaskLaunchCurrent;

  await validateCurrent(db, intent);
  // Agent Running admits infrastructure preparation, whose physical owner
  // verifies repository integrity at commitTaskAgentLaunchFirstDispatch.
  // A scheduler-side probe here would race that owner's materialization.
  if (!agent) {
    await assertFrozenTaskLaunchRepository(db, intent);
    await assertTaskLaunchBoundWorkspace(db, intent);
  }
  const [assignment] = await db
    .select()
    .from(executionAssignments)
    .where(
      and(
        eq(executionAssignments.runId, run.id),
        eq(executionAssignments.state, "active"),
      ),
    )
    .orderBy(desc(executionAssignments.epoch))
    .limit(1);

  if (!assignment)
    throw launchRefusal("launch_assignment_unavailable", "PRECONDITION");
  const lockCurrent = async (
    tx: Db,
  ): Promise<{
    run: typeof runs.$inferSelect;
    assignment: typeof executionAssignments.$inferSelect;
    intent: typeof taskLaunchIntents.$inferSelect;
  }> => {
    await lockTaskLaunchExecutionParent(tx, intent);
    await lockTaskLaunchReservation(tx, intent.taskId);
    const [currentRun] = await tx
      .select()
      .from(runs)
      .where(eq(runs.id, runId))
      .for("update");
    const [currentAssignment] = await tx
      .select()
      .from(executionAssignments)
      .where(eq(executionAssignments.id, assignment.id))
      .for("update");
    const [current] = await tx
      .select()
      .from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.id, intent.id))
      .for("update");

    if (
      !currentRun ||
      currentRun.taskLaunchIntentId !== intent.id ||
      !["Pending", "Running"].includes(currentRun.status) ||
      !currentAssignment ||
      currentRun.executionAssignmentId !== currentAssignment.id ||
      currentAssignment.state !== "active" ||
      currentAssignment.epoch !== assignment.epoch ||
      current?.state !== "run_bound" ||
      current.runId !== runId
    )
      throw launchRefusal("launch_worker_fenced");
    await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.id, current.taskId))
      .for("update");

    return { run: currentRun, assignment: currentAssignment, intent: current };
  };

  return {
    intentId: intent.id,
    taskId: intent.taskId,
    projectId: intent.projectId,
    basis: intent.basis.kind,
    ownsCapacity: intent.preparationIdentity !== null,
    automaticDrain: isAutomaticTaskLaunchDrain(intent),
    releaseCapacity: async (tx) => {
      const current = await lockCurrent(tx);

      if (current.intent.dispatchCommittedAt) return;
      if (current.run.status !== "Pending")
        throw launchRefusal("launch_worker_fenced");
      const modelEffects = await tx.execute(
        sql`SELECT 1 FROM execution_commands WHERE run_id=${runId} AND kind IN ('session.create','session.prompt') LIMIT 1`,
      );

      if (modelEffects.rows.length) throw launchRefusal("launch_worker_fenced");
      await validateCurrent(tx, current.intent);
      const [queued] = await tx
        .update(taskLaunchIntents)
        .set({
          state: "queued",
          stateVersion: current.intent.stateVersion + 1,
          reason: "launch_capacity_wait",
          dueAt: sql`clock_timestamp()+interval '1 second'`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(taskLaunchIntents.id, current.intent.id))
        .returning();

      await emitTaskLaunchChanged(tx, queued, { type: "system", id: null });
    },
    apply: async (tx) => {
      const current = await lockCurrent(tx);

      if (current.intent.dispatchCommittedAt) return;
      await validateCurrent(tx, current.intent);
      // Agent Running admits infrastructure preparation; its owned generation
      // commits first dispatch immediately before create/prompt.
      if (agent) return;
      const time = await tx.execute<{ committedAt: string }>(
        sql`SELECT to_char(date_trunc('milliseconds',clock_timestamp()) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "committedAt"`,
      );
      const committedAt = new Date(time.rows[0].committedAt);
      const [committed] = await tx
        .update(taskLaunchIntents)
        .set({
          dispatchCommittedAt: committedAt,
          dispatchReceipt: {
            version: 1,
            runId,
            assignmentId: current.assignment.id,
            assignmentEpoch: current.assignment.epoch,
            inputDigest: current.intent.inputDigest,
            settingsDigest: current.intent.settingsDigest,
            committedAt: committedAt.toISOString(),
          },
          stateVersion: current.intent.stateVersion + 1,
          updatedAt: committedAt,
        })
        .where(eq(taskLaunchIntents.id, current.intent.id))
        .returning();

      await tx
        .update(runs)
        .set({ taskAdmissionCheckedAt: committedAt })
        .where(eq(runs.id, runId));
      await emitTaskLaunchChanged(tx, committed, { type: "system", id: null });
    },
  };
}

/** Commits the first agent model effect only after the current owned generation is materialized. */
export async function commitTaskAgentLaunchFirstDispatch(
  db: Db,
  input: Readonly<{
    runId: string;
    assignmentId: string;
    preparationId: string;
  }>,
): Promise<void> {
  const [initial] = await db
    .select()
    .from(runs)
    .where(eq(runs.id, input.runId));

  if (!initial?.taskLaunchIntentId || !initial.taskId || !initial.projectId)
    throw launchRefusal("launch_worker_fenced");
  const [accepted] = await db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, initial.taskLaunchIntentId));

  if (
    !accepted ||
    accepted.runId !== initial.id ||
    accepted.settingsSnapshot.kind !== "agent"
  )
    throw launchRefusal("launch_worker_fenced");
  if (!accepted.dispatchCommittedAt) {
    await assertFrozenTaskAgentCurrent(db, accepted);
    await assertFrozenTaskAgentRepository(db, accepted);
  }
  const physicalResourceId = await agentPreparationResourceId(
    await taskAgentPreparationWorkspace(db, initial),
  );

  await db.transaction(async (tx) => {
    await takeSchedulerLock(tx);
    if (!accepted.dispatchCommittedAt)
      await lockTaskLaunchExecutionParent(tx, accepted);
    await lockTaskLaunchReservation(tx, accepted.taskId);
    const [run] = await tx
      .select()
      .from(runs)
      .where(eq(runs.id, input.runId))
      .for("update");
    const [assignment] = await tx
      .select()
      .from(executionAssignments)
      .where(eq(executionAssignments.id, input.assignmentId))
      .for("update");
    const [operation] = await tx
      .select()
      .from(agentPreparationOperations)
      .where(eq(agentPreparationOperations.id, input.preparationId))
      .for("update");
    const [intent] = await tx
      .select()
      .from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.id, accepted.id))
      .for("update");

    if (
      !run ||
      !["Running", "NeedsInput"].includes(run.status) ||
      run.taskLaunchIntentId !== accepted.id ||
      run.executionAssignmentId !== input.assignmentId ||
      !assignment ||
      assignment.runId !== run.id ||
      assignment.state !== "active" ||
      !operation ||
      operation.runId !== run.id ||
      operation.assignmentId !== assignment.id ||
      operation.assignmentEpoch !== assignment.epoch ||
      operation.phase !== "materialized" ||
      !intent ||
      intent.state !== "run_bound" ||
      intent.runId !== run.id ||
      intent.originalRunId !== run.id
    )
      throw launchRefusal("launch_worker_fenced");
    const lease = await tx.execute<{ valid: boolean }>(
      sql`SELECT ${operation.leaseExpiresAt}::timestamptz>clock_timestamp() AS valid`,
    );
    const baseline = run.operationalIntegrityBaseline;

    if (
      intent.preparationIdentity?.version !== 2 ||
      physicalResourceId !== operation.resourceId ||
      (intent.settingsSnapshot.workspace !== "none" &&
        !(
          intent.settingsSnapshot.version === 2 &&
          intent.settingsSnapshot.workspace === "worktree" &&
          intent.settingsSnapshot.serverExecution?.execution.workspaceMode ===
            "shared"
        ) &&
        baseline?.head !== intent.settingsSnapshot.baseCommit)
    )
      throw launchRefusal(
        "launch_agent_preparation_incomplete",
        "PRECONDITION",
      );
    if (
      !lease.rows[0]?.valid ||
      !baseline ||
      baseline.generation !== operation.generation ||
      baseline.resourceKind !==
        (intent.settingsSnapshot.workspace === "none"
          ? "plain_directory"
          : intent.settingsSnapshot.workspace === "repo_read"
            ? intent.settingsSnapshot.version === 2 &&
              intent.settingsSnapshot.agentSnapshot?.workspaceRef
              ? "ephemeral_checkout"
              : "shared_repository"
            : "worktree")
    )
      throw launchRefusal(
        "launch_agent_preparation_incomplete",
        "PRECONDITION",
      );
    if (intent.dispatchCommittedAt) {
      if (!intent.dispatchReceipt)
        throw launchRefusal("launch_input_snapshot_incomplete", "PRECONDITION");

      return;
    }
    await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.id, intent.taskId))
      .for("update");
    await assertFrozenTaskAgentCurrent(tx, intent);
    const priorEffects = await tx.execute(
      sql`SELECT 1 FROM execution_commands WHERE run_id=${run.id} AND kind IN ('session.create','session.prompt') LIMIT 1`,
    );

    if (priorEffects.rows.length)
      throw launchRefusal("launch_dispatch_commit_unknown", "PRECONDITION");
    const time = await tx.execute<{ committedAt: string }>(
      sql`SELECT to_char(date_trunc('milliseconds',clock_timestamp()) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "committedAt"`,
    );
    const committedAt = new Date(time.rows[0].committedAt);
    const [committed] = await tx
      .update(taskLaunchIntents)
      .set({
        dispatchCommittedAt: committedAt,
        dispatchReceipt: {
          version: 1,
          runId: run.id,
          assignmentId: assignment.id,
          assignmentEpoch: assignment.epoch,
          inputDigest: intent.inputDigest,
          settingsDigest: intent.settingsDigest,
          committedAt: committedAt.toISOString(),
          preparation: {
            id: operation.id,
            resourceId: operation.resourceId,
            incarnation: operation.incarnation,
            generation: baseline.generation,
            baselineDigest: retryDigest(baseline),
            materializationDigest: retryDigest(baseline.platform),
          },
        },
        stateVersion: intent.stateVersion + 1,
        updatedAt: committedAt,
      })
      .where(eq(taskLaunchIntents.id, intent.id))
      .returning();

    await tx
      .update(runs)
      .set({ taskAdmissionCheckedAt: committedAt })
      .where(eq(runs.id, run.id));
    await emitTaskLaunchChanged(tx, committed, { type: "system", id: null });
  });
}
