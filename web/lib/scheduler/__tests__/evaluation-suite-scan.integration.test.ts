import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { createSuite } from "@/lib/evaluations/suites";
import {
  claimDueJobs,
  ensureDefaultSchedulerJobs,
  type ClaimDueJobsInput,
} from "@/lib/scheduler/jobs";
import { runSchedulerTick } from "@/lib/scheduler/tick-service";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// =============================================================================
// T7.2 (ADR-147): the evaluation_suite_scan singleton joins the scheduler the
// same way evaluation_dispatch.dispatcher did — self-healing seed, 60s cadence,
// budget-1 single claim, and a tick that drives runEvaluationSuiteScan for
// every enabled suite (the deferred M24 clock arm).
// =============================================================================

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

const schema = fullSchema as unknown as Record<string, any>;

type SchedulerTestDb = NonNullable<ClaimDueJobsInput["db"]>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof fullSchema>;
let schedulerDb: SchedulerTestDb;
let projectId: string;
let flowId: string;

async function makeTask(): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.tasks).values({
    number: Number.parseInt(randomUUID().slice(0, 6), 16),
    id,
    projectId,
    title: "T",
    prompt: "p",
    flowId,
  });

  return id;
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "scheduler_evaluation_suite_scan_test",
  });
  db = testDatabase.db;
  schedulerDb = db as unknown as SchedulerTestDb;

  projectId = randomUUID();
  flowId = randomUUID();

  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug: `suite-${projectId.slice(0, 8)}`,
    name: "Suite scan",
    repoPath: `/tmp/suite-${projectId.slice(0, 8)}`,
    maisterYamlPath: "/tmp/m.yaml",
  });
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/bugfix",
    manifest: { schemaVersion: 1, name: "Bugfix", nodes: [] },
    schemaVersion: 1,
  });
}, 180_000);

afterEach(async () => {
  await db.delete(schema.evaluationSuiteStudies);
  await db.delete(schema.evaluationSuites);
  await db.delete(schema.evaluationStudies);
  await db.delete(schema.schedulerJobRuns);
  await db.delete(schema.schedulerJobs);
});

afterAll(async () => {
  await testDatabase?.stop();
});

describe("evaluation_suite_scan scheduler integration", () => {
  it("seeds exactly one evaluation_suite_scan.dispatcher job at 60s cadence", async () => {
    const now = new Date("2026-07-17T10:00:00.000Z");

    await ensureDefaultSchedulerJobs({ now, db: schedulerDb });
    await ensureDefaultSchedulerJobs({ now, db: schedulerDb });

    const rows = await db
      .select()
      .from(schema.schedulerJobs)
      .where(eq(schema.schedulerJobs.jobKind, "evaluation_suite_scan"));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "evaluation_suite_scan.dispatcher",
      jobKind: "evaluation_suite_scan",
      cadenceIntervalSeconds: 60,
      nextRunAt: now,
    });
  });

  it("claims the seeded dispatcher exactly once under two concurrent ticks", async () => {
    const now = new Date("2026-07-17T10:00:00.000Z");

    await ensureDefaultSchedulerJobs({ now, db: schedulerDb });

    const [first, second] = await Promise.all([
      claimDueJobs({ now, jobKind: "evaluation_suite_scan", db: schedulerDb }),
      claimDueJobs({ now, jobKind: "evaluation_suite_scan", db: schedulerDb }),
    ]);

    const claimed = [...first, ...second].filter(
      (job) => job.jobKind === "evaluation_suite_scan",
    );

    expect(claimed).toHaveLength(1);
    expect(claimed[0].id).toBe("evaluation_suite_scan.dispatcher");
  });

  it("runs a due suite scan end-to-end through the scheduler tick", async () => {
    const taskIds = [await makeTask(), await makeTask()];
    const suite = await createSuite(
      {
        projectId,
        name: "Nightly",
        definition: { taskIds, profileId: "prof-1" },
      },
      db,
    );

    const tick = await runSchedulerTick({ jobKind: "evaluation_suite_scan" });

    expect(tick).toMatchObject({
      claimedCount: 1,
      succeededCount: 1,
      failedCount: 0,
    });
    expect(tick.attempts).toContainEqual(
      expect.objectContaining({
        jobId: "evaluation_suite_scan.dispatcher",
        jobKind: "evaluation_suite_scan",
        status: "Succeeded",
      }),
    );

    // The claimed job actually drove the suite scan: one one-task Study per
    // definition task, linked to the suite's scan round.
    const links = await db
      .select({ taskId: schema.evaluationSuiteStudies.taskId })
      .from(schema.evaluationSuiteStudies)
      .where(eq(schema.evaluationSuiteStudies.suiteId, suite.id as string));

    expect(links.map((l: { taskId: string }) => l.taskId).sort()).toEqual(
      [...taskIds].sort(),
    );

    const [attempt] = await db
      .select()
      .from(schema.schedulerJobRuns)
      .where(
        eq(schema.schedulerJobRuns.jobId, "evaluation_suite_scan.dispatcher"),
      );

    expect(attempt.status).toBe("Succeeded");
    expect(attempt.summary).toMatchObject({
      scannedSuites: 1,
      generatedStudies: 2,
      failedSuites: 0,
    });
  });
});
