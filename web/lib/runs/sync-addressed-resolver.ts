import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type {
  ExecutionCommand,
  Run,
  RunSyncAttemptRow,
  Workspace,
} from "@/lib/db/schema";
import type { ExecutionHosts } from "@/lib/execution-host";
import type { SyncRunInput, SyncRunOutcome } from "./sync-target";

import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import pino from "pino";

import { loadRunnerCatalog } from "@/lib/acp-runners/catalog";
import { resolveSyncRunner } from "@/lib/acp-runners/resolve";
import {
  runnerExecutorInput,
  runnerSupervisorInput,
} from "@/lib/acp-runners/spawn-intent";
import {
  stopCurrentAgentExecution,
  waitForAgentExecutionQuiescence,
} from "@/lib/agents/execution-quiescence";
import {
  executionCommands,
  executionHosts,
  platformRuntimeSettings,
  projects,
  runSessions,
  runs,
  runSyncAttempts,
  tasks,
  workspaces,
} from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { createExecutionHosts, mintPlacement } from "@/lib/execution-host";
import { getAssignmentById } from "@/lib/execution-host/assignments";
import { insertCommand } from "@/lib/execution-host/commands";
import { reserveRunHostCapacity } from "@/lib/execution-host/host-capacity";
import { SessionCreatePending } from "@/lib/execution-host/owned-session-create";
import {
  RetainedWorkspaceSyncSchema,
  WorkspaceSyncResultSchema,
} from "@/lib/execution-host/workspace-prepare-schema";
import {
  nextRetainedWorkspaceFence,
  settleRetainedWorkspaceCommand,
} from "@/lib/execution-host/workspace-retained-operation";
import {
  countLiveRuns,
  effectivePoolCap,
  poolForRunKind,
  promoteNextPending,
  takeSchedulerLock,
} from "@/lib/scheduler";
import { assertTaskLaunchUserAuthority } from "@/lib/tasks/launch-authority";

import { readAddressedReviewFingerprint } from "./review-source";
import { RELEASED_LIFECYCLE_CLAIM } from "./lifecycle-claim";
import {
  markSyncFromReview,
  markSyncReviewFromNeedsInput,
  markSyncReviewFromRunning,
} from "./state-transitions";
import {
  hasSyncDriver,
  registerSyncDriver,
  unregisterSyncDriver,
} from "./sync-driver-registry";
import {
  buildResolverPrompt,
  runResolverSession,
  SYNC_STEP_ID,
} from "./sync-resolver";

const log = pino({ name: "sync-addressed-resolver" });

type ResolverContext = {
  run: Run;
  workspace: Workspace;
  attempt: RunSyncAttemptRow;
};

function changed(): MaisterError {
  return new MaisterError(
    "CONFLICT",
    "The retained resolver no longer owns this checkout",
  );
}

async function lockContext(
  db: Db,
  probe: ExecutionCommand,
): Promise<ResolverContext> {
  const payload = RetainedWorkspaceSyncSchema.parse(probe.payload);
  const [run] = await db
    .select()
    .from(runs)
    .where(eq(runs.id, probe.runId))
    .for("no key update");
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.runId, probe.runId))
    .for("no key update");
  const [attempt] = await db
    .select()
    .from(runSyncAttempts)
    .where(eq(runSyncAttempts.id, payload.claimId))
    .for("no key update");
  if (
    !run?.projectId ||
    !workspace ||
    !attempt ||
    !attempt.actorId ||
    attempt.workspaceId !== workspace.id ||
    workspace.ownershipKind !== "host_owned" ||
    workspace.removedAt ||
    workspace.lifecycleOperationName !== "sync" ||
    workspace.lifecycleOperationState !== "claiming" ||
    workspace.lifecycleOperationAttemptId !== attempt.id ||
    workspace.executionHostId !== probe.executionHostId ||
    workspace.executionWorkspaceId !== probe.targetSessionId ||
    workspace.workspaceGeneration !== payload.generation
  )
    throw changed();

  return { run, workspace, attempt };
}

