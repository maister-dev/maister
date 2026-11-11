import type { TaskLaunchReceipt } from "@/lib/tasks/launch-types";
import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

import {
  flows,
  flowRevisions,
  tasks,
  taskLaunchIntents,
  runs,
  workspaces,
  runSessions,
  domainEvents,
} from "@/lib/db/schema";
import { interactiveTaskLaunchPrincipal } from "@/lib/tasks/admission-types";
import {
  acceptInteractiveTaskLaunch,
  acceptConcurrentInteractiveTaskLaunch,
  taskLaunchSettingsToken,
} from "@/lib/tasks/launch-intent";
import {
  claimTaskLaunchIntent,
  renewTaskLaunchClaim,
  advanceTaskLaunchPreparation,
} from "@/lib/tasks/launch-dispatch-claim";
import { acquireRepositoryMutationFence } from "@/lib/project-config-persistence/repository-lock";
import { startDurableWorkers, stopDurableWorkers } from "@/lib/workers/runtime";
import { cancelInteractiveTaskLaunch } from "@/lib/tasks/launch-cancel";
import {
  countLiveRuns,
  tryStartRun,
  promoteNextPending,
  takeSchedulerLock,
} from "@/lib/scheduler";
import {
  dispatchTaskLaunchIntent,
  dispatchBoundTaskLaunchIntent,
  prepareTaskLaunchIntent,
} from "@/lib/tasks/launch-dispatch";
import { enqueueQualifiedAutomaticTaskLaunch } from "@/lib/tasks/launch-automatic-enqueue";
import { establishExecutionChildAdmission } from "@/lib/tasks/qualification-admission";
import {
  currentInstanceCeilings,
  writeDelegationBoundsIfChanged,
} from "@/lib/orchestrator/bounds-store";
import { buildAutoLaunchRunPlanConsumer } from "@/lib/domain-events/auto-launch";
import { addTaskRelation } from "@/lib/social/relations";
import { prepareTaskQualification } from "@/lib/tasks/qualification";
import { qualificationFixture } from "@/test-support/task-qualification";
import { countLiveAutoFlowRuns } from "@/lib/scheduler/c2-eligibility";
import { acceptedTaskLaunchExecution } from "@/lib/tasks/launch-execution";
import {
  launchRun,
  launchRunStaged,
  launchAcceptedTaskRun,
} from "@/lib/services/runs";
import { taskLaunchReceipt } from "@/lib/tasks/launch-receipt";
import {
  seedAgentDefinition,
  seedProjectRepo,
} from "@/test-support/durable-workers-seed";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import { taskLaunchInputForRun } from "@/lib/tasks/launch-execution-input";
import { abandonRunInTransaction } from "@/lib/runs/state-transitions";
import {
  seedTaskLaunchFixture,
  type TaskLaunchFixture,
} from "@/test-support/task-launch-admission";
import {
  cleanupTestWorktrees,
  mkdtempReal,
} from "@/test-support/worktree-test-root";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let root: string;
let fixture: TaskLaunchFixture;
let sequence = 0;

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));
vi.mock("@/lib/supervisor-client", async (original) => ({
  ...(await original<typeof import("@/lib/supervisor-client")>()),
  checkSupervisorHealth: async () => ({ kind: "available" as const }),
  listSessions: async () => [],
}));

vi.mock("@/lib/authz", async (original) => ({
  ...(await original<typeof import("@/lib/authz")>()),
  requireActiveSession: async () => ({ id: fixture.userId }),
}));

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "task_launch_selection",
  });
  root = await mkdtempReal("task-launch-selection-");
  fixture = await seedTaskLaunchFixture(database, root);
  await fakeExecutionHosts(database.db);
}, 180_000);

afterAll(async () => {
  await database?.stop();
  if (process.env.MAISTER_WORKTREES_ROOT)
    await cleanupTestWorktrees(process.env.MAISTER_WORKTREES_ROOT);
  if (root) await rm(root, { recursive: true, force: true });
});

afterEach(async () => {
  if (!database) return;
  const active = await database.db.select().from(taskLaunchIntents);

  for (const intent of active) {
    if (
      ["queued", "preparing", "held", "run_bound"].includes(intent.state) &&
      !intent.dispatchCommittedAt
    )
      await cancelInteractiveTaskLaunch(
        database.db,
        await interactiveTaskLaunchPrincipal(),
        intent.id,
        { expectedStateVersion: intent.stateVersion },
        randomUUID(),
      );
  }
});

async function task(): Promise<typeof tasks.$inferSelect> {
  const [row] = await database.db
    .insert(tasks)
    .values({
      id: randomUUID(),
      projectId: fixture.projectId,
      number: ++sequence,
      title: "Displayed launch",
      prompt: "Execute the displayed request",
      flowId: fixture.flowId,
      runnerId: fixture.runnerId,
    })
    .returning();

  return row;
}

async function waitForLaunchDue(intentId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const result = await database.pool.query<{ due: boolean }>(
          "SELECT due_at<=clock_timestamp() due FROM task_launch_intents WHERE id=$1",
          [intentId],
        );

        return result.rows[0].due;
      },
      { timeout: 10_000 },
    )
    .toBe(true);
}

async function launchTransitionCount(intentId: string): Promise<number> {
  const result = await database.pool.query<{ n: number }>(
    "SELECT count(*)::int n FROM domain_events WHERE kind='task.launch_changed' AND payload->>'intentId'=$1",
    [intentId],
  );

  return result.rows[0].n;
}

async function abandonWorkerRuns(intentIds: readonly string[]): Promise<void> {
  const bound = await database.db
    .select()
    .from(runs)
    .where(inArray(runs.taskLaunchIntentId, [...intentIds]));

  for (const run of bound) {
    const [intent] = await database.db
      .select()
      .from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.id, run.taskLaunchIntentId!));

    if (run.runKind === "flow" && intent.dispatchCommittedAt)
      await expect
        .poll(
          async () => {
            const [current] = await database.db
              .select()
              .from(runs)
              .where(eq(runs.id, run.id));

            return (
              ["Done", "Failed", "Crashed", "Abandoned"].includes(
                current.status,
              ) ||
              (current.status === "NeedsInput" &&
                current.flowDriverToken === null)
            );
          },
          { timeout: 10_000 },
        )
        .toBe(true);
    await database.db.transaction((tx) => abandonRunInTransaction(tx, run.id));
  }
}

it("R18 production workers bind rapid accepted requests after real repository contention without an HTTP wake or scheduler tick", async () => {
  vi.stubEnv("MAISTER_WORKTREES_ROOT", `${root}/worktrees`);
  vi.stubEnv("MAISTER_RUNTIME_ROOT", `${root}/runtime`);
  const flowId = await reviewFlow();
  const principal = await interactiveTaskLaunchPrincipal();
  const firstTask = await task();
  const first = await acceptInteractiveTaskLaunch(
    database.db,
    principal,
    {
      taskId: firstTask.id,
      expectedTaskRevision: firstTask.revision,
      expectedSettingsToken: await taskLaunchSettingsToken(
        database.db,
        firstTask.id,
        { flowId },
      ),
      flowId,
    },
    randomUUID(),
  );
  const fence = await acquireRepositoryMutationFence(fixture.repo);

  try {
    const deferred = await dispatchTaskLaunchIntent(
      database.db,
      first.intentId,
    );

    expect(deferred).toMatchObject({
      state: "queued",
      reason: "operation_busy",
      runId: null,
    });
  } finally {
    await fence.release();
  }
  const secondTask = await task();
  const second = await acceptInteractiveTaskLaunch(
    database.db,
    principal,
    {
      taskId: secondTask.id,
      expectedTaskRevision: secondTask.revision,
      expectedSettingsToken: await taskLaunchSettingsToken(
        database.db,
        secondTask.id,
        { flowId },
      ),
      flowId,
    },
    randomUUID(),
  );
  const workers = startDurableWorkers();

  try {
    await expect
      .poll(
        async () => {
          const rows = await database.db.select().from(taskLaunchIntents);

          return [first, second].map(({ intentId }) => {
            const row = rows.find((candidate) => candidate.id === intentId);

            return row?.dispatchCommittedAt ? row.state : null;
          });
        },
        { timeout: 30_000 },
      )
      .toEqual(["run_bound", "run_bound"]);
    expect("taskLaunch" in workers).toBe(true);
    const bound = await database.db.select().from(runs);

    for (const receipt of [first, second]) {
      const children = bound.filter(
        (run) => run.taskLaunchIntentId === receipt.intentId,
      );

      expect(children).toHaveLength(1);
      expect(children[0].taskAdmissionSnapshot).toMatchObject({
        version: 2,
        basis: "manual",
        intentId: receipt.intentId,
      });
    }
  } finally {
    await stopDurableWorkers();
    await abandonWorkerRuns([first.intentId, second.intentId]);
    vi.unstubAllEnvs();
  }
});

