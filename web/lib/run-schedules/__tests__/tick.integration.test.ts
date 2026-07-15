import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import * as schema from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors-core";
import { flowManifestIncompatibilityDetails } from "@/lib/flows/manifest-parser";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const mocks = vi.hoisted(() => ({
  launchRun: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/services/runs", () => ({ launchRun: mocks.launchRun }));

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof schema>;
let tick: typeof import("@/lib/scheduler/tick-service");
let dispatch: typeof import("@/lib/run-schedules/dispatch");
let service: typeof import("@/lib/run-schedules/service");
let scheduledLaunches: typeof import("@/lib/scheduled-launches/service");

const DISPATCHER_ID = "run_schedule.dispatcher";
const MIN = 60_000;

let originalCap: string | undefined;

beforeAll(async () => {
  // The overlap×cap case seeds exactly 3 Running rows — pin the cap (the
  // M34 default moved to 6).
  originalCap = process.env.MAISTER_MAX_CONCURRENT_RUNS;
  process.env.MAISTER_MAX_CONCURRENT_RUNS = "3";

  testDatabase = await startMainPostgresTestDb({
    databaseName: "run_schedule_tick_test",
  });
  db = testDatabase.db;

  tick = await import("@/lib/scheduler/tick-service");
  dispatch = await import("@/lib/run-schedules/dispatch");
  service = await import("@/lib/run-schedules/service");
  scheduledLaunches = await import("@/lib/scheduled-launches/service");
}, 180_000);

afterAll(async () => {
  if (originalCap === undefined) {
    delete process.env.MAISTER_MAX_CONCURRENT_RUNS;
  } else {
    process.env.MAISTER_MAX_CONCURRENT_RUNS = originalCap;
  }
  await testDatabase?.stop();
});

beforeEach(async () => {
  mocks.launchRun.mockReset();
  mocks.launchRun.mockImplementation(async (input: {
    taskId: string;
    scheduledReservation?: { runId: string; scheduledLaunchId: string };
  }) => {
    const runId = input.scheduledReservation?.runId ?? randomUUID();
    const taskRows = await db
      .select({
        projectId: schema.tasks.projectId,
        flowId: schema.tasks.flowId,
      })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, input.taskId));
    const task = taskRows[0]!;

    await db.insert(schema.runs).values({
      id: runId,
      projectId: task.projectId,
      taskId: input.taskId,
      flowId: task.flowId,
      status: "Review",
      flowVersion: "v1.0.0",
      ...(input.scheduledReservation
        ? {
            scheduledLaunchId: input.scheduledReservation.scheduledLaunchId,
            triggerSource: "scheduled" as const,
          }
        : {}),
    });

    return { runId, status: "Review" };
  });
  // Make the dispatcher claimable again regardless of the previous tick.
  await db.execute(sql`
    UPDATE scheduler_jobs
    SET next_run_at = now() - interval '1 second', disabled_at = NULL
    WHERE id = ${DISPATCHER_ID}
  `);
});

type Seed = {
  projectId: string;
  flowId: string;
  taskId: string;
  userId: string;
};

async function seedBase(): Promise<Seed> {
  const projectId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const userId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;

  await db.insert(schema.users).values({
    id: userId,
    email: `${userId}@test.local`,
  });
  await db.insert(schema.projects).values({
    taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug,
    name: "Tick Test",
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
  });
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "aif",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/aif",
    manifest: { schemaVersion: 1, name: "aif", nodes: [] },
    schemaVersion: 1,
  });
  await db.insert(schema.tasks).values({
    number: Math.trunc(Math.random() * 1e9) + 1,
    id: taskId,
    projectId,
    title: `task-${taskId.slice(0, 8)}`,
    prompt: "p",
    flowId,
    status: "Backlog",
  });

  return { projectId, flowId, taskId, userId };
}

