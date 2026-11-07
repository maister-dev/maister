import type { Db } from "@/lib/execution-host/db";
import type { TaskLaunchFixture } from "@/test-support/task-launch-admission";
import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { randomUUID } from "node:crypto";
import path from "node:path";
import { access, mkdir, rm } from "node:fs/promises";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import {
  projects,
  tasks,
  runs,
  schedulerJobs,
  taskLaunchIntents,
  runSchedules,
  scheduledTaskLaunches,
  scheduledTaskLaunchAttempts,
} from "@/lib/db/schema";
import { runScheduledFlowJob } from "@/lib/scheduler/handlers/flow-run";
import { claimDueJobs, recordJobAttemptStarted } from "@/lib/scheduler/jobs";
import { prepareTaskQualification } from "@/lib/tasks/qualification";
import { seedTaskLaunchFixture } from "@/test-support/task-launch-admission";
import { qualificationFixture } from "@/test-support/task-qualification";
import { startMainPostgresTestDb } from "@/test-support/pg-container";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import { mkdtempReal } from "@/test-support/worktree-test-root";
import {
  dispatchDueSchedules,
  dispatchScheduleNow,
} from "@/lib/run-schedules/dispatch";
import {
  createScheduledLaunch,
  claimScheduledLaunch,
  dispatchClaimedScheduledLaunch,
} from "@/lib/scheduled-launches/service";
import { dispatchDueScheduledLaunches } from "@/lib/scheduled-launches/dispatch";
import {
  claimTaskLaunchIntent,
  assertTaskLaunchFlowClaim,
} from "@/lib/tasks/launch-dispatch-claim";
import { acceptedTaskLaunchExecution } from "@/lib/tasks/launch-execution";
import { acquireRepositoryMutationFence } from "@/lib/project-config-persistence/repository-lock";
import { addWorktree } from "@/lib/worktree";
import { launchAcceptedTaskRun } from "@/lib/services/runs";

let database: StartedPostgresTestDb;
let db: Db;
let fixture: TaskLaunchFixture;
let root: string;
let sequence = 0;
let occupiedRunId: string;
const priorWorktrees = process.env.MAISTER_WORKTREES_ROOT;
const priorRuntime = process.env.MAISTER_RUNTIME_ROOT;
const priorCap = process.env.MAISTER_MAX_CONCURRENT_RUNS;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "scheduled_flow_admission",
  });
  db = database.db;
  root = await mkdtempReal("scheduled-flow-admission-");
  process.env.MAISTER_WORKTREES_ROOT = path.join(root, "worktrees");
  process.env.MAISTER_RUNTIME_ROOT = path.join(root, "manager");
  await mkdir(path.join(root, "manager"), { recursive: true });
  fixture = await seedTaskLaunchFixture(database, root);
  await fakeExecutionHosts(db);
  await db
    .update(projects)
    .set({ taskQualificationOverride: "legacy" })
    .where(eq(projects.id, fixture.projectId));
  process.env.MAISTER_MAX_CONCURRENT_RUNS = "1";
  occupiedRunId = randomUUID();
  await db.insert(runs).values({
    id: occupiedRunId,
    projectId: fixture.projectId,
    runKind: "flow",
    status: "Running",
    flowVersion: "fixture",
  });
}, 180_000);

afterAll(async () => {
  if (priorCap === undefined) delete process.env.MAISTER_MAX_CONCURRENT_RUNS;
  else process.env.MAISTER_MAX_CONCURRENT_RUNS = priorCap;
  if (priorWorktrees === undefined) delete process.env.MAISTER_WORKTREES_ROOT;
  else process.env.MAISTER_WORKTREES_ROOT = priorWorktrees;
  if (priorRuntime === undefined) delete process.env.MAISTER_RUNTIME_ROOT;
  else process.env.MAISTER_RUNTIME_ROOT = priorRuntime;
  await database?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

async function claimedJob(): Promise<{
  taskId: string;
  target: Record<string, unknown>;
  source: { jobId: string; attemptId: string };
}> {
  const taskId = randomUUID();
  const jobId = randomUUID();
  const target = { taskId, runnerId: fixture.runnerId };

  await db.insert(tasks).values({
    id: taskId,
    projectId: fixture.projectId,
    number: ++sequence,
    title: "Scheduled change",
    prompt: "Pinned specification",
    flowId: fixture.flowId,
    runnerId: fixture.runnerId,
  });
  await db.insert(schedulerJobs).values({
    id: jobId,
    projectId: fixture.projectId,
    jobKind: "flow_run",
    target,
    cadenceIntervalSeconds: 3600,
    nextRunAt: new Date(Date.now() - 1000),
  });
  const jobs = await claimDueJobs({ db, jobKind: "flow_run", now: new Date() });
  const job = jobs.find((candidate) => candidate.id === jobId);

  if (!job) throw new Error("Fixture did not acquire scheduled job");
  await recordJobAttemptStarted({ attemptId: job.attemptId, db });

  return { taskId, target, source: { jobId, attemptId: job.attemptId } };
}

// The existing handler ignores the second argument; the cutover makes this durable source explicit.
const executeJob: (
  target: Record<string, unknown>,
  source: { jobId: string; attemptId: string },
) => Promise<unknown> = runScheduledFlowJob;

it("a claimed scheduled root cannot inherit the legacy qualification exemption", async () => {
  const job = await claimedJob();

  await expect(executeJob(job.target, job.source)).rejects.toMatchObject({
    details: { reason: "qualification_required" },
  });
  expect(
    await db
      .select()
      .from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.taskId, job.taskId)),
  ).toEqual([]);
});