it("R18 restarted production workers reclaim an expired preparation and dispatch a retained bound Run without changing either identity", async () => {
  vi.stubEnv("MAISTER_WORKTREES_ROOT", `${root}/worktrees`);
  vi.stubEnv("MAISTER_RUNTIME_ROOT", `${root}/runtime`);
  const principal = await interactiveTaskLaunchPrincipal();
  const flowId = await reviewFlow();
  const accepted: TaskLaunchReceipt[] = [];

  for (const row of [await task(), await task()])
    accepted.push(
      await acceptInteractiveTaskLaunch(
        database.db,
        principal,
        {
          taskId: row.id,
          expectedTaskRevision: row.revision,
          flowId,
          expectedSettingsToken: await taskLaunchSettingsToken(
            database.db,
            row.id,
            { flowId },
          ),
        },
        randomUUID(),
      ),
    );
  const expired = await claimTaskLaunchIntent(
    database.db,
    accepted[0].intentId,
  );
  const boundClaim = await claimTaskLaunchIntent(
    database.db,
    accepted[1].intentId,
  );

  expect(expired).not.toBeNull();
  expect(boundClaim).not.toBeNull();
  await database.db
    .update(taskLaunchIntents)
    .set({ leaseExpiresAt: sql`clock_timestamp()+interval '20 milliseconds'` })
    .where(eq(taskLaunchIntents.id, accepted[0].intentId));
  const fence = await acquireRepositoryMutationFence(fixture.repo);

  try {
    await fence.run(async () =>
      launchAcceptedTaskRun(
        await acceptedTaskLaunchExecution(database.db, boundClaim!),
        database.db,
      ),
    );
  } finally {
    await fence.release();
  }
  const before = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(
      inArray(
        taskLaunchIntents.id,
        accepted.map((row) => row.intentId),
      ),
    );
  const expiredDeadline = await database.pool.query<{ expired: boolean }>(
    "SELECT lease_expires_at<=clock_timestamp() expired FROM task_launch_intents WHERE id=$1",
    [accepted[0].intentId],
  );

  expect(expiredDeadline.rows[0].expired).toBe(true);
  expect(before.find((row) => row.id === accepted[1].intentId)).toMatchObject({
    state: "run_bound",
    dispatchCommittedAt: null,
    runId: boundClaim!.identity.runId,
  });
  let releaseLock: () => void = () => {};
  let reportLocked: () => void = () => {};
  const lockReady = new Promise<void>((resolve) => {
    reportLocked = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const schedulerLock = database.db.transaction(async (tx) => {
    await takeSchedulerLock(tx);
    reportLocked();
    await released;
  });

  await lockReady;
  const firstHandles = startDurableWorkers();
  let stopSettled = false;
  let stopping: Promise<void> | undefined;

  try {
    await expect
      .poll(
        async () => {
          const result = await database.pool.query<{ n: number }>(
            "SELECT count(*)::int n FROM pg_stat_activity WHERE wait_event_type='Lock' AND wait_event='advisory' AND query LIKE '%pg_advisory_xact_lock%'",
          );

          return result.rows[0].n;
        },
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);
    stopping = stopDurableWorkers().then(() => {
      stopSettled = true;
    });
    await database.pool.query("SELECT 1");
    expect(stopSettled).toBe(false);
  } finally {
    releaseLock();
    await schedulerLock;
    await (stopping ?? stopDurableWorkers());
  }
  expect(firstHandles.taskLaunch.health().state).toBe("stopped");
  const restarted = startDurableWorkers();

  try {
    expect(restarted.taskLaunch).not.toBe(firstHandles.taskLaunch);
    await expect
      .poll(
        async () => {
          const rows = await database.db
            .select()
            .from(taskLaunchIntents)
            .where(
              inArray(
                taskLaunchIntents.id,
                accepted.map((row) => row.intentId),
              ),
            );

          return rows.filter((row) => row.dispatchCommittedAt !== null).length;
        },
        { timeout: 10_000 },
      )
      .toBe(2);
    const after = await database.db
      .select()
      .from(taskLaunchIntents)
      .where(
        inArray(
          taskLaunchIntents.id,
          accepted.map((row) => row.intentId),
        ),
      );

    expect(
      after.find((row) => row.id === accepted[0].intentId)?.preparationIdentity,
    ).toEqual(expired!.identity);
    expect(
      after.find((row) => row.id === accepted[1].intentId)?.preparationIdentity,
    ).toEqual(boundClaim!.identity);
    await expect(
      renewTaskLaunchClaim(database.db, expired!),
    ).rejects.toMatchObject({ details: { reason: "launch_worker_fenced" } });
    for (const row of accepted)
      expect(
        await database.db
          .select()
          .from(runs)
          .where(eq(runs.taskLaunchIntentId, row.intentId)),
      ).toHaveLength(1);
  } finally {
    await stopDurableWorkers();
    await abandonWorkerRuns(accepted.map((row) => row.intentId));
    vi.unstubAllEnvs();
  }
});

it("R18 services later eligible Flow and Agent requests while an older repository stays fenced", async () => {
  vi.stubEnv("MAISTER_WORKTREES_ROOT", `${root}/worktrees`);
  vi.stubEnv("MAISTER_RUNTIME_ROOT", `${root}/runtime`);
  const principal = await interactiveTaskLaunchPrincipal();
  const agent = await seedAgentDefinition(database.db, {
    projectId: fixture.projectId,
    installedPath: `${root}/worker-agent`,
    terminalDelayMs: 0,
  });
  const peerAgent = await seedAgentDefinition(database.db, {
    projectId: fixture.projectId,
    installedPath: `${root}/worker-peer-agent`,
    terminalDelayMs: 0,
  });
  const busyTask = await task();
  const blocked = await acceptInteractiveTaskLaunch(
    database.db,
    principal,
    {
      taskId: busyTask.id,
      expectedTaskRevision: busyTask.revision,
      expectedSettingsToken: await taskLaunchSettingsToken(
        database.db,
        busyTask.id,
      ),
    },
    randomUUID(),
  );
  const other = await seedProjectRepo(
    database.db,
    `${root}/worker-other-project`,
  );
  const flowId = await reviewFlow(fixture.flowId, other.projectId);
  const [otherTask] = await database.db
    .insert(tasks)
    .values({
      id: randomUUID(),
      projectId: other.projectId,
      number: 1,
      title: "Independent repository",
      prompt: "Execute without the blocked repository",
      flowId,
      runnerId: fixture.runnerId,
    })
    .returning();
  const eligible = await acceptInteractiveTaskLaunch(
    database.db,
    principal,
    {
      taskId: otherTask.id,
      expectedTaskRevision: otherTask.revision,
      expectedSettingsToken: await taskLaunchSettingsToken(
        database.db,
        otherTask.id,
      ),
    },
    randomUUID(),
  );
  const agentTask = await task();
  const agentSelection = {
    agentId: agent.agentId,
    workspace: "none" as const,
    runnerId: fixture.runnerId,
  };
  const agentIntent = await acceptInteractiveTaskLaunch(
    database.db,
    principal,
    {
      taskId: agentTask.id,
      expectedTaskRevision: agentTask.revision,
      ...agentSelection,
      expectedSettingsToken: await taskLaunchSettingsToken(
        database.db,
        agentTask.id,
        agentSelection,
      ),
    },
    randomUUID(),
  );
  const fence = await acquireRepositoryMutationFence(fixture.repo);
  const tokenModule = await import("@/lib/agents/tokens");
  const issueToken = tokenModule.issueAgentRunToken;
  let ownerHeld = false;
  let releaseOwner: () => void = () => {};
  const ownerReleased = new Promise<void>((resolve) => {
    releaseOwner = resolve;
  });
  const tokenBarrier = vi
    .spyOn(tokenModule, "issueAgentRunToken")
    .mockImplementation(async (input) => {
      const issued = await issueToken(input);

      if (input.agentId === agent.agentId) {
        ownerHeld = true;
        await ownerReleased;
      }

      return issued;
    });
  let peerIntentId: string | null = null;
  const workers = startDurableWorkers();

  try {
    await expect.poll(() => ownerHeld, { timeout: 10_000 }).toBe(true);
    await dispatchBoundTaskLaunchIntent(database.db, agentIntent.intentId);
    const [duringPreparation] = await database.db
      .select()
      .from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.id, agentIntent.intentId));

    expect(duringPreparation).toMatchObject({
      state: "run_bound",
      reason: null,
      dispatchCommittedAt: null,
    });
    const beforeModel = await database.pool.query<{ n: number }>(
      "SELECT count(*)::int n FROM execution_commands WHERE run_id=$1 AND kind IN ('session.create','session.prompt')",
      [duringPreparation.runId],
    );

    expect(beforeModel.rows[0].n).toBe(0);
    const peerTask = await task();
    const peerSelection = {
      agentId: peerAgent.agentId,
      workspace: "none" as const,
      runnerId: fixture.runnerId,
    };
    const peer = await acceptInteractiveTaskLaunch(
      database.db,
      principal,
      {
        taskId: peerTask.id,
        expectedTaskRevision: peerTask.revision,
        ...peerSelection,
        expectedSettingsToken: await taskLaunchSettingsToken(
          database.db,
          peerTask.id,
          peerSelection,
        ),
      },
      randomUUID(),
    );

    peerIntentId = peer.intentId;
    await expect
      .poll(
        async () => {
          const [current] = await database.db
            .select()
            .from(taskLaunchIntents)
            .where(eq(taskLaunchIntents.id, peer.intentId));

          return !!current.dispatchCommittedAt;
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    releaseOwner();

    await expect
      .poll(
        async () => {
          const rows = await database.db
            .select()
            .from(taskLaunchIntents)
            .where(
              inArray(taskLaunchIntents.id, [
                blocked.intentId,
                eligible.intentId,
                agentIntent.intentId,
              ]),
            );

          return [eligible, agentIntent].map(({ intentId }) => {
            const row = rows.find((candidate) => candidate.id === intentId);

            return {
              committed: !!row?.dispatchCommittedAt,
              state: row?.state,
              reason: row?.reason,
            };
          });
        },
        { timeout: 10_000 },
      )
      .toEqual([
        expect.objectContaining({ committed: true }),
        expect.objectContaining({ committed: true }),
      ]);
    await expect
      .poll(
        async () => {
          const result = await database.pool.query<{ n: number }>(
            "SELECT count(*)::int n FROM execution_commands WHERE run_id=$1 AND kind IN ('session.create','session.prompt')",
            [duringPreparation.runId],
          );

          return result.rows[0].n;
        },
        { timeout: 10_000 },
      )
      .toBe(2);
    expect(workers.taskLaunch.health()).toEqual({
      state: "running",
      reason: null,
    });
    await stopDurableWorkers();
    const [stillBlocked] = await database.db
      .select()
      .from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.id, blocked.intentId));

    expect(stillBlocked).toMatchObject({
      state: "queued",
      reason: "operation_busy",
      runId: null,
      attempts: 0,
    });
    for (const row of [eligible, agentIntent])
      expect(
        await database.db
          .select()
          .from(runs)
          .where(eq(runs.taskLaunchIntentId, row.intentId)),
      ).toHaveLength(1);
  } finally {
    releaseOwner();
    await stopDurableWorkers();
    tokenBarrier.mockRestore();
    await fence.release();
    await abandonWorkerRuns([
      eligible.intentId,
      agentIntent.intentId,
      ...(peerIntentId ? [peerIntentId] : []),
    ]);
    vi.unstubAllEnvs();
  }
});

