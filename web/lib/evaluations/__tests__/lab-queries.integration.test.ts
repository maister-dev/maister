import { randomUUID } from "node:crypto";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  listComparableTaskRuns,
  listEnabledProfiles,
  listStudyExecutions,
} from "@/lib/evaluations/lab-queries";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof fullSchema>;
let studyId: string;
let taskId: string;
let flowRunId: string;
let completedExecId: string;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_eval_lab_queries_test",
  });
  db = testDatabase.db;

  const projectId = randomUUID();
  const flowId = randomUUID();
  const executorId = randomUUID();

  taskId = randomUUID();

  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug: `proj-${projectId.slice(0, 8)}`,
    name: "Test",
    repoPath: `/tmp/proj-${projectId.slice(0, 8)}`,
    maisterYamlPath: "/tmp/m.yaml",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
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
  await db.insert(schema.tasks).values({
    number: Number.parseInt(randomUUID().slice(0, 6), 16),
    id: taskId,
    projectId,
    title: "T",
    prompt: "p",
    flowId,
  });

  flowRunId = randomUUID();
  const scratchRunId = randomUUID();

  await db.insert(schema.runs).values([
    {
      id: flowRunId,
      taskId,
      projectId,
      flowId,
      runnerId: executorId,
      capabilityAgent: "claude",
      flowVersion: "v1.0.0",
      runKind: "flow",
      status: "Done",
    },
    {
      id: scratchRunId,
      taskId,
      projectId,
      flowId,
      runnerId: executorId,
      capabilityAgent: "claude",
      flowVersion: "v1.0.0",
      runKind: "scratch",
      status: "Done",
    },
  ]);

  studyId = randomUUID();
  await db.insert(schema.evaluationStudies).values({
    id: studyId,
    projectId,
    taskId,
    title: "Study",
    status: "open",
  });

  completedExecId = randomUUID();
  const queuedExecId = randomUUID();

  await db.insert(schema.evaluationExecutions).values([
    { id: completedExecId, studyId, status: "completed" },
    { id: queuedExecId, studyId, status: "queued" },
  ]);
  await db.insert(schema.evaluationAggregateResults).values({
    executionId: completedExecId,
    algorithmId: "weighted_mean",
    algorithmVersion: "1",
    inputs: {},
    calculations: {},
    displayValues: {
      displayTotal: 4.2,
      perCriterion: [{ criterionId: "correctness", displayValue: 4.5 }],
    },
    dispersion: { level: "low" },
    warnings: [],
    digest: "d",
  });

  await db.insert(schema.evaluationJudgePanels).values({
    id: randomUUID(),
    name: "P",
    roleBindings: [{ role: "reviewer", agentId: "core:sdd-judge" }],
    policy: {},
    enabled: true,
  });
  const installId = randomUUID();

  await db.insert(schema.packageInstalls).values({
    id: installId,
    sourceUrl: "github.com/x/core",
    name: "core",
    versionLabel: "v1.1.0",
    resolvedRevision: "d",
    manifest: {},
    manifestDigest: "d",
    installedPath: "/tmp/core",
    packageStatus: "Installed",
    trustStatus: "trusted",
  });
  const methodRevId = randomUUID();

  await db.insert(schema.evaluationMethodRevisions).values({
    id: methodRevId,
    packageInstallId: installId,
    methodId: "sdd-quality",
    qualifiedId: "core:sdd-quality",
    packageName: "core",
    versionLabel: "v1.1.0",
    schemaVersion: 1,
    normalizedDefinition: {},
    definitionDigest: "d",
    promptDigest: "d",
    schemaDigest: "d",
    compat: { engineMin: "3.2.0" },
    activation: "enabled",
  });
  const panelId = randomUUID();

  await db.insert(schema.evaluationJudgePanels).values({
    id: panelId,
    name: "Panel2",
    roleBindings: [{ role: "reviewer", agentId: "core:sdd-judge" }],
    policy: {},
    enabled: true,
  });
  await db.insert(schema.evaluationProfiles).values([
    {
      id: randomUUID(),
      name: "Enabled Profile",
      methodRevisionId: methodRevId,
      panelId,
      enabled: true,
    },
    {
      id: randomUUID(),
      name: "Disabled Profile",
      methodRevisionId: methodRevId,
      panelId,
      enabled: false,
    },
  ]);
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("lab-queries", () => {
  it("lists study executions newest-first with the aggregate scoreboard", async () => {
    const executions = await listStudyExecutions(studyId, db);

    expect(executions).toHaveLength(2);
    const completed = executions.find((e) => e.id === completedExecId);

    expect(completed?.status).toBe("completed");
    expect(completed?.methodQualifiedId).toBeNull(); // no method revision on this exec
    expect(completed?.aggregate?.displayTotal).toBe(4.2);
    expect(completed?.aggregate?.perCriterion).toEqual([
      { criterionId: "correctness", displayValue: 4.5 },
    ]);

    // The queued execution has no aggregate yet.
    const queued = executions.find((e) => e.status === "queued");

    expect(queued?.aggregate).toBeNull();
  });

  it("lists only enabled profiles", async () => {
    const profiles = await listEnabledProfiles(db);

    expect(profiles.map((p) => p.name)).toContain("Enabled Profile");
    expect(profiles.map((p) => p.name)).not.toContain("Disabled Profile");
  });

  it("lists only FLOW runs for the task as comparable candidates", async () => {
    const runs = await listComparableTaskRuns(taskId, db);

    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(flowRunId);
  });
});
