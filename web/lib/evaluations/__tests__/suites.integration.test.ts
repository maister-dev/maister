import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  computeSuiteLongitudinal,
  createSuite,
  runEvaluationSuiteScan,
} from "@/lib/evaluations/suites";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof fullSchema>;
let projectId: string;
let otherProjectId: string;
let flowId: string;

async function makeTask(project = projectId): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.tasks).values({
    number: Number.parseInt(randomUUID().slice(0, 6), 16),
    id,
    projectId: project,
    title: "T",
    prompt: "p",
    flowId,
  });

  return id;
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_eval_suites_test",
  });
  db = testDatabase.db;

  projectId = randomUUID();
  otherProjectId = randomUUID();
  flowId = randomUUID();

  for (const [pid, slug] of [
    [projectId, "proj"],
    [otherProjectId, "other"],
  ] as const) {
    await db.insert(schema.projects).values({
      taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
      id: pid,
      slug: `${slug}-${pid.slice(0, 8)}`,
      name: slug,
      repoPath: `/tmp/${slug}-${pid.slice(0, 8)}`,
      maisterYamlPath: "/tmp/m.yaml",
    });
  }
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

afterAll(async () => {
  await testDatabase?.stop();
});

describe("createSuite", () => {
  it("creates a versioned suite with a definition digest", async () => {
    const t1 = await makeTask();
    const suite = await createSuite(
      {
        projectId,
        name: "Nightly",
        definition: { taskIds: [t1], profileId: "prof-1" },
      },
      db,
    );

    expect(suite.version).toBe(1);
    expect(suite.definitionDigest).toBeTruthy();
    expect(suite.kind).toBe("scheduled");
  });

  it("rejects a task from another project (one project/task boundary)", async () => {
    const foreign = await makeTask(otherProjectId);

    await expect(
      createSuite(
        {
          projectId,
          name: "Bad",
          definition: { taskIds: [foreign], profileId: "prof-1" },
        },
        db,
      ),
    ).rejects.toThrow(/does not belong to project/);
  });
});