it("R18 refuses a dirty shared repository introduced after agent binding before freezing a baseline or creating a model session", async () => {
  vi.stubEnv("MAISTER_WORKTREES_ROOT", `${root}/worktrees`);
  vi.stubEnv("MAISTER_RUNTIME_ROOT", `${root}/runtime`);
  const agent = await seedAgentDefinition(database.db, {
    projectId: fixture.projectId,
    installedPath: `${root}/worker-dirty-agent`,
    terminalDelayMs: 0,
  });
  const row = await task();
  const selection = {
    agentId: agent.agentId,
    workspace: "repo_read" as const,
    runnerId: fixture.runnerId,
  };
  const receipt = await acceptInteractiveTaskLaunch(
    database.db,
    await interactiveTaskLaunchPrincipal(),
    {
      taskId: row.id,
      expectedTaskRevision: row.revision,
      ...selection,
      expectedSettingsToken: await taskLaunchSettingsToken(
        database.db,
        row.id,
        selection,
      ),
    },
    randomUUID(),
  );
  const bound = await prepareTaskLaunchIntent(database.db, receipt.intentId);
  const dirtyPath = path.join(fixture.repo, "R18-unaccepted.txt");

  expect(bound.state).toBe("run_bound");
  await writeFile(dirtyPath, "Unaccepted shared repository input\n");
  try {
    expect(await tryStartRun(bound.runId!, { db: database.db })).toMatchObject({
      started: true,
    });
    const { startAgentSession } = await import("@/lib/agents/launch");

    await startAgentSession(bound.runId!, { db: database.db });
    const [current] = await database.db
      .select()
      .from(runs)
      .where(eq(runs.id, bound.runId!));
    const commands = await database.pool.query<{ n: number }>(
      "SELECT count(*)::int n FROM execution_commands WHERE run_id=$1 AND kind IN ('session.create','session.prompt')",
      [bound.runId],
    );

    expect(current).toMatchObject({
      status: "Failed",
      operationalIntegrityBaseline: null,
    });
    expect(commands.rows[0].n).toBe(0);
  } finally {
    await abandonWorkerRuns([receipt.intentId]);
    await rm(dirtyPath, { force: true });
    vi.unstubAllEnvs();
  }
});

it("LA04 freezes the selected Brain decision without changing project/task defaults", async () => {
  const row = await task();
  const receipt = await acceptInteractiveTaskLaunch(
    database.db,
    await interactiveTaskLaunchPrincipal(),
    {
      taskId: row.id,
      expectedTaskRevision: row.revision,
      expectedSettingsToken: await taskLaunchSettingsToken(database.db, row.id),
      brainContext: false,
    },
    randomUUID(),
  );
  const [intent] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, receipt.intentId));

  expect(intent.settingsSnapshot).toMatchObject({
    brainContext: false,
    packageVersions: {},
  });
});