async function reserveResolverStep(
  db: Db,
  source: ExecutionCommand,
  run: Run,
  step:
    | { resolverProbeId: string; onConflict: "prepareResolver" }
    | { resolver: { commandId: string; action: "verify" | "abort" } },
): Promise<ExecutionCommand> {
  const { claimId, generation, strategy, expected, publish } =
    RetainedWorkspaceSyncSchema.parse(source.payload);
  const handle = source.targetSessionId;
  const assignment =
    run.executionAssignmentId &&
    (await getAssignmentById(db, run.executionAssignmentId));
  if (
    !handle ||
    !assignment ||
    assignment.state !== "released" ||
    assignment.executionHostId !== source.executionHostId ||
    assignment.executionWorkspaceId !== handle
  )
    throw changed();

  return insertCommand(db, {
    runId: run.id,
    hostId: source.executionHostId,
    targetSessionId: handle,
    assignmentId: assignment.id,
    assignmentEpoch: assignment.epoch,
    kind: "workspace.sync",
    driverless: true,
    maxAttempts: 3,
    payload: {
      claimId,
      generation,
      strategy,
      expected,
      ...step,
      fence: await nextRetainedWorkspaceFence(
        db,
        source.executionHostId,
        handle,
      ),
      ...(publish ? { publish } : {}),
    },
  });
}

async function findResolverSteps(
  db: Db,
  probe: ExecutionCommand,
): Promise<ExecutionCommand[]> {
  const { claimId } = RetainedWorkspaceSyncSchema.parse(probe.payload);
  return db
    .select()
    .from(executionCommands)
    .where(
      and(
        eq(executionCommands.kind, "workspace.sync"),
        eq(executionCommands.runId, probe.runId),
        sql`${executionCommands.payload}->>'claimId' = ${claimId}`,
        sql`${executionCommands.id} <> ${probe.id}`,
      ),
    );
}

async function reservePreparation(
  db: Db,
  probe: ExecutionCommand,
): Promise<ExecutionCommand> {
  return db.transaction(async (tx) => {
    const { run, attempt } = await lockContext(tx, probe);
    const existing = (await findResolverSteps(tx, probe)).find(
      (step) => step.payload.resolverProbeId === probe.id,
    );
    if (existing) return existing;
    if (
      run.status !== "Review" ||
      attempt.phase !== "starting" ||
      !run.projectId ||
      !attempt.actorId
    )
      throw changed();
    await assertTaskLaunchUserAuthority(tx, run.projectId, attempt.actorId, [
      "promoteRun",
    ]);
    const [owner] = await tx
      .select({ capabilities: executionHosts.capabilities })
      .from(executionHosts)
      .where(eq(executionHosts.id, probe.executionHostId));
    if (owner?.capabilities.workspaceSyncResolver !== 1)
      throw new MaisterError(
        "PRECONDITION",
        "The owning supervisor must support retained conflict resolution",
        { details: { reason: "workspace_protocol_unsupported" } },
      );
    return reserveResolverStep(tx, probe, run, {
      resolverProbeId: probe.id,
      onConflict: "prepareResolver",
    });
  });
}

