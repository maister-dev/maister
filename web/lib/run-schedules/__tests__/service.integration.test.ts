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
let service: typeof import("@/lib/run-schedules/service");
let queries: typeof import("@/lib/run-schedules/queries");

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("run_schedules_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool, { schema });

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  service = await import("@/lib/run-schedules/service");
  queries = await import("@/lib/run-schedules/queries");
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

type SeedResult = {
  projectId: string;
  flowId: string;
  taskId: string;
  runnerId: string;
  userId: string;
  taskTitle: string;
};

async function seedBase(
  opts: { taskStatus?: "Backlog" | "Done" | "Abandoned" } = {},
): Promise<SeedResult> {
  const projectId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runnerId = randomUUID();
  const userId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;
  const taskTitle = `task-${taskId.slice(0, 8)}`;

  await db.insert(schema.users).values({
    id: userId,
    email: `${userId}@test.local`,
  });
  await db.insert(schema.projects).values({
    id: projectId,
    slug,
    name: "Run Schedules Test",
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
  });
  await db.insert(schema.platformAcpRunners).values({
    id: runnerId,
    adapter: "claude",
    capabilityAgent: "claude",
    model: "claude-sonnet-4-6",
    provider: { kind: "anthropic" },
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
    title: taskTitle,
    prompt: "p",
    flowId,
    status: opts.taskStatus ?? "Backlog",
  });

  return { projectId, flowId, taskId, runnerId, userId, taskTitle };
}

function baseInput(seed: SeedResult) {
  return {
    projectId: seed.projectId,
    taskId: seed.taskId,
    name: "nightly",
    cronExpr: "*/5 * * * *",
    timezone: "UTC",
    actorUserId: seed.userId,
  };
}

async function scheduleRow(id: string): Promise<schema.RunSchedule> {
  const rows = await db
    .select()
    .from(schema.runSchedules)
    .where(eq(schema.runSchedules.id, id));

  expect(rows).toHaveLength(1);

  return rows[0];
}

async function expectCode(
  promise: Promise<unknown>,
  code: "PRECONDITION" | "CONFIG",
): Promise<void> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );

  expect(err).toBeInstanceOf(MaisterError);
  expect((err as MaisterError).code).toBe(code);
}