it("an accepted assessment queues one automatic fire under capacity and replay preserves its decision", async () => {
  const job = await claimedJob();
  const prepared = await prepareTaskQualification(db, {
    projectId: fixture.projectId,
    taskId: job.taskId,
    author: { kind: "user", identity: fixture.userId, userId: fixture.userId },
    request: {
      requestKey: randomUUID(),
      expectedInputRevision: 1,
      expectedQualificationRevision: null,
      qualification: qualificationFixture(),
      enqueue: false,
    },
  });

  await db.transaction(prepared.apply);
  await executeJob(job.target, job.source);
  await executeJob(job.target, job.source);
  const accepted = await db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.taskId, job.taskId));

  expect(accepted).toHaveLength(1);
  expect(accepted[0]).toMatchObject({
    state: "queued",
    runId: null,
    basis: { kind: "automatic" },
  });
  expect(
    await db.select().from(runs).where(eq(runs.taskId, job.taskId)),
  ).toEqual([]);
});

async function readyTask(): Promise<string> {
  const taskId = randomUUID();

  await db.insert(tasks).values({
    id: taskId,
    projectId: fixture.projectId,
    number: ++sequence,
    title: "Scheduled exact input",
    prompt: "Execute the approved specification",
    flowId: fixture.flowId,
    runnerId: fixture.runnerId,
  });
  const prepared = await prepareTaskQualification(db, {
    projectId: fixture.projectId,
    taskId,
    author: { kind: "user", identity: fixture.userId, userId: fixture.userId },
    request: {
      requestKey: randomUUID(),
      expectedInputRevision: 1,
      expectedQualificationRevision: null,
      qualification: qualificationFixture(),
      enqueue: false,
    },
  });

  await db.transaction(prepared.apply);

  return taskId;
}

it("a queued recurring fire retains one logical occurrence across trigger replay and stale lease recovery", async () => {
  const taskId = await readyTask();
  const scheduleId = randomUUID();
  const now = new Date();

  await db.insert(runSchedules).values({
    id: scheduleId,
    projectId: fixture.projectId,
    taskId,
    name: "Explicit schedule",
    cronExpr: "*/5 * * * *",
    timezone: "UTC",
    overlapPolicy: "start_anyway",
    nextFireAt: new Date(now.getTime() - 60_000),
  });
  const first = await dispatchDueSchedules({ now });
  const [staged] = await db
    .select()
    .from(runSchedules)
    .where(eq(runSchedules.id, scheduleId));

  expect(first).toMatchObject({ fired: 0, acceptedWaiting: 1 });
  expect(staged).toMatchObject({
    lastFireOutcome: "dispatching",
    lastRunId: null,
  });
  expect(
    await dispatchScheduleNow(scheduleId, { actorUserId: fixture.userId }),
  ).toMatchObject({ outcome: "dispatching" });
  await db
    .update(runSchedules)
    .set({ updatedAt: new Date(now.getTime() - 400_000) })
    .where(eq(runSchedules.id, scheduleId));
  expect(await dispatchDueSchedules({ now: new Date() })).toMatchObject({
    fired: 0,
    acceptedWaiting: 1,
  });
  const [recovered] = await db
    .select()
    .from(runSchedules)
    .where(eq(runSchedules.id, scheduleId));

  expect(recovered.lastFiredAt).toEqual(staged.lastFiredAt);
  expect(recovered.nextFireAt).toEqual(staged.nextFireAt);
  expect(
    await db
      .select()
      .from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.taskId, taskId)),
  ).toHaveLength(1);
  expect(await db.select().from(runs).where(eq(runs.taskId, taskId))).toEqual(
    [],
  );
});