it("LA05 refuses a changed preview Flow revision even when the task's saved Flow did not change", async () => {
  const row = await task();
  const [sourceFlow] = await database.db
    .select()
    .from(flows)
    .where(eq(flows.id, fixture.flowId));
  const [sourceRevision] = await database.db
    .select()
    .from(flowRevisions)
    .where(eq(flowRevisions.id, sourceFlow.enabledRevisionId!));
  const selectedFlowId = randomUUID();
  const selectedRevisionId = randomUUID();

  await database.db.insert(flowRevisions).values({
    ...sourceRevision,
    id: selectedRevisionId,
    flowRefId: selectedFlowId,
  });
  await database.db.insert(flows).values({
    ...sourceFlow,
    id: selectedFlowId,
    flowRefId: selectedFlowId,
    enabledRevisionId: selectedRevisionId,
  });
  const selection = { flowId: selectedFlowId };
  const token = await taskLaunchSettingsToken(database.db, row.id, selection);
  const replacementRevisionId = randomUUID();

  await database.db.insert(flowRevisions).values({
    ...sourceRevision,
    id: replacementRevisionId,
    flowRefId: selectedFlowId,
    resolvedRevision: "replacement",
  });
  await database.db
    .update(flows)
    .set({ enabledRevisionId: replacementRevisionId })
    .where(eq(flows.id, selectedFlowId));
  await expect(
    acceptInteractiveTaskLaunch(
      database.db,
      await interactiveTaskLaunchPrincipal(),
      {
        taskId: row.id,
        expectedTaskRevision: row.revision,
        expectedSettingsToken: token,
        ...selection,
      },
      randomUUID(),
    ),
  ).rejects.toMatchObject({ details: { reason: "launch_settings_changed" } });
  expect(
    await database.db
      .select()
      .from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.taskId, row.id)),
  ).toEqual([]);
});

it("LA09 gives competing preparers one durable identity and capacity slot, and cancellation releases it", async () => {
  vi.stubEnv("MAISTER_MAX_CONCURRENT_RUNS", "1");
  const principal = await interactiveTaskLaunchPrincipal();
  const rows = await Promise.all([task(), task()]);
  const accepted = [];

  for (const row of rows)
    accepted.push(
      await acceptInteractiveTaskLaunch(
        database.db,
        principal,
        {
          taskId: row.id,
          expectedTaskRevision: row.revision,
          expectedSettingsToken: await taskLaunchSettingsToken(
            database.db,
            row.id,
          ),
        },
        randomUUID(),
      ),
    );
  try {
    const claims = await Promise.all([
      claimTaskLaunchIntent(database.db, accepted[0].intentId),
      claimTaskLaunchIntent(database.db, accepted[0].intentId),
    ]);
    const winner = claims.find((claim) => claim !== null);

    expect(winner).toBeDefined();
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await countLiveRuns(database.db, "flow")).toBe(1);
    expect(
      await claimTaskLaunchIntent(database.db, accepted[1].intentId),
    ).toBeNull();
    const [current] = await database.db
      .select()
      .from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.id, accepted[0].intentId));

    await cancelInteractiveTaskLaunch(
      database.db,
      principal,
      current.id,
      { expectedStateVersion: current.stateVersion },
      randomUUID(),
    );
    expect(await countLiveRuns(database.db, "flow")).toBe(0);
    await expect(
      advanceTaskLaunchPreparation(database.db, winner!, "checkout_ready"),
    ).rejects.toMatchObject({ details: { reason: "launch_worker_fenced" } });
    const next = await claimTaskLaunchIntent(database.db, accepted[1].intentId);

    expect(next).not.toBeNull();
    expect(next!.identity.runId).not.toBe(winner!.identity.runId);
  } finally {
    vi.unstubAllEnvs();
  }
});

it("LA09 expired preparation ownership reacquires the same identity and rejects stale publication", async () => {
  const row = await task();
  const accepted = await acceptInteractiveTaskLaunch(
    database.db,
    await interactiveTaskLaunchPrincipal(),
    {
      taskId: row.id,
      expectedTaskRevision: row.revision,
      expectedSettingsToken: await taskLaunchSettingsToken(database.db, row.id),
    },
    randomUUID(),
  );
  const first = await claimTaskLaunchIntent(database.db, accepted.intentId);

  expect(first).not.toBeNull();
  await database.db
    .update(taskLaunchIntents)
    .set({ leaseExpiresAt: sql`clock_timestamp()+interval '20 milliseconds'` })
    .where(eq(taskLaunchIntents.id, accepted.intentId));
  await database.pool.query("SELECT pg_sleep(0.04)");
  await expect(renewTaskLaunchClaim(database.db, first!)).rejects.toMatchObject(
    { details: { reason: "launch_worker_fenced" } },
  );
  const successor = await claimTaskLaunchIntent(database.db, accepted.intentId);

  expect(successor).not.toBeNull();
  expect(successor!.identity).toEqual(first!.identity);
  expect(successor!.leaseToken).not.toBe(first!.leaseToken);
  await expect(
    advanceTaskLaunchPreparation(database.db, first!, "checkout_ready"),
  ).rejects.toMatchObject({ details: { reason: "launch_worker_fenced" } });
  await advanceTaskLaunchPreparation(database.db, successor!, "checkout_ready");
  const [current] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, accepted.intentId));

  expect(current.preparationPhase).toBe("checkout_ready");
});

async function reviewFlow(
  sourceFlowId: string = fixture.flowId,
  projectId?: string,
): Promise<string> {
  const [oldFlow] = await database.db
    .select()
    .from(flows)
    .where(eq(flows.id, sourceFlowId));
  const [oldRevision] = await database.db
    .select()
    .from(flowRevisions)
    .where(eq(flowRevisions.id, oldFlow.enabledRevisionId!));
  const flowId = randomUUID();
  const revisionId = randomUUID();
  const manifest = {
    schemaVersion: 1,
    name: "Explicit review",
    nodes: [
      {
        id: "review",
        type: "human",
        finish: {
          human: { decisions: ["approve"], commentsVar: "review_comments" },
        },
        transitions: { approve: "done" },
      },
    ],
  };

  await database.db
    .insert(flowRevisions)
    .values({ ...oldRevision, id: revisionId, flowRefId: flowId, manifest });
  await database.db.insert(flows).values({
    ...oldFlow,
    projectId: projectId ?? oldFlow.projectId,
    id: flowId,
    flowRefId: flowId,
    enabledRevisionId: revisionId,
    manifest,
  });

  return flowId;
}

