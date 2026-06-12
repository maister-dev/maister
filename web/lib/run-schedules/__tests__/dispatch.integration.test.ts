import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors-core";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase<typeof schema>;
let dispatch: typeof import("@/lib/run-schedules/dispatch");

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let originalCap: string | undefined;

beforeAll(async () => {
  // The cap-full cases seed exactly 3 Running rows — pin the cap (the M34
  // default moved to 6).
  originalCap = process.env.MAISTER_MAX_CONCURRENT_RUNS;
  process.env.MAISTER_MAX_CONCURRENT_RUNS = "3";

  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("run_schedule_dispatch_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 10 });
  db = drizzle(pool, { schema });

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  dispatch = await import("@/lib/run-schedules/dispatch");
}, 180_000);

afterAll(async () => {
  if (originalCap === undefined) {
    delete process.env.MAISTER_MAX_CONCURRENT_RUNS;
  } else {
    process.env.MAISTER_MAX_CONCURRENT_RUNS = originalCap;
  }
  await pool?.end();
  await container?.stop();
});

const MIN = 60_000;

type Seed = {
  projectId: string;
  flowId: string;
  taskId: string;
  userId: string;
};

async function seedBase(
  opts: {
    taskStatus?: "Backlog" | "InFlight" | "Done" | "Abandoned";
    archivedProject?: boolean;
  } = {},
): Promise<Seed> {
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
    name: "Dispatch Test",
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
    archivedAt: opts.archivedProject ? new Date() : null,
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
    status: opts.taskStatus ?? "Backlog",
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

async function seedRun(
  seed: Seed,
  status: schema.RunStatus,
  opts: { onTask?: boolean; startedAt?: Date } = {},
): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.runs).values({
    id,
    projectId: seed.projectId,
    taskId: opts.onTask === false ? null : seed.taskId,
    flowId: seed.flowId,
    status,
    flowVersion: "v1.0.0",
    startedAt: opts.startedAt ?? new Date(),
  });

  return id;
}

async function scheduleRow(id: string): Promise<schema.RunSchedule> {
  const rows = await db
    .select()
    .from(schema.runSchedules)
    .where(eq(schema.runSchedules.id, id));

  expect(rows).toHaveLength(1);

  return rows[0];
}

// Inserts a REAL run row (last_run_id is a runs FK): default status "Review"
// is non-live and non-Pending, so stub launches never consume cap slots.
function launchStub(
  result: { status: string; queuePosition?: number } = { status: "Review" },
) {
  return vi.fn(async (input: { taskId: string }) => {
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
      status: result.status as schema.RunStatus,
      flowVersion: "v1.0.0",
    });

    return { runId, ...result };
  });
}