async function admitResolver(db: Db, probe: ExecutionCommand): Promise<void> {
  const payload = RetainedWorkspaceSyncSchema.parse(probe.payload);
  await db.transaction(async (tx) => {
    await takeSchedulerLock(tx);
    const { run, workspace, attempt } = await lockContext(tx, probe);
    if (attempt.mode === "agent") return;
    if (
      !run.projectId ||
      !attempt.actorId ||
      attempt.phase !== "starting" ||
      run.status !== "Review" ||
      !payload.resolverIntent
    )
      throw changed();
    await assertTaskLaunchUserAuthority(tx, run.projectId, attempt.actorId, [
      "promoteRun",
    ]);
    const pool = poolForRunKind(run.runKind);
    if (
      (await countLiveRuns(tx, pool)) >= (await effectivePoolCap(tx, pool)).cap
    )
      throw new MaisterError(
        "CONFLICT",
        "The sync resolver's pool is at capacity",
      );

    const [project] = await tx
      .select({
        syncRunnerId: projects.syncRunnerId,
        defaultRunnerId: projects.defaultRunnerId,
      })
      .from(projects)
      .where(eq(projects.id, run.projectId));
    const [platform] = await tx
      .select({
        defaultRunnerId: platformRuntimeSettings.defaultRunnerId,
      })
      .from(platformRuntimeSettings)
      .where(eq(platformRuntimeSettings.id, "singleton"));
    if (!project) throw changed();
    const runner = resolveSyncRunner({
      launchOverrideRunnerId: payload.resolverIntent.runnerId,
      project,
      platform: platform ?? { defaultRunnerId: null },
      runners: await loadRunnerCatalog(tx),
    });
    if (!(await markSyncFromReview(run.id, { db: tx })).ok) throw changed();
    await mintPlacement(tx, { runId: run.id, reason: "sync_resolver" });
    const reason = await reserveRunHostCapacity(tx, run.id);
    if (reason)
      throw new MaisterError(
        "CONFLICT",
        "The owning supervisor cannot admit the resolver",
        { details: { reason } },
      );
    const sessionName = `sync-${attempt.attempt}`;
    await tx.insert(runSessions).values({
      id: randomUUID(),
      runId: run.id,
      sessionName,
      runnerId: runner.runnerId,
      capabilityAgent: runnerExecutorInput(runner.runnerSnapshot).agent,
      runnerResolutionTier: runner.runnerResolutionTier,
      resolutionSource: runner.runnerResolutionTier,
      runnerSnapshot: runner.runnerSnapshot,
    });
    await tx
      .update(workspaces)
      .set({ lifecycleOperationExpectedRunStatus: "Running" })
      .where(eq(workspaces.id, workspace.id));
    await tx
      .update(runSyncAttempts)
      .set({
        mode: "agent",
        phase: "agent_running",
        runnerId: runner.runnerId,
        sessionName,
        agentRunningSince: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(runSyncAttempts.id, attempt.id));
  });
}

async function persistResolverAbort(
  db: Db,
  probe: ExecutionCommand,
  reason: MaisterError,
): Promise<void> {
  await db.transaction(async (tx) => {
    const { attempt } = await lockContext(tx, probe);
    if (attempt.phase !== "agent_running" && attempt.phase !== "verifying")
      throw changed();
    const verifying = (await findResolverSteps(tx, probe)).find(
      (step) =>
        RetainedWorkspaceSyncSchema.parse(step.payload).resolver?.action ===
        "verify",
    );
    if (
      verifying &&
      (verifying.state !== "failed" || !verifying.lastError?.eventId)
    )
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        "The original verification may already have published",
        { details: { reason: "effect_unconfirmed", commandId: verifying.id } },
      );
    await tx
      .update(runSyncAttempts)
      .set({
        phase: "verifying",
        errorCode: reason.code,
        errorMessage: reason.message,
        updatedAt: new Date(),
      })
      .where(eq(runSyncAttempts.id, attempt.id));
  });
}

async function discardUnpreparedResolver(
  db: Db,
  probe: ExecutionCommand,
  refusal: MaisterError,
): Promise<void> {
  await db.transaction(async (tx) => {
    const { workspace, attempt } = await lockContext(tx, probe);
    if (
      attempt.phase !== "starting" ||
      (await findResolverSteps(tx, probe)).length
    )
      throw changed();
    await tx
      .update(runSyncAttempts)
      .set({
        phase: "aborted",
        errorCode: refusal.code,
        errorMessage: refusal.message,
        updatedAt: new Date(),
      })
      .where(eq(runSyncAttempts.id, attempt.id));
    await tx
      .update(workspaces)
      .set(RELEASED_LIFECYCLE_CLAIM)
      .where(eq(workspaces.id, workspace.id));
  });
}

async function reserveSettlement(
  db: Db,
  probe: ExecutionCommand,
  prepared: ExecutionCommand,
  action: "verify" | "abort",
): Promise<ExecutionCommand> {
  return db.transaction(async (tx) => {
    const { run, workspace, attempt } = await lockContext(tx, probe);
    const existing = (await findResolverSteps(tx, probe)).find(
      (step) =>
        RetainedWorkspaceSyncSchema.parse(step.payload).resolver?.action ===
        action,
    );
    if (existing) return existing;
    if (action === "verify") {
      if (
        attempt.phase !== "verifying" ||
        attempt.errorCode ||
        !run.projectId ||
        !attempt.actorId
      )
        throw changed();
      await assertTaskLaunchUserAuthority(tx, run.projectId, attempt.actorId, [
        "promoteRun",
      ]);
    }
    if (run.status === "Running") {
      if (!(await markSyncReviewFromRunning(run.id, { db: tx })).ok)
        throw changed();
    } else if (run.status === "NeedsInput" || run.status === "NeedsInputIdle") {
      if (
        !(await markSyncReviewFromNeedsInput(run.id, run.status, { db: tx })).ok
      )
        throw changed();
    } else if (run.status !== "Review") throw changed();

    await tx
      .update(workspaces)
      .set({ lifecycleOperationExpectedRunStatus: "Review" })
      .where(eq(workspaces.id, workspace.id));
    if (attempt.phase === "agent_running")
      await tx
        .update(runSyncAttempts)
        .set({ phase: "verifying", updatedAt: new Date() })
        .where(eq(runSyncAttempts.id, attempt.id));
    return reserveResolverStep(tx, prepared, run, {
      resolver: { commandId: prepared.id, action },
    });
  });
}