it("LA01/04 binds manual delivery after negative triage through the real engine with its exact frozen runner and input", async () => {
  vi.stubEnv("MAISTER_WORKTREES_ROOT", `${root}/worktrees`);
  vi.stubEnv("MAISTER_RUNTIME_ROOT", `${root}/runtime`);
  vi.stubEnv("MAISTER_DEFAULT_UNATTENDED_BUDGET_TOKENS", "");
  const row = await task();
  const flowId = await reviewFlow();

  await database.db
    .update(tasks)
    .set({ flowId, triageStatus: "flagged", triageFlagOrigin: "qualification" })
    .where(eq(tasks.id, row.id));
  const accepted = await acceptInteractiveTaskLaunch(
    database.db,
    await interactiveTaskLaunchPrincipal(),
    {
      taskId: row.id,
      expectedTaskRevision: row.revision,
      expectedSettingsToken: await taskLaunchSettingsToken(database.db, row.id),
      brainContext: false,
      executionPolicy: {
        preset: "unattended",
        overrides: { humanGate: "stop", permissions: "ask" },
      },
    },
    randomUUID(),
  );

  vi.stubEnv("MAISTER_DEFAULT_UNATTENDED_BUDGET_TOKENS", "2000");

  try {
    const receipt = await dispatchTaskLaunchIntent(
      database.db,
      accepted.intentId,
    );

    expect(receipt).toMatchObject({
      basis: "manual",
      state: "run_bound",
      runId: expect.any(String),
    });
    const [run] = await database.db
      .select()
      .from(runs)
      .where(eq(runs.id, receipt.runId!));
    const [workspace] = await database.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.runId, run.id));
    const sessions = await database.db
      .select()
      .from(runSessions)
      .where(eq(runSessions.runId, run.id));

    expect(run.taskAdmissionSnapshot).toMatchObject({
      version: 2,
      mode: "manual",
      intentId: accepted.intentId,
    });
    expect(workspace.baseCommit).toBe(accepted.snapshot.baseCommit);
    expect(sessions.map((session) => session.runnerId)).toEqual([
      fixture.runnerId,
    ]);
    expect(await taskLaunchInputForRun(database.db, run)).toMatchObject({
      prompt: row.prompt,
      title: row.title,
    });
    expect(run.executionPolicy).toEqual({
      preset: "unattended",
      overrides: { humanGate: "stop", permissions: "ask" },
    });
    await expect
      .poll(
        async () =>
          (
            await database.db
              .select({ status: runs.status })
              .from(runs)
              .where(eq(runs.id, run.id))
          )[0]?.status,
        { timeout: 10_000 },
      )
      .toBe("NeedsInput");
    const commands = await database.pool.query(
      "SELECT kind FROM execution_commands WHERE run_id=$1 AND kind IN ('session.create','session.prompt')",
      [run.id],
    );

    expect(commands.rows).toEqual([]);
    const [committed] = await database.db
      .select()
      .from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.id, accepted.intentId));

    expect(committed.dispatchReceipt).toMatchObject({
      runId: run.id,
      assignmentId: expect.any(String),
      assignmentEpoch: 1,
      inputDigest: committed.inputDigest,
      settingsDigest: committed.settingsDigest,
    });
    expect(new Date(committed.dispatchReceipt!.committedAt).getTime()).toBe(
      committed.dispatchCommittedAt!.getTime(),
    );
    await expect(
      database.db
        .update(taskLaunchIntents)
        .set({
          dispatchReceipt: {
            ...committed.dispatchReceipt!,
            assignmentEpoch: 2,
          },
        })
        .where(eq(taskLaunchIntents.id, committed.id)),
    ).rejects.toMatchObject({
      cause: { constraint: "task_launch_dispatch_receipt_immutable" },
    });
    await database.db.transaction(async (tx) => {
      expect(await abandonRunInTransaction(tx, run.id)).toBe(true);
    });
    const [settled] = await database.db
      .select()
      .from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.id, accepted.intentId));

    expect(settled).toMatchObject({
      state: "settled",
      terminalOutcome: "Abandoned",
      dispatchReceipt: committed.dispatchReceipt,
    });
  } finally {
    vi.unstubAllEnvs();
  }
});

it("LA06 explicit concurrent admission has a separate replay lane and never overwrites the ordinary request", async () => {
  const row = await task();
  const principal = await interactiveTaskLaunchPrincipal();
  const request = {
    taskId: row.id,
    expectedTaskRevision: row.revision,
    expectedSettingsToken: await taskLaunchSettingsToken(database.db, row.id),
  };
  const ordinaryKey = randomUUID();
  const ordinary = await acceptInteractiveTaskLaunch(
    database.db,
    principal,
    request,
    ordinaryKey,
  );

  await expect(
    acceptConcurrentInteractiveTaskLaunch(
      database.db,
      principal,
      request,
      ordinaryKey,
    ),
  ).rejects.toMatchObject({
    details: { reason: "launch_request_key_conflict" },
  });
  const concurrentKey = randomUUID();
  const concurrent = await acceptConcurrentInteractiveTaskLaunch(
    database.db,
    principal,
    request,
    concurrentKey,
  );

  expect(concurrent.intentId).not.toBe(ordinary.intentId);
  expect(
    await acceptConcurrentInteractiveTaskLaunch(
      database.db,
      principal,
      request,
      concurrentKey,
    ),
  ).toEqual(concurrent);
  const intents = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.taskId, row.id));

  expect(intents.map((intent) => intent.reservationLane).sort()).toEqual([
    "concurrent",
    "ordinary",
  ]);
  expect(
    intents.every(
      (intent) => intent.state === "queued" && intent.basis.kind === "manual",
    ),
  ).toBe(true);
  await expect(
    acceptInteractiveTaskLaunch(database.db, principal, request, randomUUID()),
  ).rejects.toMatchObject({ details: { reason: "launch_already_reserved" } });
});

it("LA13 resolves a project Flow ref centrally while preserving the original request for replay", async () => {
  const row = await task();
  const [sourceFlow] = await database.db
    .select()
    .from(flows)
    .where(eq(flows.id, fixture.flowId));
  const [sourceRevision] = await database.db
    .select()
    .from(flowRevisions)
    .where(eq(flowRevisions.id, sourceFlow.enabledRevisionId!));
  const flowId = randomUUID();
  const revisionId = randomUUID();
  const flowRefId = "aif-bugfix";

  await database.db
    .insert(flowRevisions)
    .values({ ...sourceRevision, id: revisionId, flowRefId });
  await database.db.insert(flows).values({
    ...sourceFlow,
    id: flowId,
    flowRefId,
    enabledRevisionId: revisionId,
  });
  const request = {
    taskId: row.id,
    expectedTaskRevision: row.revision,
    flowId: flowRefId,
    expectedSettingsToken: await taskLaunchSettingsToken(database.db, row.id, {
      flowId: flowRefId,
    }),
  };
  const key = randomUUID();
  const principal = await interactiveTaskLaunchPrincipal();
  const receipt = await acceptInteractiveTaskLaunch(
    database.db,
    principal,
    request,
    key,
  );

  expect(receipt.snapshot.flowId).toBe(flowId);
  expect(
    (await database.db.select().from(tasks).where(eq(tasks.id, row.id)))[0]
      .flowId,
  ).toBe(flowId);
  expect(
    await acceptInteractiveTaskLaunch(database.db, principal, request, key),
  ).toEqual(receipt);
  await expect(
    taskLaunchSettingsToken(database.db, row.id, {
      flowId: "foreign-only-flow",
    }),
  ).rejects.toMatchObject({ details: { reason: "flow_unavailable" } });
});