describe("dispatchDueSchedules", () => {
  it("fires a due schedule once, advances next_fire_at from now, records launched + last_run_id", async () => {
    const seed = await seedBase();
    // Overdue by 3 slots of a 5-minute cron — catch-up collapses to ONE fire.
    const id = await seedSchedule(seed, {
      nextFireAt: new Date(Date.now() - 15 * MIN),
    });
    const launch = launchStub();
    const before = new Date();

    const summary = await dispatch.dispatchDueSchedules({ launch });

    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith(
      { taskId: seed.taskId, runnerId: undefined },
      expect.objectContaining({ actorUserId: null }),
    );
    expect(summary.fired).toBe(1);
    expect(summary.launchFailed).toBe(0);
    expect(summary.truncated).toBe(false);

    const row = await scheduleRow(id);

    expect(row.lastFireOutcome).toBe("launched");
    expect(row.lastRunId).not.toBeNull();
    expect(row.lastFiredAt).not.toBeNull();
    expect(row.nextFireAt.getTime()).toBeGreaterThan(before.getTime());
  });

  it("cap full: skip records skipped_cap without launching and still advances next_fire_at", async () => {
    const seed = await seedBase();

    for (let i = 0; i < 3; i++)
      await seedRun(seed, "Running", { onTask: false });
    const id = await seedSchedule(seed);
    const launch = launchStub();
    const before = new Date();

    const summary = await dispatch.dispatchDueSchedules({ launch });

    expect(launch).not.toHaveBeenCalled();
    expect(summary.skippedCap).toBe(1);

    const row = await scheduleRow(id);

    expect(row.lastFireOutcome).toBe("skipped_cap");
    expect(row.nextFireAt.getTime()).toBeGreaterThan(before.getTime());

    await db
      .delete(schema.runs)
      .where(eq(schema.runs.projectId, seed.projectId));
  });

  it("cap full: start_anyway launches into the Pending queue (queued_pending)", async () => {
    const seed = await seedBase();

    for (let i = 0; i < 3; i++)
      await seedRun(seed, "Running", { onTask: false });
    const id = await seedSchedule(seed, { overlapPolicy: "start_anyway" });
    const launch = launchStub({ status: "Pending", queuePosition: 1 });

    const summary = await dispatch.dispatchDueSchedules({ launch });

    expect(launch).toHaveBeenCalledTimes(1);
    expect(summary.fired).toBe(1);

    const row = await scheduleRow(id);

    expect(row.lastFireOutcome).toBe("queued_pending");
    expect(row.lastRunId).not.toBeNull();

    await db
      .delete(schema.runs)
      .where(eq(schema.runs.projectId, seed.projectId));
  });

  it("cap full: queue_one flags a catch-up (catchup_queued + queue_one_pending)", async () => {
    const seed = await seedBase();

    for (let i = 0; i < 3; i++)
      await seedRun(seed, "Running", { onTask: false });
    const id = await seedSchedule(seed, { overlapPolicy: "queue_one" });
    const launch = launchStub();

    const summary = await dispatch.dispatchDueSchedules({ launch });

    expect(launch).not.toHaveBeenCalled();
    expect(summary.catchupQueued).toBe(1);

    const row = await scheduleRow(id);

    expect(row.lastFireOutcome).toBe("catchup_queued");
    expect(row.queueOnePending).toBe(true);
    expect(row.queuedFireAt).not.toBeNull();

    await db
      .delete(schema.runs)
      .where(eq(schema.runs.projectId, seed.projectId));
    // The flag keeps this row claimable on EVERY later dispatch — remove it
    // so subsequent tests' dispatch calls only see their own schedules.
    await db.delete(schema.runSchedules).where(eq(schema.runSchedules.id, id));
  });

  it("busy task: skip and start_anyway both record skipped_task_busy (no second concurrent run per task)", async () => {
    for (const policy of ["skip", "start_anyway"] as const) {
      const seed = await seedBase();

      await seedRun(seed, "Running");
      const id = await seedSchedule(seed, { overlapPolicy: policy });
      const launch = launchStub();

      const summary = await dispatch.dispatchDueSchedules({ launch });

      expect(launch).not.toHaveBeenCalled();
      expect(summary.skippedBusy).toBe(1);

      const row = await scheduleRow(id);

      expect(row.lastFireOutcome).toBe("skipped_task_busy");

      await db
        .delete(schema.runs)
        .where(eq(schema.runs.projectId, seed.projectId));
    }
  });

  it("queue_one catch-up: a flagged not-due row fires when unblocked, WITHOUT advancing next_fire_at, and clears the flag", async () => {
    const seed = await seedBase();
    const futureFire = new Date(Date.now() + 60 * MIN);
    const id = await seedSchedule(seed, {
      overlapPolicy: "queue_one",
      nextFireAt: futureFire,
      queueOnePending: true,
      queuedFireAt: new Date(Date.now() - 10 * MIN),
    });

    // The blocking run is now terminal — task is retry-eligible.
    await seedRun(seed, "Failed", {
      startedAt: new Date(Date.now() - 5 * MIN),
    });
    const launch = launchStub();

    const summary = await dispatch.dispatchDueSchedules({ launch });

    expect(launch).toHaveBeenCalledTimes(1);
    expect(summary.fired).toBe(1);

    const row = await scheduleRow(id);

    expect(row.lastFireOutcome).toBe("launched");
    expect(row.queueOnePending).toBe(false);
    expect(row.queuedFireAt).toBeNull();
    expect(row.nextFireAt.getTime()).toBe(futureFire.getTime());
  });

  it("a successful due fire also clears a pending catch-up flag (no double launch)", async () => {
    const seed = await seedBase();
    const id = await seedSchedule(seed, {
      overlapPolicy: "queue_one",
      queueOnePending: true,
      queuedFireAt: new Date(Date.now() - 10 * MIN),
    });
    const launch = launchStub();

    await dispatch.dispatchDueSchedules({ launch });

    expect(launch).toHaveBeenCalledTimes(1);

    const row = await scheduleRow(id);

    expect(row.lastFireOutcome).toBe("launched");
    expect(row.queueOnePending).toBe(false);
  });

  it("no-double-fire: two concurrent dispatch calls claim exactly one launch", async () => {
    const seed = await seedBase();

    await seedSchedule(seed);
    const launch = launchStub();

    await Promise.all([
      dispatch.dispatchDueSchedules({ launch }),
      dispatch.dispatchDueSchedules({ launch }),
    ]);

    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("launch_failed: a MaisterError from launchRun is recorded (code: message, bounded) and the dispatcher does not throw", async () => {
    const seed = await seedBase();
    const id = await seedSchedule(seed);
    const launch = vi.fn(async () => {
      throw new MaisterError("PRECONDITION", "parent repo is dirty".repeat(60));
    });

    const summary = await dispatch.dispatchDueSchedules({ launch });

    expect(summary.launchFailed).toBe(1);

    const row = await scheduleRow(id);

    expect(row.lastFireOutcome).toBe("launch_failed");
    expect(row.lastFireError).toMatch(/^PRECONDITION: /);
    expect(row.lastFireError!.length).toBeLessThanOrEqual(500);
    expect(row.lastRunId).toBeNull();
  });

  it("W1 remnant: a stale 'dispatching' row is overwritten by the next due fire", async () => {
    const seed = await seedBase();
    const id = await seedSchedule(seed, {
      lastFireOutcome: "dispatching",
      lastFiredAt: new Date(Date.now() - 10 * MIN),
    });
    const launch = launchStub();

    await dispatch.dispatchDueSchedules({ launch });

    expect(launch).toHaveBeenCalledTimes(1);

    const row = await scheduleRow(id);

    expect(row.lastFireOutcome).toBe("launched");
  });

  it("never claims a FRESH 'dispatching' row (a trigger mid-launch owns it)", async () => {
    const seed = await seedBase();
    const id = await seedSchedule(seed, {
      lastFireOutcome: "dispatching",
      lastFiredAt: new Date(Date.now() - 10_000),
    });
    const launch = launchStub();

    const summary = await dispatch.dispatchDueSchedules({ launch });

    expect(launch).not.toHaveBeenCalled();
    expect(summary.fired).toBe(0);

    const row = await scheduleRow(id);

    expect(row.lastFireOutcome).toBe("dispatching");
  });

  it("a tick during a slow trigger-now launch leaves the row alone; the trigger result survives", async () => {
    const seed = await seedBase();
    const id = await seedSchedule(seed);

    let enterLaunch!: () => void;
    let releaseLaunch!: () => void;
    const entered = new Promise<void>((r) => {
      enterLaunch = r;
    });
    const gate = new Promise<void>((r) => {
      releaseLaunch = r;
    });
    const triggerLaunch = vi.fn(async (input: { taskId: string }) => {
      enterLaunch();
      await gate;
      const inner = launchStub();

      return inner(input);
    });
    const tickLaunch = launchStub();

    const triggerPromise = dispatch.dispatchScheduleNow(id, {
      actorUserId: seed.userId,
      launch: triggerLaunch,
    });

    await entered;

    const summary = await dispatch.dispatchDueSchedules({ launch: tickLaunch });

    expect(tickLaunch).not.toHaveBeenCalled();
    expect(summary.fired).toBe(0);

    releaseLaunch();

    const result = await triggerPromise;

    expect(result.outcome).toBe("launched");

    const row = await scheduleRow(id);

    expect(row.lastFireOutcome).toBe("launched");
    expect(row.lastRunId).not.toBeNull();
  });

  it("batch cap reservation: one tick never launches past the cap for skip, and flags queue_one overflow", async () => {
    const seeds = await Promise.all(
      Array.from({ length: 5 }, () => seedBase()),
    );
    const ids: string[] = [];

    for (let i = 0; i < 5; i++) {
      ids.push(
        await seedSchedule(seeds[i], {
          overlapPolicy: i < 3 ? "skip" : i === 3 ? "skip" : "queue_one",
          nextFireAt: new Date(Date.now() - (60 - i) * MIN),
        }),
      );
    }

    const launch = launchStub();
    const summary = await dispatch.dispatchDueSchedules({ launch });

    // Default cap is 3: the batch itself must reserve slots as it stages
    // launches — the 4th (skip) row skips, the 5th (queue_one) row flags.
    expect(launch).toHaveBeenCalledTimes(3);
    expect(summary.fired).toBe(3);
    expect(summary.skippedCap).toBe(1);
    expect(summary.catchupQueued).toBe(1);

    const fourth = await scheduleRow(ids[3]);

    expect(fourth.lastFireOutcome).toBe("skipped_cap");

    const fifth = await scheduleRow(ids[4]);

    expect(fifth.lastFireOutcome).toBe("catchup_queued");
    expect(fifth.queueOnePending).toBe(true);

    await db
      .delete(schema.runSchedules)
      .where(eq(schema.runSchedules.id, ids[4]));
  });

  it("tx2 CAS: a concurrent outcome write during the launch wins; the stale dispatch result is dropped", async () => {
    const seed = await seedBase();
    const id = await seedSchedule(seed);
    const launch = vi.fn(async () => {
      await db
        .update(schema.runSchedules)
        .set({ lastFireOutcome: "skipped_task_busy" })
        .where(eq(schema.runSchedules.id, id));

      return { runId: randomUUID(), status: "Running" };
    });

    await dispatch.dispatchDueSchedules({ launch });

    const row = await scheduleRow(id);

    expect(row.lastFireOutcome).toBe("skipped_task_busy");
    expect(row.lastRunId).toBeNull();
  });

  it("tx2 CAS fencing: a launch that outlived its lease cannot overwrite a newer reclaim's 'dispatching' marker", async () => {
    const seed = await seedBase();
    const id = await seedSchedule(seed);
    const newerStamp = new Date(Date.now() + MIN);
    const launch = vi.fn(async () => {
      // Simulate the W1 reclaim: while this launch hangs past the attempt
      // timeout, a newer dispatcher re-stamps the row and is now mid-launch.
      await db
        .update(schema.runSchedules)
        .set({ lastFireOutcome: "dispatching", lastFiredAt: newerStamp })
        .where(eq(schema.runSchedules.id, id));

      return { runId: randomUUID(), status: "Running" };
    });

    await dispatch.dispatchDueSchedules({ launch });

    const row = await scheduleRow(id);

    // The hung launch's result is dropped — the newer attempt keeps its
    // marker; without the last_fired_at fence the outcome ('dispatching')
    // would have been clobbered with the old attempt's run id.
    expect(row.lastFireOutcome).toBe("dispatching");
    expect(row.lastFiredAt?.getTime()).toBe(newerStamp.getTime());
    expect(row.lastRunId).toBeNull();
  });

  it("a schedule hard-deleted mid-launch is dropped quietly: the run launches, no outcome row remains", async () => {
    const seed = await seedBase();
    const id = await seedSchedule(seed);
    const launch = vi.fn(async () => {
      await db
        .delete(schema.runSchedules)
        .where(eq(schema.runSchedules.id, id));

      return { runId: randomUUID(), status: "Running" };
    });

    const summary = await dispatch.dispatchDueSchedules({ launch });

    // The launch counts as fired; the 0-row tx2 CAS is the documented
    // "stale dispatch result dropped" path, not an error.
    expect(summary.fired).toBe(1);
    expect(summary.launchFailed).toBe(0);

    const rows = await db
      .select()
      .from(schema.runSchedules)
      .where(eq(schema.runSchedules.id, id));

    expect(rows).toHaveLength(0);
  });

  it("never claims schedules of archived projects", async () => {
    const seed = await seedBase({ archivedProject: true });
    const id = await seedSchedule(seed);
    const launch = launchStub();

    const summary = await dispatch.dispatchDueSchedules({ launch });

    expect(launch).not.toHaveBeenCalled();
    expect(summary.fired).toBe(0);

    const row = await scheduleRow(id);

    expect(row.lastFireOutcome).toBeNull();
  });

  it("never claims disabled schedules on the due path", async () => {
    const seed = await seedBase();

    await seedSchedule(seed, { enabled: false });
    const launch = launchStub();

    const summary = await dispatch.dispatchDueSchedules({ launch });

    expect(launch).not.toHaveBeenCalled();
    expect(summary.fired).toBe(0);
  });

  it("target_terminal skip clears a pending catch-up flag; crashed keeps it", async () => {
    const doneSeed = await seedBase({ taskStatus: "Done" });
    const doneId = await seedSchedule(doneSeed, {
      overlapPolicy: "queue_one",
      queueOnePending: true,
      queuedFireAt: new Date(),
    });

    const crashedSeed = await seedBase();

    await seedRun(crashedSeed, "Crashed");
    const crashedId = await seedSchedule(crashedSeed, {
      overlapPolicy: "queue_one",
      queueOnePending: true,
      queuedFireAt: new Date(),
    });

    const launch = launchStub();
    const summary = await dispatch.dispatchDueSchedules({ launch });

    expect(launch).not.toHaveBeenCalled();
    expect(summary.skippedTerminal).toBe(2);

    const doneRow = await scheduleRow(doneId);

    expect(doneRow.lastFireOutcome).toBe("skipped_target_terminal");
    expect(doneRow.queueOnePending).toBe(false);

    const crashedRow = await scheduleRow(crashedId);

    expect(crashedRow.lastFireOutcome).toBe("skipped_crashed");
    expect(crashedRow.queueOnePending).toBe(true);

    await db
      .delete(schema.runSchedules)
      .where(eq(schema.runSchedules.id, crashedId));
  });
});

describe("dispatchScheduleNow", () => {
  it("launches immediately without advancing next_fire_at, with the clicking user's id", async () => {
    const seed = await seedBase();
    const futureFire = new Date(Date.now() + 60 * MIN);
    const id = await seedSchedule(seed, { nextFireAt: futureFire });
    const launch = launchStub();

    const result = await dispatch.dispatchScheduleNow(id, {
      actorUserId: seed.userId,
      launch,
    });

    expect(result.outcome).toBe("launched");
    expect(result.runId).toBeDefined();
    expect(launch).toHaveBeenCalledWith(
      { taskId: seed.taskId, runnerId: undefined },
      expect.objectContaining({ actorUserId: seed.userId }),
    );

    const row = await scheduleRow(id);

    expect(row.nextFireAt.getTime()).toBe(futureFire.getTime());
    expect(row.lastFireOutcome).toBe("launched");
  });

  it("is allowed on a paused schedule", async () => {
    const seed = await seedBase();
    const id = await seedSchedule(seed, {
      enabled: false,
      nextFireAt: new Date(Date.now() + 60 * MIN),
    });
    const launch = launchStub();

    const result = await dispatch.dispatchScheduleNow(id, {
      actorUserId: seed.userId,
      launch,
    });

    expect(result.outcome).toBe("launched");
  });

  it("respects the overlap policy: busy task yields skipped_task_busy without launching", async () => {
    const seed = await seedBase();

    await seedRun(seed, "Running");
    const id = await seedSchedule(seed, {
      nextFireAt: new Date(Date.now() + 60 * MIN),
    });
    const launch = launchStub();

    const result = await dispatch.dispatchScheduleNow(id, {
      actorUserId: seed.userId,
      launch,
    });

    expect(result.outcome).toBe("skipped_task_busy");
    expect(launch).not.toHaveBeenCalled();

    await db
      .delete(schema.runs)
      .where(eq(schema.runs.projectId, seed.projectId));
  });

  it("refuses with CONFLICT while a fresh 'dispatching' is in flight; a stale one fires", async () => {
    const seed = await seedBase();
    const fresh = await seedSchedule(seed, {
      lastFireOutcome: "dispatching",
      lastFiredAt: new Date(Date.now() - 10_000),
      nextFireAt: new Date(Date.now() + 60 * MIN),
    });
    const launch = launchStub();

    const err = await dispatch
      .dispatchScheduleNow(fresh, { actorUserId: seed.userId, launch })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(MaisterError);
    expect((err as MaisterError).code).toBe("CONFLICT");
    expect(launch).not.toHaveBeenCalled();

    const staleSeed = await seedBase();
    const stale = await seedSchedule(staleSeed, {
      lastFireOutcome: "dispatching",
      lastFiredAt: new Date(Date.now() - 400_000),
      nextFireAt: new Date(Date.now() + 60 * MIN),
    });

    const result = await dispatch.dispatchScheduleNow(stale, {
      actorUserId: staleSeed.userId,
      launch,
    });

    expect(result.outcome).toBe("launched");
  });

  it("returns launch_failed with the MaisterError code instead of throwing", async () => {
    const seed = await seedBase();
    const id = await seedSchedule(seed, {
      nextFireAt: new Date(Date.now() + 60 * MIN),
    });
    const launch = vi.fn(async () => {
      throw new MaisterError("EXECUTOR_UNAVAILABLE", "supervisor down");
    });

    const result = await dispatch.dispatchScheduleNow(id, {
      actorUserId: seed.userId,
      launch,
    });

    expect(result.outcome).toBe("launch_failed");
    expect(result.errorCode).toBe("EXECUTOR_UNAVAILABLE");

    const row = await scheduleRow(id);

    expect(row.lastFireOutcome).toBe("launch_failed");
    expect(row.lastFireError).toBe("EXECUTOR_UNAVAILABLE: supervisor down");
  });

  it("racing the tick on the same due row produces exactly one launch", async () => {
    const seed = await seedBase();
    const id = await seedSchedule(seed);
    const launch = launchStub();

    const [, triggerOutcome] = await Promise.all([
      dispatch.dispatchDueSchedules({ launch }),
      dispatch
        .dispatchScheduleNow(id, { actorUserId: seed.userId, launch })
        .then(
          (r) => r.outcome,
          (e: unknown) =>
            e instanceof MaisterError && e.code === "CONFLICT"
              ? "conflict"
              : Promise.reject(e),
        ),
    ]);

    expect(launch).toHaveBeenCalledTimes(1);
    expect(["conflict", "skipped_task_busy", "launched"]).toContain(
      triggerOutcome,
    );
  });
});