async function resolverContext(
  db: Db,
  probe: ExecutionCommand,
): Promise<ResolverContext> {
  return db.transaction((tx) => lockContext(tx, probe));
}

async function finalizeApprovedResolution(
  db: Db,
  context: ResolverContext,
  command: ExecutionCommand,
): Promise<void> {
  const { run, workspace, attempt } = context;
  const result = WorkspaceSyncResultSchema.strip().parse(command.result);
  const { expected } = RetainedWorkspaceSyncSchema.parse(command.payload);
  if (
    !attempt.autoFinalize ||
    !attempt.actorId ||
    result.resolverSettlement !== "verified" ||
    !expected.priorTarget
  )
    return;
  const actorId = attempt.actorId;

  // The existing promotion boundary rechecks both pins and current authority.
  try {
    const { fingerprint } = await readAddressedReviewFingerprint(db, workspace);
    const { promoteRun } = await import("./promote");
    await promoteRun(
      run.id,
      {
        deliveryPolicyOverride: {
          strategy: "rebase_merge",
          push: "on_success",
        },
        reviewedSource: { head: result.head, fingerprint },
        targetBranch: expected.targetRef.slice("refs/heads/".length),
        reviewedTargetCommit: expected.priorTarget,
      },
      {
        sessionUser: { id: actorId },
        authorize: (projectId) =>
          assertTaskLaunchUserAuthority(db, projectId, actorId, ["promoteRun"]),
      },
      db,
    );
  } catch (error) {
    log.warn(
      {
        runId: run.id,
        attemptId: attempt.id,
        reason: isMaisterError(error) ? error.code : "auto_finalize_failed",
      },
      "verified resolution needs promotion follow-up",
    );
  }
}