it("LA07 releases a pre-dispatch capacity reservation and later reuses the same bound Run without Git replay", async () => {
  vi.stubEnv("MAISTER_WORKTREES_ROOT", `${root}/worktrees`);
  vi.stubEnv("MAISTER_RUNTIME_ROOT", `${root}/runtime`);
  vi.stubEnv("MAISTER_MAX_CONCURRENT_RUNS", "2");
  const principal = await interactiveTaskLaunchPrincipal();
  const flowId = await reviewFlow();
  const rows = await Promise.all([task(), task()]);
  const accepted = [];

  try {
    for (const row of rows) {
      accepted.push(
        await acceptInteractiveTaskLaunch(
          database.db,
          principal,
          {
            taskId: row.id,
            expectedTaskRevision: row.revision,
            flowId,
            expectedSettingsToken: await taskLaunchSettingsToken(
              database.db,
              row.id,
              { flowId },
            ),
          },
          randomUUID(),
        ),
      );
    }
    const firstClaim = await claimTaskLaunchIntent(
      database.db,
      accepted[0].intentId,
    );

    expect(firstClaim).not.toBeNull();
    await launchAcceptedTaskRun(
      await acceptedTaskLaunchExecution(database.db, firstClaim!),
      database.db,
    );
    const [firstBound] = await database.db
      .select()
      .from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.id, accepted[0].intentId));
    const prepared = taskLaunchReceipt(firstBound);

    const fence = await acquireRepositoryMutationFence(fixture.repo);

    try {
      await dispatchBoundTaskLaunchIntent(database.db, prepared.intentId);
      const [waiting] = await database.db
        .select()
        .from(taskLaunchIntents)
        .where(eq(taskLaunchIntents.id, prepared.intentId));
      const transitions = await launchTransitionCount(waiting.id);

      expect(waiting).toMatchObject({
        state: "run_bound",
        reason: "operation_busy",
        dispatchCommittedAt: null,
      });
      await waitForLaunchDue(waiting.id);
      await dispatchBoundTaskLaunchIntent(database.db, waiting.id);
      const [renewed] = await database.db
        .select()
        .from(taskLaunchIntents)
        .where(eq(taskLaunchIntents.id, waiting.id));

      expect(renewed.stateVersion).toBe(waiting.stateVersion);
      expect(renewed.dueAt!.getTime()).toBeGreaterThan(
        waiting.dueAt!.getTime(),
      );
      expect(await launchTransitionCount(waiting.id)).toBe(transitions);
    } finally {
      await fence.release();
    }
    await prepareTaskLaunchIntent(database.db, accepted[1].intentId);
    expect(await countLiveRuns(database.db, "flow")).toBe(2);
    vi.stubEnv("MAISTER_MAX_CONCURRENT_RUNS", "1");
    expect(
      await tryStartRun(prepared.runId!, { db: database.db }),
    ).toMatchObject({ started: false });
    const [queued] = await database.db
      .select()
      .from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.id, prepared.intentId));

    expect(queued).toMatchObject({
      state: "queued",
      reason: "launch_capacity_wait",
      runId: prepared.runId,
      dispatchCommittedAt: null,
      preparationPhase: "run_bound",
    });
    expect(await countLiveRuns(database.db, "flow")).toBe(1);
    const [other] = await database.db
      .select()
      .from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.id, accepted[1].intentId));

    await cancelInteractiveTaskLaunch(
      database.db,
      principal,
      other.id,
      { expectedStateVersion: other.stateVersion },
      randomUUID(),
    );
    expect(await countLiveRuns(database.db, "flow")).toBe(0);
    startDurableWorkers();
    try {
      await expect
        .poll(
          async () => {
            const [current] = await database.db
              .select()
              .from(taskLaunchIntents)
              .where(eq(taskLaunchIntents.id, prepared.intentId));

            return (
              !!current.dispatchCommittedAt && current.runId === prepared.runId
            );
          },
          { timeout: 10_000 },
        )
        .toBe(true);
    } finally {
      await stopDurableWorkers();
    }
    await expect
      .poll(
        async () =>
          (
            await database.db
              .select()
              .from(runs)
              .where(eq(runs.id, prepared.runId!))
          )[0]?.status,
        { timeout: 10_000 },
      )
      .toBe("NeedsInput");
    const attempts = await database.db
      .select()
      .from(runs)
      .where(eq(runs.taskId, rows[0].id));

    expect(attempts.map((run) => run.id)).toEqual([prepared.runId]);
    expect(
      (
        await database.db.select().from(tasks).where(eq(tasks.id, rows[0].id))
      )[0].attemptNumber,
    ).toBe(queued.preparationIdentity!.taskAttemptNumber);
    await database.db.transaction(async (tx) => {
      await abandonRunInTransaction(tx, prepared.runId!);
    });
  } finally {
    vi.unstubAllEnvs();
  }
});

it("LA03/09 preserves automatic origin limits in C1 while manual work uses reserved headroom", async () => {
  vi.stubEnv("MAISTER_WORKTREES_ROOT", `${root}/worktrees`);
  vi.stubEnv("MAISTER_RUNTIME_ROOT", `${root}/runtime`);
  vi.stubEnv("MAISTER_MAX_CONCURRENT_RUNS", "1");
  vi.stubEnv("MAISTER_TASK_QUEUE_AUTO_RESERVE", "1");
  const flowId = await reviewFlow();
  const automatic = await task();
  const manual = await task();

  await database.db
    .update(tasks)
    .set({
      flowId,
      qualificationMode: "required",
      launchIntent: "triage_then_launch",
    })
    .where(eq(tasks.id, automatic.id));
  const qualification = await prepareTaskQualification(database.db, {
    projectId: fixture.projectId,
    taskId: automatic.id,
    author: { kind: "user", identity: fixture.userId, userId: fixture.userId },
    request: {
      requestKey: randomUUID(),
      expectedInputRevision: 1,
      expectedQualificationRevision: null,
      qualification: qualificationFixture(),
      enqueue: true,
    },
  });

  await database.db.transaction(qualification.apply);

  try {
    const autoIntent = await enqueueQualifiedAutomaticTaskLaunch(
      database.db,
      automatic.id,
    );

    expect(autoIntent).toMatchObject({
      basis: "automatic",
      state: "queued",
      runId: null,
    });
    expect(
      await enqueueQualifiedAutomaticTaskLaunch(database.db, automatic.id),
    ).toEqual(autoIntent);
    const manualIntent = await acceptInteractiveTaskLaunch(
      database.db,
      await interactiveTaskLaunchPrincipal(),
      {
        taskId: manual.id,
        expectedTaskRevision: manual.revision,
        flowId,
        expectedSettingsToken: await taskLaunchSettingsToken(
          database.db,
          manual.id,
          { flowId },
        ),
      },
      randomUUID(),
    );
    const first = await promoteNextPending({ db: database.db });

    expect(first.promotedRunId).not.toBeNull();
    expect(
      (
        await database.db
          .select()
          .from(taskLaunchIntents)
          .where(eq(taskLaunchIntents.id, manualIntent.intentId))
      )[0].runId,
    ).toBe(first.promotedRunId);
    expect(
      (
        await database.db
          .select()
          .from(taskLaunchIntents)
          .where(eq(taskLaunchIntents.id, autoIntent!.intentId))
      )[0].state,
    ).toBe("queued");
    expect(await countLiveAutoFlowRuns(database.db, fixture.projectId)).toBe(0);
    await expect
      .poll(
        async () =>
          (
            await database.db
              .select()
              .from(runs)
              .where(eq(runs.id, first.promotedRunId!))
          )[0]?.status,
        { timeout: 10_000 },
      )
      .toBe("NeedsInput");
    await database.db.transaction(async (tx) => {
      await abandonRunInTransaction(tx, first.promotedRunId!);
    });
    vi.stubEnv("MAISTER_TASK_QUEUE_AUTO_RESERVE", "0");
    const second = await promoteNextPending({ db: database.db });

    expect(second.promotedRunId).not.toBeNull();
    expect(await countLiveAutoFlowRuns(database.db, fixture.projectId)).toBe(1);
    await expect
      .poll(
        async () =>
          (
            await database.db
              .select()
              .from(runs)
              .where(eq(runs.id, second.promotedRunId!))
          )[0]?.status,
        { timeout: 10_000 },
      )
      .toBe("NeedsInput");
    const [bound] = await database.db
      .select()
      .from(runs)
      .where(eq(runs.id, second.promotedRunId!));

    expect(bound.taskAdmissionSnapshot).toMatchObject({
      version: 2,
      mode: "required",
      intentId: autoIntent!.intentId,
    });
    await database.db
      .update(tasks)
      .set({ prompt: "A future revision", revision: automatic.revision + 1 })
      .where(eq(tasks.id, automatic.id));
    expect((await taskLaunchInputForRun(database.db, bound))?.prompt).toBe(
      automatic.prompt,
    );
    await database.db.transaction(async (tx) => {
      await abandonRunInTransaction(tx, second.promotedRunId!);
    });
  } finally {
    vi.unstubAllEnvs();
  }
});