describe("runEvaluationSuiteScan", () => {
  it("generates one one-task Study per task and dedups a re-scan", async () => {
    const t1 = await makeTask();
    const t2 = await makeTask();
    const suite = await createSuite(
      {
        projectId,
        name: "Suite",
        definition: { taskIds: [t1, t2], profileId: "prof-1" },
      },
      db,
    );

    const first = await runEvaluationSuiteScan(suite.id as string, {}, db);

    expect(first.scanned).toBe(true);
    expect(first.generatedStudyIds).toHaveLength(2);

    // Each generated Study is bound to one project/task.
    const studies = await db
      .select()
      .from(schema.evaluationStudies)
      .where(eq(schema.evaluationStudies.projectId, projectId));
    const suiteStudies = studies.filter((s: Record<string, unknown>) =>
      (s.title as string).startsWith("Suite —"),
    );

    expect(suiteStudies).toHaveLength(2);

    // A re-scan of the same round generates nothing new (idempotent).
    const second = await runEvaluationSuiteScan(suite.id as string, {}, db);

    expect(second.generatedStudyIds).toHaveLength(0);
  });

  it("respects the per-tick cap (capped-scan progress)", async () => {
    const tasks = await Promise.all([makeTask(), makeTask(), makeTask()]);
    const suite = await createSuite(
      {
        projectId,
        name: "Capped",
        definition: { taskIds: tasks, profileId: "p" },
      },
      db,
    );

    const scan = await runEvaluationSuiteScan(
      suite.id as string,
      { cap: 2 },
      db,
    );

    expect(scan.generatedStudyIds).toHaveLength(2);
  });

  it("drains tasks past the cap on later ticks of the same round (no starvation)", async () => {
    const tasks = await Promise.all([makeTask(), makeTask(), makeTask()]);
    const suite = await createSuite(
      {
        projectId,
        name: "Drained",
        definition: { taskIds: tasks, profileId: "p" },
      },
      db,
    );

    const first = await runEvaluationSuiteScan(
      suite.id as string,
      { cap: 2 },
      db,
    );

    expect(first.generatedStudyIds).toHaveLength(2);

    // The SAME round (same scanKey): the second tick must reach the third task
    // instead of re-selecting and skipping the first capped slice forever.
    const second = await runEvaluationSuiteScan(
      suite.id as string,
      { cap: 2 },
      db,
    );

    expect(second.scanKey).toBe(first.scanKey);
    expect(second.generatedStudyIds).toHaveLength(1);

    const third = await runEvaluationSuiteScan(
      suite.id as string,
      { cap: 2 },
      db,
    );

    expect(third.generatedStudyIds).toHaveLength(0);

    const links = await db
      .select({ taskId: schema.evaluationSuiteStudies.taskId })
      .from(schema.evaluationSuiteStudies)
      .where(eq(schema.evaluationSuiteStudies.suiteId, suite.id as string));

    expect(links.map((l: { taskId: string }) => l.taskId).sort()).toEqual(
      [...tasks].sort(),
    );
  });

  it("is a no-op for a disabled suite", async () => {
    const t1 = await makeTask();
    const suite = await createSuite(
      { projectId, name: "Off", definition: { taskIds: [t1], profileId: "p" } },
      db,
    );

    await db
      .update(schema.evaluationSuites)
      .set({ enabled: false })
      .where(eq(schema.evaluationSuites.id, suite.id as string));

    const scan = await runEvaluationSuiteScan(suite.id as string, {}, db);

    expect(scan.scanned).toBe(false);
    expect(scan.reason).toBe("disabled");
  });

  it("regression suite skips an unchanged revision, scans on a change", async () => {
    const t1 = await makeTask();
    const suite = await createSuite(
      {
        projectId,
        name: "Regression",
        kind: "regression",
        definition: {
          taskIds: [t1],
          profileId: "p",
          triggerPackageRef: "core",
        },
      },
      db,
    );

    // First scan: revision "rev-1" differs from the null baseline → scans.
    const first = await runEvaluationSuiteScan(
      suite.id as string,
      { resolveTrigger: async () => "rev-1" },
      db,
    );

    expect(first.scanned).toBe(true);

    // Same revision → no-op (package-revision-change trigger).
    const same = await runEvaluationSuiteScan(
      suite.id as string,
      { resolveTrigger: async () => "rev-1" },
      db,
    );

    expect(same.scanned).toBe(false);
    expect(same.reason).toBe("unchanged_revision");

    // A revision change → scans again.
    const changed = await runEvaluationSuiteScan(
      suite.id as string,
      { resolveTrigger: async () => "rev-2" },
      db,
    );

    expect(changed.scanned).toBe(true);
  });
});

describe("computeSuiteLongitudinal", () => {
  it("aggregates immutable executions by scan round (counts only, no bodies)", async () => {
    const t1 = await makeTask();
    const suite = await createSuite(
      {
        projectId,
        name: "Longitudinal",
        definition: { taskIds: [t1], profileId: "p" },
      },
      db,
    );
    const scan = await runEvaluationSuiteScan(suite.id as string, {}, db);
    const studyId = scan.generatedStudyIds[0];

    // Seed two immutable executions for the generated study.
    await db.insert(schema.evaluationExecutions).values([
      { studyId, status: "completed" },
      { studyId, status: "partial" },
    ]);

    const rounds = await computeSuiteLongitudinal(suite.id as string, db);

    expect(rounds).toHaveLength(1);
    expect(rounds[0].studyCount).toBe(1);
    expect(rounds[0].executionCounts.completed).toBe(1);
    expect(rounds[0].executionCounts.partial).toBe(1);
    // Read model is counts + status labels + scan key only — no evidence bodies.
    expect(Object.keys(rounds[0])).toEqual([
      "scanKey",
      "suiteVersion",
      "studyCount",
      "executionCounts",
    ]);
  });
});