async function driveResolver(
  db: Db,
  probe: ExecutionCommand,
  prepared: ExecutionCommand,
  hosts: ExecutionHosts,
): Promise<void> {
  const { run, attempt } = await resolverContext(db, probe);
  if (!run.executionAssignmentId || !attempt.sessionName) throw changed();
  const identity = {
    id: run.id,
    executionAssignmentId: run.executionAssignmentId,
  };
  if (attempt.phase === "agent_running" && run.status === "Review") {
    await persistResolverAbort(
      db,
      probe,
      new MaisterError("CRASH", "The resolver was stopped"),
    );
  } else if (attempt.phase === "agent_running") {
    const [session] = await db
      .select()
      .from(runSessions)
      .where(
        and(
          eq(runSessions.runId, run.id),
          eq(runSessions.sessionName, attempt.sessionName),
        ),
      );
    if (!session?.runnerSnapshot || !session.runnerResolutionTier)
      throw changed();
    const [task] = run.taskId
      ? await db
          .select({ title: tasks.title, prompt: tasks.prompt })
          .from(tasks)
          .where(eq(tasks.id, run.taskId))
      : [];
    const snapshot = session.runnerSnapshot;

    try {
      const response = await runResolverSession({
        db,
        runId: run.id,
        executionHosts: hosts,
        assignmentId: run.executionAssignmentId,
        input: {
          stepId: SYNC_STEP_ID,
          sessionName: attempt.sessionName,
          executor: runnerExecutorInput(snapshot),
          runner: runnerSupervisorInput({ snapshot }),
        },
        owner: {
          syncAttemptId: attempt.id,
          operationAttemptId: attempt.id,
          promptOrdinal: 0,
        },
        runnerTier: session.runnerResolutionTier,
        prompt: buildResolverPrompt({
          targetRef: attempt.targetRef ?? "",
          strategy: attempt.strategy,
          conflictedFiles: attempt.conflictedFiles ?? [],
          task: task ?? null,
        }),
      });
      if (response.stopReason !== "end_turn")
        await persistResolverAbort(
          db,
          probe,
          new MaisterError("CRASH", "The resolver did not complete its turn"),
        );
    } catch (error) {
      const [failed] = await db
        .select({ id: executionCommands.id })
        .from(executionCommands)
        .where(
          and(
            eq(
              executionCommands.executionAssignmentId,
              run.executionAssignmentId,
            ),
            inArray(executionCommands.kind, [
              "session.create",
              "session.prompt",
            ]),
            eq(executionCommands.state, "failed"),
            sql`${executionCommands.lastError} ? 'eventId'`,
          ),
        )
        .limit(1);
      if (!failed) throw error;
      await persistResolverAbort(
        db,
        probe,
        new MaisterError(
          "CRASH",
          "The supervisor refused or ended the resolver",
        ),
      );
    }
  } else if (attempt.phase !== "verifying") {
    throw changed();
  }
  const assignment = await getAssignmentById(db, run.executionAssignmentId);
  if (!assignment) throw changed();
  if (assignment.state === "active")
    await stopCurrentAgentExecution(db, identity, hosts);
  await waitForAgentExecutionQuiescence(
    db,
    identity,
    AbortSignal.timeout(30_000),
    hosts,
  );
  const latest = await resolverContext(db, probe);
  let command: ExecutionCommand;
  if (latest.attempt.errorCode) {
    command = await reserveSettlement(db, probe, prepared, "abort");
  } else {
    try {
      command = await reserveSettlement(db, probe, prepared, "verify");
    } catch (error) {
      if (
        !isMaisterError(error) ||
        (error.code !== "UNAUTHORIZED" && error.code !== "ACCOUNT_INACTIVE")
      )
        throw error;
      await persistResolverAbort(db, probe, error);
      command = await reserveSettlement(db, probe, prepared, "abort");
    }
  }
  const settlement = await settleRetainedWorkspaceCommand(db, command);
  if (settlement.state === "succeeded") {
    await finalizeApprovedResolution(db, latest, settlement);
  } else if (
    RetainedWorkspaceSyncSchema.parse(command.payload).resolver?.action ===
    "verify"
  ) {
    await persistResolverAbort(
      db,
      probe,
      new MaisterError(
        "CONFLICT",
        "The owning supervisor refused the resolver result",
      ),
    );
    await settleRetainedWorkspaceCommand(
      db,
      await reserveSettlement(db, probe, prepared, "abort"),
    );
  }
  await promoteNextPending({ db, pool: poolForRunKind(run.runKind) });
}

export async function startAddressedSyncResolver(
  db: Db,
  probe: ExecutionCommand,
  operation: Pick<SyncRunInput, "executionHosts" | "schedule">,
): Promise<SyncRunOutcome | null> {
  const parsed = WorkspaceSyncResultSchema.strip().parse(probe.result);
  if (!parsed.conflictedFiles || !probe.payload.resolverIntent) return null;
  let prepare: ExecutionCommand;
  try {
    prepare = await reservePreparation(db, probe);
  } catch (error) {
    if (
      !isMaisterError(error) ||
      (error.code !== "UNAUTHORIZED" &&
        error.code !== "ACCOUNT_INACTIVE" &&
        error.details?.reason !== "workspace_protocol_unsupported")
    )
      throw error;
    await discardUnpreparedResolver(db, probe, error);
    throw error;
  }
  const prepared = await settleRetainedWorkspaceCommand(db, prepare);
  if (prepared.state !== "succeeded" || !prepared.result?.resolverPrepared)
    throw new MaisterError(
      "CONFLICT",
      "The owning supervisor could not prepare the exact sync conflict",
    );
  const prior = (await findResolverSteps(db, probe)).find(
    (step) =>
      RetainedWorkspaceSyncSchema.parse(step.payload).resolver?.action ===
      "abort",
  );
  if (prior) {
    await settleRetainedWorkspaceCommand(db, prior);
    throw new MaisterError("CONFLICT", "The retained resolver was aborted");
  }
  try {
    await admitResolver(db, probe);
  } catch (error) {
    if (!isMaisterError(error)) throw error;
    await settleRetainedWorkspaceCommand(
      db,
      await reserveSettlement(db, probe, prepared, "abort"),
    );
    throw error;
  }
  const hosts = operation.executionHosts ?? createExecutionHosts({ db });
  if (!hasSyncDriver(probe.runId)) {
    const task = async (): Promise<void> => {
      if (hasSyncDriver(probe.runId)) return;
      registerSyncDriver(probe.runId);
      try {
        await driveResolver(db, probe, prepared, hosts);
      } catch (error) {
        log.warn(
          {
            runId: probe.runId,
            prepareId: prepared.id,
            reason:
              error instanceof SessionCreatePending
                ? "session_create_pending"
                : isMaisterError(error)
                  ? error.code
                  : "resolver_driver_failed",
          },
          "retained sync resolver awaits recovery",
        );
      } finally {
        unregisterSyncDriver(probe.runId);
      }
    };
    const schedule =
      operation.schedule ?? ((drive) => queueMicrotask(() => void drive()));
    schedule(task);
  }
  return {
    attemptId: RetainedWorkspaceSyncSchema.parse(probe.payload).claimId,
    outcome: "agent_launched",
    behind: parsed.behind,
    pushed: false,
    conflictedFiles: [...parsed.conflictedFiles],
  };
}