it("LA03 keeps concurrent manual selection when later qualification publishes and durably records the unapplied proposal", async () => {
  const row = await task();
  const proposedFlowId = await reviewFlow();
  const prepared = await prepareTaskQualification(database.db, {
    projectId: fixture.projectId,
    taskId: row.id,
    author: { kind: "user", identity: fixture.userId, userId: fixture.userId },
    request: {
      requestKey: randomUUID(),
      expectedInputRevision: 1,
      expectedQualificationRevision: null,
      qualification: qualificationFixture(),
      flowId: proposedFlowId,
      enqueue: true,
    },
  });
  const accepted = await acceptConcurrentInteractiveTaskLaunch(
    database.db,
    await interactiveTaskLaunchPrincipal(),
    {
      taskId: row.id,
      expectedTaskRevision: row.revision,
      expectedSettingsToken: await taskLaunchSettingsToken(database.db, row.id),
    },
    randomUUID(),
  );
  const publication = await database.db.transaction(prepared.apply);
  const [current] = await database.db
    .select()
    .from(tasks)
    .where(eq(tasks.id, row.id));
  const activity = await database.pool.query(
    "SELECT payload FROM task_activity WHERE task_id=$1 AND event_kind='triage_set'",
    [row.id],
  );

  expect(current).toMatchObject({
    flowId: row.flowId,
    runnerId: row.runnerId,
    launchMode: null,
    currentQualificationId: publication.qualificationId,
  });
  expect(activity.rows).toEqual([
    expect.objectContaining({
      payload: expect.objectContaining({
        routingApplication: {
          outcome: "not_applied_active_launch",
          intentId: accepted.intentId,
          proposal: {
            flowId: proposedFlowId,
            runnerId: fixture.runnerId,
            enqueue: true,
          },
        },
      }),
    }),
  ]);
  expect(
    await enqueueQualifiedAutomaticTaskLaunch(database.db, row.id),
  ).toBeNull();
  expect(
    (
      await database.db
        .select()
        .from(taskLaunchIntents)
        .where(eq(taskLaunchIntents.taskId, row.id))
    ).map((intent) => intent.id),
  ).toEqual([accepted.intentId]);
});

it("LA08 as-plan child Flow acceptance retains parent admission and a durable queued receipt across event redelivery", async () => {
  const parentTask = await task();
  const parentIntent = await acceptInteractiveTaskLaunch(
    database.db,
    await interactiveTaskLaunchPrincipal(),
    {
      taskId: parentTask.id,
      expectedTaskRevision: parentTask.revision,
      expectedSettingsToken: await taskLaunchSettingsToken(
        database.db,
        parentTask.id,
      ),
    },
    randomUUID(),
  );
  const parent = await prepareTaskLaunchIntent(
    database.db,
    parentIntent.intentId,
  );

  expect(parent).toHaveProperty("runId");
  if (!parent || !("runId" in parent) || !parent.runId)
    throw new Error("Fixture parent was not prepared");
  expect((await tryStartRun(parent.runId, { db: database.db })).started).toBe(
    true,
  );
  const admittedParentRunId = parent.runId;
  const child = await task();

  await database.db
    .update(tasks)
    .set({ delegationSpec: { kind: "flow", flowId: fixture.flowId } })
    .where(eq(tasks.id, child.id));
  await addTaskRelation(
    {
      projectId: fixture.projectId,
      fromTaskId: parentTask.id,
      toTaskId: child.id,
      kind: "parent_of",
      actor: { type: "system", id: null },
    },
    database.db,
  );
  await database.db.transaction((tx) =>
    establishExecutionChildAdmission(tx as unknown as Db, {
      projectId: fixture.projectId,
      parentRunId: admittedParentRunId,
      childTaskId: child.id,
      planRevision: "plan-v1",
    }),
  );
  await database.db
    .update(tasks)
    .set({ launchMode: "auto" })
    .where(eq(tasks.id, child.id));
  const [event] = await database.db
    .insert(domainEvents)
    .values({
      projectId: fixture.projectId,
      taskId: null,
      runId: parent.runId,
      kind: "run.done",
      actorType: "system",
      actorId: null,
      occurredAt: new Date(),
      payload: { runKind: "flow", parentRunId: parent.runId },
    })
    .returning();
  const consumer = buildAutoLaunchRunPlanConsumer({ db: database.db });

  await consumer.handle([event]);
  await consumer.handle([event]);
  const intents = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.taskId, child.id));

  expect(intents).toHaveLength(1);
  expect(intents[0]).toMatchObject({
    state: "queued",
    basis: { kind: "execution_child", parent: { parentRunId: parent.runId } },
    settingsSnapshot: { serverExecution: { kind: "execution_plan" } },
  });
  expect(
    await database.db.select().from(runs).where(eq(runs.taskId, child.id)),
  ).toHaveLength(0);
  const sibling = await task();

  await database.db
    .update(tasks)
    .set({ delegationSpec: { kind: "flow", flowId: fixture.flowId } })
    .where(eq(tasks.id, sibling.id));
  await addTaskRelation(
    {
      projectId: fixture.projectId,
      fromTaskId: parentTask.id,
      toTaskId: sibling.id,
      kind: "parent_of",
      actor: { type: "system", id: null },
    },
    database.db,
  );
  await database.db.transaction((tx) =>
    establishExecutionChildAdmission(tx as unknown as Db, {
      projectId: fixture.projectId,
      parentRunId: admittedParentRunId,
      childTaskId: sibling.id,
      planRevision: "plan-v1",
    }),
  );
  await database.db
    .update(tasks)
    .set({ launchMode: "auto" })
    .where(eq(tasks.id, sibling.id));
  await consumer.handle([event]);
  const [siblingIntent] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.taskId, sibling.id));

  const hogId = randomUUID();

  await database.db.insert(runs).values({
    id: hogId,
    flowVersion: "v1",
    flowRevision: "capacity-fixture",
    projectId: fixture.projectId,
    runKind: "agent",
    agentWorkspace: "none",
    parentRunId: admittedParentRunId,
    rootRunId: admittedParentRunId,
    status: "Running",
  });
  vi.stubEnv("MAISTER_MAX_ORCHESTRATOR_FANOUT", "1");
  expect(await claimTaskLaunchIntent(database.db, intents[0].id)).toBeNull();
  const [waiting] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, intents[0].id));

  expect(waiting).toMatchObject({
    state: "queued",
    reason: "launch_parent_capacity_wait",
    preparationIdentity: null,
    attempts: 0,
  });
  const waitingTransitions = await launchTransitionCount(waiting.id);

  await waitForLaunchDue(waiting.id);
  expect(await claimTaskLaunchIntent(database.db, waiting.id)).toBeNull();
  const [renewedWaiting] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, waiting.id));

  expect(renewedWaiting.stateVersion).toBe(waiting.stateVersion);
  expect(renewedWaiting.dueAt!.getTime()).toBeGreaterThan(
    waiting.dueAt!.getTime(),
  );
  expect(await launchTransitionCount(waiting.id)).toBe(waitingTransitions);
  await database.db
    .update(runs)
    .set({ status: "Done" })
    .where(eq(runs.id, hogId));
  await waitForLaunchDue(intents[0].id);
  const claim = await claimTaskLaunchIntent(database.db, intents[0].id);

  if (!claim) throw new Error("Child fixture did not claim");
  expect(await claimTaskLaunchIntent(database.db, siblingIntent.id)).toBeNull();
  const [reservedSibling] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, siblingIntent.id));

  expect(reservedSibling).toMatchObject({
    state: "queued",
    reason: "launch_parent_capacity_wait",
    preparationIdentity: null,
  });
  const prepared = await launchAcceptedTaskRun(
    await acceptedTaskLaunchExecution(database.db, claim),
    database.db,
  );

  expect(prepared).toHaveProperty("runId");
  if (!prepared?.runId) throw new Error("Child fixture did not prepare");
  const [childRun] = await database.db
    .select()
    .from(runs)
    .where(eq(runs.id, prepared.runId));

  expect(childRun).toMatchObject({
    parentRunId: parent.runId,
    rootRunId: parent.runId,
    taskAdmissionSnapshot: {
      version: 2,
      mode: "execution_child",
      basis: "execution_child",
      parent: { parentRunId: parent.runId },
    },
  });
  await writeDelegationBoundsIfChanged(database.db, admittedParentRunId, {
    instance: currentInstanceCeilings(),
    engineMin: "3.10.0",
    declared: { max_active_children: 1 },
    nodeId: "check",
    nodeAttemptId: randomUUID(),
  });
  const activeSiblingId = randomUUID();

  await database.db.insert(runs).values({
    id: activeSiblingId,
    flowVersion: "v1",
    flowRevision: "active-capacity-fixture",
    projectId: fixture.projectId,
    runKind: "agent",
    agentWorkspace: "none",
    parentRunId: admittedParentRunId,
    rootRunId: admittedParentRunId,
    status: "Running",
  });
  expect((await tryStartRun(childRun.id, { db: database.db })).started).toBe(
    false,
  );
  const unrelatedTask = await task();
  const unrelatedFlowId = await reviewFlow();
  const unrelated = await acceptInteractiveTaskLaunch(
    database.db,
    await interactiveTaskLaunchPrincipal(),
    {
      taskId: unrelatedTask.id,
      expectedTaskRevision: unrelatedTask.revision,
      flowId: unrelatedFlowId,
      expectedSettingsToken: await taskLaunchSettingsToken(
        database.db,
        unrelatedTask.id,
        { flowId: unrelatedFlowId },
      ),
    },
    randomUUID(),
  );
  const workers = startDurableWorkers();

  try {
    await expect
      .poll(
        async () => {
          const [current] = await database.db
            .select()
            .from(taskLaunchIntents)
            .where(eq(taskLaunchIntents.id, unrelated.intentId));

          return !!current.dispatchCommittedAt;
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    expect(workers.taskLaunch.health()).toEqual({
      state: "running",
      reason: null,
    });
    await stopDurableWorkers();
    const [blocked] = await database.db
      .select()
      .from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.id, intents[0].id));
    // The retry can become due before the stopped worker's state is observed.
    const deadline = await database.pool.query<{ deferred: boolean }>(
      "SELECT due_at > updated_at AS deferred FROM task_launch_intents WHERE id=$1",
      [blocked.id],
    );

    expect(blocked).toMatchObject({
      state: "queued",
      reason: "launch_capacity_wait",
      attempts: 0,
      runId: childRun.id,
    });
    expect(deadline.rows[0].deferred).toBe(true);
    expect(
      await database.db
        .select()
        .from(runs)
        .where(eq(runs.taskLaunchIntentId, blocked.id)),
    ).toHaveLength(1);
    expect(
      (await database.db.select().from(runs).where(eq(runs.id, childRun.id)))[0]
        .status,
    ).toBe("Pending");
    expect(
      (
        await database.pool.query<{ n: number }>(
          "SELECT count(*)::int n FROM execution_commands WHERE run_id=$1 AND kind IN ('session.create','session.prompt')",
          [childRun.id],
        )
      ).rows[0].n,
    ).toBe(0);
  } finally {
    await stopDurableWorkers();
    await abandonWorkerRuns([unrelated.intentId]);
    await database.db
      .update(runs)
      .set({ status: "Done" })
      .where(eq(runs.id, activeSiblingId));
  }
  startDurableWorkers();
  try {
    await expect
      .poll(
        async () => {
          const [current] = await database.db
            .select()
            .from(taskLaunchIntents)
            .where(eq(taskLaunchIntents.id, intents[0].id));

          return !!current.dispatchCommittedAt && current.runId === childRun.id;
        },
        { timeout: 10_000 },
      )
      .toBe(true);
  } finally {
    await stopDurableWorkers();
  }

  await consumer.handle([event]);
  expect(
    await database.db
      .select()
      .from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.taskId, child.id)),
  ).toHaveLength(1);
});

