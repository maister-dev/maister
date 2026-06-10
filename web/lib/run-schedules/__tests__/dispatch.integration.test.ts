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

beforeAll(async () => {
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