async function seedSchedule(
  seed: Seed,
  overrides: Partial<typeof schema.runSchedules.$inferInsert> = {},
): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.runSchedules).values({
    id,
    projectId: seed.projectId,
    taskId: seed.taskId,
    name: `sched-${id.slice(0, 8)}`,
    cronExpr: "*/5 * * * *",
    timezone: "UTC",
    overlapPolicy: "skip",
    enabled: true,
    nextFireAt: new Date(Date.now() - MIN),
    ...overrides,
  });

  return id;
}

async function seedOneTimeScheduledLaunch(seed: Seed): Promise<string> {
  const created = await scheduledLaunches.createScheduledLaunch({
    projectId: seed.projectId,
    taskId: seed.taskId,
    actorUserId: seed.userId,
    idempotencyKey: randomUUID(),
    scheduledLocalTime: "2026-06-01T10:15",
    timezone: "UTC",
    launchRequest: { flowId: seed.flowId },
    now: new Date("2026-01-01T00:00:00.000Z"),
    db,
  });

  return created.intent.id;
}

async function scheduleRow(id: string): Promise<schema.RunSchedule> {
  const rows = await db
    .select()
    .from(schema.runSchedules)
    .where(eq(schema.runSchedules.id, id));

  expect(rows).toHaveLength(1);

  return rows[0];
}

async function latestDispatcherAttempt(): Promise<{
  status: string;
  summary: Record<string, unknown>;
}> {
  const rows = await db
    .select({
      status: schema.schedulerJobRuns.status,
      summary: schema.schedulerJobRuns.summary,
      claimedAt: schema.schedulerJobRuns.claimedAt,
    })
    .from(schema.schedulerJobRuns)
    .where(eq(schema.schedulerJobRuns.jobId, DISPATCHER_ID));

  expect(rows.length).toBeGreaterThan(0);
  rows.sort((a, b) => b.claimedAt.getTime() - a.claimedAt.getTime());

  return rows[0];
}

function runTick() {
  return tick.runSchedulerTick({ jobKind: "run_schedule" });
}