describe("run-schedule service (integration)", () => {
  it("createSchedule persists the row with defaults, future next_fire_at, and created_by", async () => {
    const seed = await seedBase();
    const before = new Date();
    const created = await service.createSchedule(baseInput(seed));

    expect(created.projectId).toBe(seed.projectId);
    expect(created.taskId).toBe(seed.taskId);
    expect(created.name).toBe("nightly");
    expect(created.cronExpr).toBe("*/5 * * * *");
    expect(created.timezone).toBe("UTC");
    expect(created.overlapPolicy).toBe("skip");
    expect(created.enabled).toBe(true);
    expect(created.runnerId).toBeNull();
    expect(created.createdByUserId).toBe(seed.userId);
    expect(created.queueOnePending).toBe(false);
    expect(created.queuedFireAt).toBeNull();
    expect(created.lastFiredAt).toBeNull();
    expect(created.nextFireAt.getTime()).toBeGreaterThan(before.getTime());

    const row = await scheduleRow(created.id);

    expect(row.nextFireAt.getTime()).toBe(created.nextFireAt.getTime());

    const fetched = await service.getScheduleForProject(
      seed.projectId,
      created.id,
    );

    expect(fetched?.id).toBe(created.id);
  });

  it("createSchedule rejects cross-project task, terminal (Done/Abandoned) task, bad cron, bad timezone, unknown runner", async () => {
    const seed = await seedBase();
    const foreign = await seedBase();
    const abandoned = await seedBase({ taskStatus: "Abandoned" });
    const done = await seedBase({ taskStatus: "Done" });

    await expectCode(
      service.createSchedule({ ...baseInput(seed), taskId: foreign.taskId }),
      "PRECONDITION",
    );
    await expectCode(
      service.createSchedule(baseInput(abandoned)),
      "PRECONDITION",
    );
    await expectCode(service.createSchedule(baseInput(done)), "PRECONDITION");
    await expectCode(
      service.createSchedule({ ...baseInput(seed), cronExpr: "not a cron" }),
      "CONFIG",
    );
    await expectCode(
      service.createSchedule({
        ...baseInput(seed),
        timezone: "Mars/Olympus_Mons",
      }),
      "CONFIG",
    );
    await expectCode(
      service.createSchedule({
        ...baseInput(seed),
        runnerId: "no-such-runner",
      }),
      "CONFIG",
    );

    const rows = await db
      .select()
      .from(schema.runSchedules)
      .where(eq(schema.runSchedules.projectId, seed.projectId));

    expect(rows).toHaveLength(0);
  });

  it("updateSchedule runnerId round-trips SET, CLEAR with explicit null, and RE-SET", async () => {
    const seed = await seedBase();
    const actor = { actorUserId: seed.userId };
    const created = await service.createSchedule(baseInput(seed));

    expect(created.runnerId).toBeNull();

    const set = await service.updateSchedule(
      seed.projectId,
      created.id,
      { runnerId: seed.runnerId },
      actor,
    );

    expect(set?.runnerId).toBe(seed.runnerId);
    expect((await scheduleRow(created.id)).runnerId).toBe(seed.runnerId);

    const cleared = await service.updateSchedule(
      seed.projectId,
      created.id,
      { runnerId: null },
      actor,
    );

    expect(cleared?.runnerId).toBeNull();
    expect((await scheduleRow(created.id)).runnerId).toBeNull();

    const reset = await service.updateSchedule(
      seed.projectId,
      created.id,
      { runnerId: seed.runnerId },
      actor,
    );

    expect(reset?.runnerId).toBe(seed.runnerId);
    expect((await scheduleRow(created.id)).runnerId).toBe(seed.runnerId);

    const untouched = await service.updateSchedule(
      seed.projectId,
      created.id,
      { name: "renamed" },
      actor,
    );

    expect(untouched?.runnerId).toBe(seed.runnerId);
  });

  it("pause (enabled:false) clears queue_one_pending and queued_fire_at", async () => {
    const seed = await seedBase();
    const created = await service.createSchedule(baseInput(seed));

    await db
      .update(schema.runSchedules)
      .set({
        queueOnePending: true,
        queuedFireAt: new Date("2026-06-09T10:00:00.000Z"),
      })
      .where(eq(schema.runSchedules.id, created.id));

    const paused = await service.updateSchedule(
      seed.projectId,
      created.id,
      { enabled: false },
      { actorUserId: seed.userId },
    );

    expect(paused?.enabled).toBe(false);
    expect(paused?.queueOnePending).toBe(false);
    expect(paused?.queuedFireAt).toBeNull();
  });

  it("resume (enabled:true) recomputes next_fire_at from now", async () => {
    const seed = await seedBase();
    const created = await service.createSchedule(baseInput(seed));
    const past = new Date("2026-01-01T00:00:00.000Z");

    await db
      .update(schema.runSchedules)
      .set({ enabled: false, nextFireAt: past })
      .where(eq(schema.runSchedules.id, created.id));

    const before = new Date();
    const resumed = await service.updateSchedule(
      seed.projectId,
      created.id,
      { enabled: true },
      { actorUserId: seed.userId },
    );

    expect(resumed?.enabled).toBe(true);
    expect(resumed?.nextFireAt.getTime()).toBeGreaterThan(before.getTime());
  });

  it("a redundant enabled:true on an already-active schedule does NOT re-arm next_fire_at", async () => {
    const seed = await seedBase();
    const created = await service.createSchedule(baseInput(seed));
    const due = new Date(Date.now() - 60_000);

    await db
      .update(schema.runSchedules)
      .set({ nextFireAt: due })
      .where(eq(schema.runSchedules.id, created.id));

    const updated = await service.updateSchedule(
      seed.projectId,
      created.id,
      { name: "renamed", enabled: true },
      { actorUserId: seed.userId },
    );

    expect(updated?.name).toBe("renamed");
    expect(updated?.enabled).toBe(true);
    // The due fire stays due — only the Paused→Active transition re-arms.
    expect(updated?.nextFireAt.getTime()).toBe(due.getTime());
  });

  it("cron/timezone change recomputes next_fire_at; a name-only patch does not", async () => {
    const seed = await seedBase();
    const actor = { actorUserId: seed.userId };
    const created = await service.createSchedule(baseInput(seed));
    const pinnedFireAt = new Date("2026-01-01T00:00:00.000Z");
    const pinnedUpdatedAt = new Date("2026-01-01T00:00:00.000Z");

    await db
      .update(schema.runSchedules)
      .set({ nextFireAt: pinnedFireAt, updatedAt: pinnedUpdatedAt })
      .where(eq(schema.runSchedules.id, created.id));

    const renamed = await service.updateSchedule(
      seed.projectId,
      created.id,
      { name: "renamed" },
      actor,
    );

    expect(renamed?.name).toBe("renamed");
    expect(renamed?.nextFireAt.getTime()).toBe(pinnedFireAt.getTime());
    expect(renamed?.updatedAt.getTime()).toBeGreaterThan(
      pinnedUpdatedAt.getTime(),
    );

    const beforeCronChange = new Date();
    const cronChanged = await service.updateSchedule(
      seed.projectId,
      created.id,
      { cronExpr: "0 12 * * *" },
      actor,
    );

    expect(cronChanged?.cronExpr).toBe("0 12 * * *");
    expect(cronChanged?.nextFireAt.getTime()).toBeGreaterThan(
      beforeCronChange.getTime(),
    );

    await db
      .update(schema.runSchedules)
      .set({ nextFireAt: pinnedFireAt })
      .where(eq(schema.runSchedules.id, created.id));

    const beforeTzChange = new Date();
    const tzChanged = await service.updateSchedule(
      seed.projectId,
      created.id,
      { timezone: "Europe/Berlin" },
      actor,
    );

    expect(tzChanged?.timezone).toBe("Europe/Berlin");
    expect(tzChanged?.nextFireAt.getTime()).toBeGreaterThan(
      beforeTzChange.getTime(),
    );

    await expectCode(
      service.updateSchedule(
        seed.projectId,
        created.id,
        { cronExpr: "not a cron" },
        actor,
      ),
      "CONFIG",
    );
  });

  it("updateSchedule and deleteSchedule with a foreign projectId return null/false and change nothing", async () => {
    const seed = await seedBase();
    const foreign = await seedBase();
    const created = await service.createSchedule(baseInput(seed));

    const updated = await service.updateSchedule(
      foreign.projectId,
      created.id,
      { name: "hijacked" },
      { actorUserId: foreign.userId },
    );

    expect(updated).toBeNull();

    const deleted = await service.deleteSchedule(
      foreign.projectId,
      created.id,
      {
        actorUserId: foreign.userId,
      },
    );

    expect(deleted).toBe(false);

    const row = await scheduleRow(created.id);

    expect(row.name).toBe("nightly");
    expect(
      await service.getScheduleForProject(foreign.projectId, created.id),
    ).toBeNull();
  });

  it("deleteSchedule removes the row and listProjectSchedules omits it", async () => {
    const seed = await seedBase();
    const keep = await service.createSchedule({
      ...baseInput(seed),
      name: "keep",
    });
    const drop = await service.createSchedule({
      ...baseInput(seed),
      name: "drop",
    });

    await db
      .update(schema.runSchedules)
      .set({ createdAt: new Date("2026-01-01T00:00:00.000Z") })
      .where(eq(schema.runSchedules.id, keep.id));
    await db
      .update(schema.runSchedules)
      .set({ createdAt: new Date("2026-01-02T00:00:00.000Z") })
      .where(eq(schema.runSchedules.id, drop.id));

    const beforeDelete = await queries.listProjectSchedules(seed.projectId);

    expect(beforeDelete.map((s) => s.id)).toEqual([keep.id, drop.id]);

    const deleted = await service.deleteSchedule(seed.projectId, drop.id, {
      actorUserId: seed.userId,
    });

    expect(deleted).toBe(true);

    const afterDelete = await queries.listProjectSchedules(seed.projectId);

    expect(afterDelete.map((s) => s.id)).toEqual([keep.id]);
  });

  it("listProjectSchedules projects the exact DTO with task title and last run status", async () => {
    const seed = await seedBase();
    const created = await service.createSchedule({
      ...baseInput(seed),
      runnerId: seed.runnerId,
    });

    const [dto] = await queries.listProjectSchedules(seed.projectId);
    const expectedKeys = [
      "id",
      "name",
      "taskId",
      "taskTitle",
      "cronExpr",
      "timezone",
      "overlapPolicy",
      "runnerId",
      "enabled",
      "nextFireAt",
      "queueOnePending",
      "queuedFireAt",
      "lastFiredAt",
      "lastFireOutcome",
      "lastFireError",
      "lastRunId",
      "lastRunStatus",
      "createdAt",
      "updatedAt",
    ].sort();

    expect(Object.keys(dto).sort()).toEqual(expectedKeys);
    expect(dto.id).toBe(created.id);
    expect(dto.taskId).toBe(seed.taskId);
    expect(dto.taskTitle).toBe(seed.taskTitle);
    expect(dto.runnerId).toBe(seed.runnerId);
    expect(dto.lastRunId).toBeNull();
    expect(dto.lastRunStatus).toBeNull();
    expect(dto.lastFiredAt).toBeNull();
    expect(dto.queuedFireAt).toBeNull();
    expect(dto.nextFireAt).toBe(new Date(dto.nextFireAt).toISOString());
    expect(dto.createdAt).toBe(new Date(dto.createdAt).toISOString());
    expect(dto.updatedAt).toBe(new Date(dto.updatedAt).toISOString());

    const runId = randomUUID();

    await db.insert(schema.runs).values({
      id: runId,
      projectId: seed.projectId,
      taskId: seed.taskId,
      flowId: seed.flowId,
      status: "Review",
      flowVersion: "v1.0.0",
    });
    await db
      .update(schema.runSchedules)
      .set({
        lastRunId: runId,
        lastFiredAt: new Date("2026-06-09T10:00:00.000Z"),
        lastFireOutcome: "launched",
      })
      .where(eq(schema.runSchedules.id, created.id));

    const [withRun] = await queries.listProjectSchedules(seed.projectId);

    expect(withRun.lastRunId).toBe(runId);
    expect(withRun.lastRunStatus).toBe("Review");
    expect(withRun.lastFireOutcome).toBe("launched");
    expect(withRun.lastFiredAt).toBe("2026-06-09T10:00:00.000Z");
  });
});