it("a one-time fire recovers its source lease without cleaning an owned checkout or changing the fixed allocation", async () => {
  const taskId = await readyTask();
  const now = new Date();
  const created = await createScheduledLaunch({
    projectId: fixture.projectId,
    taskId,
    actorUserId: fixture.userId,
    idempotencyKey: randomUUID(),
    scheduledLocalTime: new Date(now.getTime() - 60_000)
      .toISOString()
      .slice(0, 16),
    timezone: "UTC",
    launchRequest: { flowId: fixture.flowId, runnerId: fixture.runnerId },
    now: new Date(now.getTime() - 3600_000),
    db,
  });
  const scheduledClaim = await claimScheduledLaunch({
    scheduledLaunchId: created.intent.id,
    projectId: fixture.projectId,
    source: "tick",
    now,
    db,
  });

  expect(
    await dispatchClaimedScheduledLaunch({
      projectId: fixture.projectId,
      ...scheduledClaim,
      db,
    }),
  ).toEqual({ state: "Dispatching" });
  const [intent] = await db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.taskId, taskId));

  if (intent.settingsSnapshot.version !== 2)
    throw new Error("Fixture requires current execution settings");
  expect(
    intent.settingsSnapshot.serverExecution?.fixedAllocation,
  ).toMatchObject({
    runId: scheduledClaim.reservation.runId,
    branch: scheduledClaim.reservation.branch,
    taskAttemptNumber: scheduledClaim.reservation.taskAttemptNumber,
  });
  await db.delete(runs).where(eq(runs.id, occupiedRunId));
  const claim = await claimTaskLaunchIntent(db, intent.id);

  if (!claim) throw new Error("Fixture could not own its fixed preparation");
  assertTaskLaunchFlowClaim(claim);
  expect(claim.identity.runId).toBe(scheduledClaim.reservation.runId);
  const fence = await acquireRepositoryMutationFence(
    claim.identity.parentRepoPath,
  );

  try {
    await fence.run(async () => {
      const execution = await acceptedTaskLaunchExecution(db, claim);

      await execution.prepareWorkspace(() =>
        addWorktree({
          projectRepoPath: claim.identity.parentRepoPath,
          worktreePath: claim.identity.worktreePath,
          branch: claim.identity.branch,
          startPoint: claim.identity.baseCommit,
          provenance: {
            version: 2,
            runId: claim.identity.runId,
            projectId: fixture.projectId,
            parentRepoPath: claim.identity.parentRepoPath,
            branch: claim.identity.branch,
            workspaceKind: "flow",
            createdAt: new Date().toISOString(),
          },
        }),
      );
      await execution.materialize(async () => {});
      await db
        .update(scheduledTaskLaunches)
        .set({ claimExpiresAt: new Date(Date.now() - 1) })
        .where(eq(scheduledTaskLaunches.id, created.intent.id));
      await dispatchDueScheduledLaunches({ db, now: new Date() });
      const [recovered] = await db
        .select()
        .from(scheduledTaskLaunches)
        .where(eq(scheduledTaskLaunches.id, created.intent.id));

      expect(recovered).toMatchObject({
        state: "Dispatching",
        attemptCount: 1,
      });
      expect(recovered.claimFence).toBe(scheduledClaim.claimFence + 1);
      await access(claim.identity.worktreePath);
      const bound = await launchAcceptedTaskRun(execution, db);

      expect(bound).toMatchObject({
        runId: scheduledClaim.reservation.runId,
        status: "Pending",
      });
    });
  } finally {
    await fence.release();
  }
  await db
    .update(scheduledTaskLaunches)
    .set({ claimExpiresAt: new Date(Date.now() - 1) })
    .where(eq(scheduledTaskLaunches.id, created.intent.id));
  await dispatchDueScheduledLaunches({ db, now: new Date() });
  const [settled] = await db
    .select()
    .from(scheduledTaskLaunches)
    .where(eq(scheduledTaskLaunches.id, created.intent.id));
  const reservations = await db
    .select()
    .from(scheduledTaskLaunchAttempts)
    .where(
      eq(scheduledTaskLaunchAttempts.scheduledLaunchId, created.intent.id),
    );

  expect(settled).toMatchObject({ state: "Launched", attemptCount: 1 });
  expect(reservations).toHaveLength(1);
  expect(reservations[0]).toMatchObject({
    runId: scheduledClaim.reservation.runId,
    state: "RunLinked",
    taskAttemptNumber: scheduledClaim.reservation.taskAttemptNumber,
  });
  expect(
    await db
      .select()
      .from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.taskId, taskId)),
  ).toHaveLength(1);
});
