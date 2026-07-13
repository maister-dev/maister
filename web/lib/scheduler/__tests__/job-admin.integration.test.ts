import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { listSchedulerStatusRows } from "@/lib/queries/scheduler";
import {
  createSchedulerJob,
  deleteSchedulerJob,
  updateSchedulerJob,
} from "@/lib/scheduler/job-admin";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let db: NodePgDatabase;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "scheduler_admin_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

async function clearJobs(): Promise<void> {
  await pool.query("DELETE FROM scheduler_jobs");
}

describe("scheduler job admin service integration", () => {
  beforeEach(async () => {
    await clearJobs();
  });

  it("creates a job that surfaces in the status list", async () => {
    await createSchedulerJob(
      {
        id: "sweep-1",
        jobKind: "system_sweep",
        cadenceIntervalSeconds: 120,
      },
      db,
    );

    const rows = await listSchedulerStatusRows({ db });
    const row = rows.find((r) => r.id === "sweep-1");

    expect(row).toBeDefined();
    expect(row?.jobKind).toBe("system_sweep");
    expect(row?.cadenceIntervalSeconds).toBe(120);
    expect(row?.maxFailures).toBe(3);
    expect(row?.disabledAt).toBeNull();
  });

  it("defaults agent_tick max_failures from the env knob", async () => {
    process.env.MAISTER_SCHEDULER_AGENT_TICK_MAX_FAILURES = "5";

    await createSchedulerJob(
      { id: "agent-1", jobKind: "agent_tick", cadenceIntervalSeconds: 60 },
      db,
    );

    const rows = await listSchedulerStatusRows({ db });

    expect(rows.find((r) => r.id === "agent-1")?.maxFailures).toBe(5);

    delete process.env.MAISTER_SCHEDULER_AGENT_TICK_MAX_FAILURES;
  });

  it("rejects a command job with a malformed target", async () => {
    await expect(
      createSchedulerJob(
        {
          id: "bad-cmd",
          jobKind: "command",
          target: { commandKind: "http_ping" },
          cadenceIntervalSeconds: 60,
        },
        db,
      ),
    ).rejects.toMatchObject({ code: "CONFIG" });
  });

  it("refuses a duplicate job id with CONFLICT", async () => {
    await createSchedulerJob(
      { id: "dup", jobKind: "system_sweep", cadenceIntervalSeconds: 60 },
      db,
    );

    await expect(
      createSchedulerJob(
        { id: "dup", jobKind: "system_sweep", cadenceIntervalSeconds: 60 },
        db,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("disables then re-enables a job, resetting consecutive failures", async () => {
    await createSchedulerJob(
      { id: "toggle", jobKind: "system_sweep", cadenceIntervalSeconds: 60 },
      db,
    );
    await pool.query(
      "UPDATE scheduler_jobs SET consecutive_failures = 2 WHERE id = 'toggle'",
    );

    await updateSchedulerJob("toggle", { enabled: false }, db);
    let row = (await listSchedulerStatusRows({ db })).find(
      (r) => r.id === "toggle",
    );

    expect(row?.disabledAt).not.toBeNull();

    await updateSchedulerJob("toggle", { enabled: true }, db);
    row = (await listSchedulerStatusRows({ db })).find(
      (r) => r.id === "toggle",
    );

    expect(row?.disabledAt).toBeNull();
    expect(row?.consecutiveFailures).toBe(0);
  });

  it("updates cadence and rejects a not-found update", async () => {
    await createSchedulerJob(
      { id: "cad", jobKind: "system_sweep", cadenceIntervalSeconds: 60 },
      db,
    );

    await updateSchedulerJob("cad", { cadenceIntervalSeconds: 900 }, db);
    const row = (await listSchedulerStatusRows({ db })).find(
      (r) => r.id === "cad",
    );

    expect(row?.cadenceIntervalSeconds).toBe(900);

    await expect(
      updateSchedulerJob("missing", { cadenceIntervalSeconds: 30 }, db),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  it("deletes a job and then reports not found", async () => {
    await createSchedulerJob(
      { id: "del", jobKind: "system_sweep", cadenceIntervalSeconds: 60 },
      db,
    );

    await deleteSchedulerJob("del", db);

    expect(
      (await listSchedulerStatusRows({ db })).find((r) => r.id === "del"),
    ).toBeUndefined();
    await expect(deleteSchedulerJob("del", db)).rejects.toMatchObject({
      code: "PRECONDITION",
    });
  });

  it("keeps a project delivery scanner system-managed", async () => {
    await db.insert(schema.schedulerJobs).values({
      id: "repo_delivery_scan.project-1",
      jobKind: "repo_delivery_scan",
      target: { projectId: "project-1" },
      cadenceIntervalSeconds: 3_600,
      nextRunAt: new Date(),
      maxFailures: 3,
    });

    await expect(
      deleteSchedulerJob("repo_delivery_scan.project-1", db),
    ).rejects.toMatchObject({ code: "PRECONDITION" });

    const rows = await listSchedulerStatusRows({ db });

    expect(rows.some((row) => row.id === "repo_delivery_scan.project-1")).toBe(
      true,
    );
  });
});