it("LA09 legacy public Flow allocators cannot create an untraced root even with current qualification", async () => {
  const row = await task();
  const qualification = await prepareTaskQualification(database.db, {
    projectId: fixture.projectId,
    taskId: row.id,
    author: { kind: "user", identity: fixture.userId, userId: fixture.userId },
    request: {
      requestKey: randomUUID(),
      expectedInputRevision: 1,
      expectedQualificationRevision: null,
      qualification: qualificationFixture(),
    },
  });

  await database.db.transaction(qualification.apply);
  const input = { taskId: row.id, flowId: fixture.flowId };
  const context = { actorUserId: fixture.userId, authorize: async () => {} };

  await expect(launchRun(input, context, database.db)).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "task_launch_intent_required" },
  });
  await expect(
    launchRunStaged(input, context, database.db).next(),
  ).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "task_launch_intent_required" },
  });
  expect(
    await database.db.select().from(runs).where(eq(runs.taskId, row.id)),
  ).toHaveLength(0);
  expect(
    (await database.db.select().from(tasks).where(eq(tasks.id, row.id)))[0]
      .attemptNumber,
  ).toBe(row.attemptNumber);
});

it("LA04 freezes the actual revision manifest between preview, acceptance and runtime readers", async () => {
  const [original] = await database.db
    .select()
    .from(flows)
    .where(eq(flows.id, fixture.flowId));
  const [revision] = await database.db
    .select()
    .from(flowRevisions)
    .where(eq(flowRevisions.id, original.enabledRevisionId!));
  const flowId = randomUUID();
  const revisionId = randomUUID();

  await database.db
    .insert(flowRevisions)
    .values({ ...revision, id: revisionId, flowRefId: flowId });
  await database.db.insert(flows).values({
    ...original,
    id: flowId,
    flowRefId: flowId,
    enabledRevisionId: revisionId,
  });
  const row = await task();
  const request = {
    taskId: row.id,
    flowId,
    expectedTaskRevision: row.revision,
    expectedSettingsToken: await taskLaunchSettingsToken(database.db, row.id, {
      flowId,
    }),
  };
  const changed = {
    schemaVersion: 1,
    name: "Changed actual behavior",
    nodes: [
      {
        id: "check",
        type: "cli",
        action: { command: "false" },
        transitions: { success: "done" },
      },
    ],
  };

  // Keep the old stored digest deliberately: the preview fence must cover the actual manifest bytes.
  await database.db
    .update(flowRevisions)
    .set({ manifest: changed })
    .where(eq(flowRevisions.id, revisionId));
  await expect(
    acceptInteractiveTaskLaunch(
      database.db,
      await interactiveTaskLaunchPrincipal(),
      request,
      randomUUID(),
    ),
  ).rejects.toMatchObject({ details: { reason: "launch_settings_changed" } });
  const principal = await interactiveTaskLaunchPrincipal();
  const currentRequest = {
    ...request,
    expectedSettingsToken: await taskLaunchSettingsToken(database.db, row.id, {
      flowId,
    }),
  };
  const blocker = await database.pool.connect();
  let blockerOpen = true;
  let accepted: Awaited<ReturnType<typeof acceptInteractiveTaskLaunch>>;

  try {
    await blocker.query("BEGIN");
    await blocker.query("LOCK TABLE task_launch_intents IN SHARE MODE");
    const acceptance = acceptInteractiveTaskLaunch(
      database.db,
      principal,
      currentRequest,
      randomUUID(),
    );

    await expect
      .poll(
        async () =>
          Number(
            (
              await database.pool.query(
                "SELECT count(*) n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%insert into%task_launch_intents%' ",
              )
            ).rows[0].n,
          ),
        { timeout: 10_000 },
      )
      .toBe(1);
    const mutation = database.db
      .update(flowRevisions)
      .set({ manifest: revision.manifest })
      .where(eq(flowRevisions.id, revisionId))
      .then(
        () => ({ error: null }),
        (error: unknown) => ({ error }),
      );

    await expect
      .poll(
        async () =>
          Number(
            (
              await database.pool.query(
                "SELECT count(*) n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%update%flow_revisions%' ",
              )
            ).rows[0].n,
          ),
        { timeout: 10_000 },
      )
      .toBe(1);
    await blocker.query("COMMIT");
    blockerOpen = false;
    accepted = await acceptance;
    expect(await mutation).toMatchObject({
      error: {
        cause: { constraint: "flow_revisions_referenced_manifest_immutable" },
      },
    });
  } finally {
    if (blockerOpen) await blocker.query("ROLLBACK");
    blocker.release();
  }
  expect(
    (
      await database.db
        .select()
        .from(flowRevisions)
        .where(eq(flowRevisions.id, revisionId))
    )[0].manifest,
  ).toEqual(changed);
  expect(
    (
      await database.db
        .select()
        .from(taskLaunchIntents)
        .where(eq(taskLaunchIntents.id, accepted.intentId))
    )[0].state,
  ).toBe("queued");
});
