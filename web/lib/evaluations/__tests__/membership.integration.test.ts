import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  isLaunchedEvaluationRun,
  isLaunchedLineageRun,
} from "@/lib/evaluations/membership";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof fullSchema>;

let projectId: string;
let executorId: string;
let flowId: string;
let taskId: string;

async function makeRun(): Promise<string> {
  const runId = randomUUID();

  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    runnerId: executorId,
    capabilityAgent: "claude",
    flowVersion: "v1.0.0",
  });

  return runId;
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_eval_membership_test",
  });
  db = testDatabase.db;

  projectId = randomUUID();
  executorId = randomUUID();
  flowId = randomUUID();
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
    manifest: {
      schemaVersion: 1,
      name: "Bugfix",
      nodes: [
        {
          id: "run",
          type: "cli",
          action: { command: "true" },
          transitions: { success: "done" },
        },
      ],
    },
    schemaVersion: 1,
  });
  await db.insert(schema.tasks).values({
    number: Number.parseInt(randomUUID().slice(0, 6), 16),
    id: taskId,
    projectId,
    title: "Test task",
    prompt: "do the thing",
    flowId,
  });
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("launched-lineage membership predicate", () => {
  it("distinguishes observed, launched-evaluation, legacy-experiment, and plain runs", async () => {
    const observedRun = await makeRun();
    const launchedRun = await makeRun();
    const experimentRun = await makeRun();
    const plainRun = await makeRun();

    // A Study with an observed participant (observedRun) and a launched
    // participant (launchedRun via a recipe).
    const studyId = randomUUID();

    await db.insert(schema.evaluationStudies).values({
      id: studyId,
      projectId,
      taskId,
      title: "S",
      status: "open",
    });
    const recipeId = randomUUID();

    await db.insert(schema.evaluationRecipes).values({
      id: recipeId,
      studyId,
      key: "recipe-a",
      label: "A",
      definition: {},
      definitionDigest: "d",
    });
    await db.insert(schema.evaluationParticipants).values({
      id: randomUUID(),
      studyId,
      runId: observedRun,
      sourceType: "observed",
      label: "observed",
    });
    const launchedParticipantId = randomUUID();

    await db.insert(schema.evaluationParticipants).values({
      id: launchedParticipantId,
      studyId,
      runId: launchedRun,
      sourceType: "launched",
      recipeId,
      label: "launched",
      launchReason: "initial",
      replicateOrdinal: 1,
    });

    // A legacy Experiment member (experimentRun).
    const experimentId = randomUUID();

    await db.insert(schema.experiments).values({
      id: experimentId,
      projectId,
      taskId,
      title: "E",
      baseBranch: "main",
      baseCommit: "abc",
      variants: [{ key: "A", label: "A", config: {} }],
      rubric: { criteria: [] },
    });
    await db.insert(schema.experimentRuns).values({
      id: randomUUID(),
      experimentId,
      runId: experimentRun,
      variantKey: "A",
      replicateOrdinal: 1,
      launchReason: "initial",
      baseCommit: "abc",
    });

    // isLaunchedEvaluationRun: only the launched participant. A raw legacy
    // experiment member (pre-backfill) has no launched participant yet.
    expect(await isLaunchedEvaluationRun(db, launchedRun)).toBe(true);
    expect(await isLaunchedEvaluationRun(db, observedRun)).toBe(false);
    expect(await isLaunchedEvaluationRun(db, experimentRun)).toBe(false);

    // ADR-149: isLaunchedLineageRun no longer reads experiment_runs directly —
    // a raw legacy member (not yet backfilled) is NOT launched-lineage.
    expect(await isLaunchedLineageRun(db, launchedRun)).toBe(true);
    expect(await isLaunchedLineageRun(db, experimentRun)).toBe(false);
    expect(await isLaunchedLineageRun(db, observedRun)).toBe(false);
    expect(await isLaunchedLineageRun(db, plainRun)).toBe(false);

    // The 0110 backfill converts the legacy member into a launched evaluation
    // participant, restoring its launched-lineage semantics through the ONE
    // predicate — so a historical experiment run stays excluded from
    // auto-promotion after the experiment_runs leg is dropped.
    await db.execute(sql`SELECT evaluation_backfill_from_experiments()`);
    expect(await isLaunchedEvaluationRun(db, experimentRun)).toBe(true);
    expect(await isLaunchedLineageRun(db, experimentRun)).toBe(true);

    // A tombstoned launched participant still holds its run (immutable hold).
    await db.execute(
      sql`UPDATE evaluation_participants SET removed_at = now() WHERE id = ${launchedParticipantId}`,
    );
    expect(await isLaunchedLineageRun(db, launchedRun)).toBe(true);
  });
});