function addressedResolverProbes(db: Db) {
  return db
    .select({
      probe: executionCommands,
      runStatus: runs.status,
      phase: runSyncAttempts.phase,
      runningSince: runSyncAttempts.agentRunningSince,
    })
    .from(executionCommands)
    .innerJoin(runs, eq(runs.id, executionCommands.runId))
    .innerJoin(
      runSyncAttempts,
      and(
        eq(runSyncAttempts.runId, executionCommands.runId),
        sql`${runSyncAttempts.id}=${executionCommands.payload}->>'claimId'`,
      ),
    )
    .innerJoin(
      workspaces,
      and(
        eq(workspaces.runId, executionCommands.runId),
        eq(workspaces.executionHostId, executionCommands.executionHostId),
        eq(workspaces.executionWorkspaceId, executionCommands.targetSessionId),
        eq(workspaces.lifecycleOperationState, "claiming"),
        eq(workspaces.lifecycleOperationName, "sync"),
        sql`${workspaces.lifecycleOperationAttemptId}=${executionCommands.payload}->>'claimId'`,
      ),
    );
}

/** Only the current claim's immutable probe is eligible for addressable replay. */
export async function recoverAddressedSyncResolvers(
  db: Db,
  hosts: ExecutionHosts,
  runId?: string,
  runningCutoff?: Date,
): Promise<number> {
  const candidates = await addressedResolverProbes(db)
    .where(
      and(
        eq(executionCommands.kind, "workspace.sync"),
        eq(executionCommands.state, "succeeded"),
        sql`${executionCommands.payload} ? 'resolverIntent'`,
        sql`${executionCommands.result} ? 'conflictedFiles'`,
        runId ? eq(executionCommands.runId, runId) : undefined,
      ),
    )
    .orderBy(asc(executionCommands.createdAt))
    .limit(32);
  for (const { probe, runStatus, phase, runningSince } of candidates) {
    try {
      if (
        runningCutoff &&
        runStatus === "Running" &&
        phase === "agent_running" &&
        runningSince &&
        runningSince < runningCutoff
      ) {
        const prepared = (await findResolverSteps(db, probe)).find(
          (step) => step.state === "succeeded" && step.result?.resolverPrepared,
        );
        if (!prepared) throw changed();
        await persistResolverAbort(
          db,
          probe,
          new MaisterError(
            "CRASH",
            "The sync resolver exceeded its active-time limit",
          ),
        );
        await driveResolver(db, probe, prepared, hosts);
      } else if (!hasSyncDriver(probe.runId)) {
        await startAddressedSyncResolver(db, probe, { executionHosts: hosts });
      }
    } catch (error) {
      log.warn(
        {
          runId: probe.runId,
          probeId: probe.id,
          reason: isMaisterError(error)
            ? error.code
            : "resolver_recovery_error",
        },
        "could not resume retained sync resolver",
      );
    }
  }
  return candidates.length;
}