describe("runSchedulerTick × run_schedule dispatcher (engine-level)", () => {
  it("seeds the dispatcher and fires a due schedule through the claimed job, persisting the summary", async () => {
    const seed = await seedBase();
    const id = await seedSchedule(seed);

    const summary = await runTick();

    expect(summary.claimedCount).toBe(1);
    expect(summary.succeededCount).toBe(1);
    expect(mocks.launchRun).toHaveBeenCalledTimes(1);

    const row = await scheduleRow(id);

    expect(row.lastFireOutcome).toBe("launched");
    expect(row.lastRunId).not.toBeNull();

    const attempt = await latestDispatcherAttempt();

    expect(attempt.status).toBe("Succeeded");
    expect((attempt.summary.recurring as { fired: number }).fired).toBe(1);
    expect((attempt.summary.recurring as { launchFailed: number }).launchFailed).toBe(0);
  });

  it("dispatches a due one-time intent through the same claimed run_schedule job", async () => {
    const seed = await seedBase();
    const scheduledLaunchId = await seedOneTimeScheduledLaunch(seed);

    const summary = await runTick();

    expect(summary.claimedCount).toBe(1);
    expect(summary.succeededCount).toBe(1);
    expect(mocks.launchRun).toHaveBeenCalledTimes(1);

    const intents = await db
      .select({
        state: schema.scheduledTaskLaunches.state,
        latestOutcome: schema.scheduledTaskLaunches.latestOutcome,
      })
      .from(schema.scheduledTaskLaunches)
      .where(eq(schema.scheduledTaskLaunches.id, scheduledLaunchId));

    expect(intents).toEqual([{ state: "Launched", latestOutcome: "launched" }]);

    const attempt = await latestDispatcherAttempt();

    expect(attempt.status).toBe("Succeeded");
    expect(attempt.summary).toMatchObject({
      recurring: { fired: 0 },
      oneTime: { claimed: 1, launched: 1, failed: 0 },
    });
  });

  it("records the dispatcher attempt Succeeded even when a schedule's fire is launch_failed", async () => {
    const seed = await seedBase();
    const id = await seedSchedule(seed);

    mocks.launchRun.mockRejectedValue(
      new MaisterError("PRECONDITION", "parent repo is dirty"),
    );

    const summary = await runTick();

    expect(summary.succeededCount).toBe(1);
    expect(summary.failedCount).toBe(0);

    const row = await scheduleRow(id);

    expect(row.lastFireOutcome).toBe("launch_failed");
    expect(row.lastFireError).toBe("PRECONDITION: parent repo is dirty");

    const attempt = await latestDispatcherAttempt();

    expect(attempt.status).toBe("Succeeded");
    expect((attempt.summary.recurring as { launchFailed: number }).launchFailed).toBe(1);

    const jobRows = await db
      .select({ failures: schema.schedulerJobs.consecutiveFailures })
      .from(schema.schedulerJobs)
      .where(eq(schema.schedulerJobs.id, DISPATCHER_ID));

    expect(jobRows[0]?.failures).toBe(0);
  });

  it("persists incompatibleDisabled analytics while pausing one incompatible schedule", async () => {
    const seed = await seedBase();
    const id = await seedSchedule(seed);

    mocks.launchRun.mockRejectedValue(
      new MaisterError("CONFIG", "engine range excluded", {
        details: flowManifestIncompatibilityDetails({
          kind: "engine_incompatible",
          message: "engine 3.0.0 < engine_min 4.0.0",
        }),
      }),
    );

    const summary = await runTick();

    expect(summary.succeededCount).toBe(1);
    expect(summary.failedCount).toBe(0);

    const row = await scheduleRow(id);

    expect(row.enabled).toBe(false);
    expect(row.lastFireOutcome).toBe("incompatible_disabled");
    expect(row.lastFireError).toBe("CONFIG: engine range excluded");

    const attempt = await latestDispatcherAttempt();

    expect(attempt.status).toBe("Succeeded");
    expect(attempt.summary.incompatibleDisabled).toBe(1);

    const jobRows = await db
      .select({ failures: schema.schedulerJobs.consecutiveFailures })
      .from(schema.schedulerJobs)
      .where(eq(schema.schedulerJobs.id, DISPATCHER_ID));

    expect(jobRows[0]?.failures).toBe(0);
  });

  it("kill switch: a disabled dispatcher job fires nothing; re-enable recovers", async () => {
    const seed = await seedBase();
    const id = await seedSchedule(seed);

    await db.execute(sql`
      UPDATE scheduler_jobs SET disabled_at = now() WHERE id = ${DISPATCHER_ID}
    `);

    const summary = await runTick();

    expect(summary.claimedCount).toBe(0);
    expect(mocks.launchRun).not.toHaveBeenCalled();
    expect((await scheduleRow(id)).lastFireOutcome).toBeNull();

    await db.execute(sql`
      UPDATE scheduler_jobs
      SET disabled_at = NULL, next_run_at = now() - interval '1 second'
      WHERE id = ${DISPATCHER_ID}
    `);

    const recovered = await runTick();

    expect(recovered.claimedCount).toBe(1);
    expect(mocks.launchRun).toHaveBeenCalledTimes(1);
    expect((await scheduleRow(id)).lastFireOutcome).toBe("launched");
  });

  it("pause stops firing; resume recomputes next_fire_at from now", async () => {
    const seed = await seedBase();
    const id = await seedSchedule(seed);

    await service.updateSchedule(
      seed.projectId,
      id,
      { enabled: false },
      { actorUserId: seed.userId },
    );

    await runTick();

    expect(mocks.launchRun).not.toHaveBeenCalled();
    expect((await scheduleRow(id)).lastFireOutcome).toBeNull();

    const before = new Date();
    const resumed = await service.updateSchedule(
      seed.projectId,
      id,
      { enabled: true },
      { actorUserId: seed.userId },
    );

    expect(resumed!.nextFireAt.getTime()).toBeGreaterThan(before.getTime());

    await db.execute(sql`
      UPDATE scheduler_jobs
      SET next_run_at = now() - interval '1 second'
      WHERE id = ${DISPATCHER_ID}
    `);
    await runTick();

    expect(mocks.launchRun).not.toHaveBeenCalled();
  });

  it("tick racing trigger-now on the same due schedule launches exactly once", async () => {
    const seed = await seedBase();
    const id = await seedSchedule(seed);

    await Promise.all([
      runTick(),
      dispatch
        .dispatchScheduleNow(id, { actorUserId: seed.userId })
        .catch((err: unknown) => {
          if (err instanceof MaisterError && err.code === "CONFLICT") return;
          throw err;
        }),
    ]);

    expect(mocks.launchRun).toHaveBeenCalledTimes(1);
  });

  it("overlap×cap at tick level: skip skips at cap, start_anyway queues Pending", async () => {
    const seed = await seedBase();
    const fillers: string[] = [];

    for (let i = 0; i < 3; i++) {
      const fid = randomUUID();

      fillers.push(fid);
      await db.insert(schema.runs).values({
        id: fid,
        projectId: seed.projectId,
        flowId: seed.flowId,
        status: "Running",
        flowVersion: "v1.0.0",
      });
    }

    const skipId = await seedSchedule(seed);
    const anywaySeed = await seedBase();
    const anywayId = await seedSchedule(anywaySeed, {
      overlapPolicy: "start_anyway",
    });

    mocks.launchRun.mockImplementation(async (input: { taskId: string }) => {
      const runId = randomUUID();
      const taskRows = await db
        .select({
          projectId: schema.tasks.projectId,
          flowId: schema.tasks.flowId,
        })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, input.taskId));
      const task = taskRows[0]!;

      await db.insert(schema.runs).values({
        id: runId,
        projectId: task.projectId,
        taskId: input.taskId,
        flowId: task.flowId,
        status: "Pending",
        flowVersion: "v1.0.0",
      });

      return { runId, status: "Pending", queuePosition: 1 };
    });

    await runTick();

    expect((await scheduleRow(skipId)).lastFireOutcome).toBe("skipped_cap");

    const anywayRow = await scheduleRow(anywayId);

    expect(anywayRow.lastFireOutcome).toBe("queued_pending");
    expect(anywayRow.lastRunId).not.toBeNull();
    expect(mocks.launchRun).toHaveBeenCalledTimes(1);

    for (const fid of fillers) {
      await db.delete(schema.runs).where(eq(schema.runs.id, fid));
    }
  });

  it("queue_one cycle across ticks: blocked fire flags, freed slot consumes the catch-up", async () => {
    const seed = await seedBase();
    const blocker = randomUUID();

    await db.insert(schema.runs).values({
      id: blocker,
      projectId: seed.projectId,
      taskId: seed.taskId,
      flowId: seed.flowId,
      status: "Running",
      flowVersion: "v1.0.0",
    });

    const futureFire = new Date(Date.now() + 60 * MIN);
    const id = await seedSchedule(seed, { overlapPolicy: "queue_one" });

    await runTick();

    let row = await scheduleRow(id);

    expect(row.lastFireOutcome).toBe("catchup_queued");
    expect(row.queueOnePending).toBe(true);
    expect(mocks.launchRun).not.toHaveBeenCalled();

    // The blocking run terminates; park the cron slot in the future so the
    // next tick claims the row via the catch-up flag alone.
    await db
      .update(schema.runs)
      .set({ status: "Failed" })
      .where(eq(schema.runs.id, blocker));
    await db
      .update(schema.runSchedules)
      .set({ nextFireAt: futureFire })
      .where(eq(schema.runSchedules.id, id));
    await db.execute(sql`
      UPDATE scheduler_jobs
      SET next_run_at = now() - interval '1 second'
      WHERE id = ${DISPATCHER_ID}
    `);

    await runTick();

    row = await scheduleRow(id);

    expect(row.lastFireOutcome).toBe("launched");
    expect(row.queueOnePending).toBe(false);
    expect(row.nextFireAt.getTime()).toBe(futureFire.getTime());
    expect(mocks.launchRun).toHaveBeenCalledTimes(1);
  });
});
