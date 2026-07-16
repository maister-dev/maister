import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// FIXME(any): drizzle-orm dual peer-dep variants — runtime works, cast silences
// the type-only clash (matches evaluation-schema.integration.test.ts).
import * as fullSchema from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

let projectId: string;
let executorId: string;
let flowId: string;
let taskId: string;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_eval_backfill_test",
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

const VARIANTS_AB = [
  { key: "A", label: "Variant A", config: {} },
  { key: "B", label: "Variant B", config: {} },
];
const RUBRIC = {
  criteria: [
    {
      id: "c1",
      label: "Quality",
      guidance: "g",
      scale: { min: 0, max: 5 },
      weight: 1,
    },
  ],
};

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

async function insertExperiment(
  overrides: Record<string, unknown>,
): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.experiments).values({
    id,
    projectId,
    taskId,
    title: "Exp",
    baseBranch: "main",
    baseCommit: "abc123",
    variants: VARIANTS_AB,
    rubric: RUBRIC,
    ...overrides,
  });

  return id;
}

async function insertExperimentRun(
  experimentId: string,
  variantKey: string,
  replicateOrdinal: number,
  launchReason = "initial",
): Promise<string> {
  const runId = await makeRun();

  await db.insert(schema.experimentRuns).values({
    id: randomUUID(),
    experimentId,
    runId,
    variantKey,
    replicateOrdinal,
    launchReason,
    baseCommit: "abc123",
    diffSnapshotBytes: 1024,
    diffSnapshotTruncated: false,
  });

  return runId;
}

async function backfill(): Promise<void> {
  await db.execute(sql`SELECT evaluation_backfill_from_experiments()`);
}

describe("evaluation legacy backfill", () => {
  // Study ids of the seeded fixtures, resolved in beforeAll of this describe.
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const now = new Date();

    // E1: concluded, winner=B, WITH one judge advisory.
    ids.concludedWithAdvisory = await insertExperiment({
      status: "concluded",
      description: "purpose-1",
      verdict: {
        human: {
          outcome: "winner",
          winnerVariantKey: "B",
          comment: "B better",
        },
        judgeAdvisories: [
          {
            advisoryOrdinal: 1,
            agentRunId: null,
            createdAt: now.toISOString(),
            scores: { c1: { A: 3, B: 4 } },
            summary: "B edges A",
            confidence: 0.8,
          },
        ],
      },
      concludedAt: now,
    });
    await insertExperimentRun(ids.concludedWithAdvisory, "A", 1);
    await insertExperimentRun(ids.concludedWithAdvisory, "B", 1);

    // E2: concluded, tie, NO advisories -> zero-citation verdict.
    ids.concludedNoAdvisory = await insertExperiment({
      status: "concluded",
      verdict: { human: { outcome: "tie" } },
      concludedAt: now,
    });
    await insertExperimentRun(ids.concludedNoAdvisory, "A", 1);

    // E3: abandoned, verdict null.
    ids.abandoned = await insertExperiment({
      status: "abandoned",
      abandonedAt: now,
    });
    await insertExperimentRun(ids.abandoned, "A", 1);

    // E4: running.
    ids.running = await insertExperiment({ status: "running" });
    await insertExperimentRun(ids.running, "A", 1);
    await insertExperimentRun(ids.running, "B", 1);

    // E5: comparable.
    ids.comparable = await insertExperiment({ status: "comparable" });
    await insertExperimentRun(ids.comparable, "A", 1);

    // E6: draft, no runs.
    ids.draft = await insertExperiment({ status: "draft" });

    // E7: a budget_restart replicate -> launch_reason remaps to manual_relaunch.
    ids.budgetRestart = await insertExperiment({ status: "running" });
    await insertExperimentRun(ids.budgetRestart, "A", 2, "budget_restart");

    await backfill();
  });

  async function one(text: string): Promise<Record<string, unknown>> {
    const rows = await db.execute(sql.raw(text));

    return rows.rows[0] as Record<string, unknown>;
  }

  it("migrates one Study per Experiment with the id preserved", async () => {
    const row = await one(
      `SELECT count(*)::int AS n FROM evaluation_studies WHERE legacy_experiment_id IS NOT NULL`,
    );

    expect(row.n).toBe(7);
    // Study id == Experiment id (deep-link parity).
    const same = await one(
      `SELECT id, legacy_experiment_id FROM evaluation_studies WHERE id = '${ids.concludedWithAdvisory}'`,
    );

    expect(same.id).toBe(ids.concludedWithAdvisory);
    expect(same.legacy_experiment_id).toBe(ids.concludedWithAdvisory);
  });

  it("applies the fixed status mapping and preserves the original JSON", async () => {
    const decided = await one(
      `SELECT status, purpose, legacy_snapshot->>'status' AS legacy FROM evaluation_studies WHERE id = '${ids.concludedWithAdvisory}'`,
    );

    expect(decided.status).toBe("decided");
    expect(decided.purpose).toBe("purpose-1");
    expect(decided.legacy).toBe("concluded");

    const archived = await one(
      `SELECT status, archived_reason FROM evaluation_studies WHERE id = '${ids.abandoned}'`,
    );

    expect(archived.status).toBe("archived");
    expect(archived.archived_reason).toBe("legacy_abandoned");

    for (const [key, expected] of [
      ["running", "open"],
      ["comparable", "open"],
      ["draft", "draft"],
    ] as const) {
      const row = await one(
        `SELECT status FROM evaluation_studies WHERE id = '${ids[key]}'`,
      );

      expect(row.status).toBe(expected);
    }
  });

  it("converts each variant to an immutable recipe and each member to a launched participant", async () => {
    const recipes = await one(
      `SELECT count(*)::int AS n FROM evaluation_recipes WHERE study_id = '${ids.concludedWithAdvisory}'`,
    );

    expect(recipes.n).toBe(2);

    const parts = await one(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE source_type = 'launched') AS launched FROM evaluation_participants WHERE study_id = '${ids.concludedWithAdvisory}'`,
    );

    expect(parts.n).toBe(2);
    expect(Number(parts.launched)).toBe(2);

    // Every launched participant links its owning recipe.
    const linked = await one(
      `SELECT count(*)::int AS n FROM evaluation_participants WHERE study_id = '${ids.concludedWithAdvisory}' AND recipe_id IS NOT NULL`,
    );

    expect(linked.n).toBe(2);
  });

  it("remaps the legacy budget_restart launch reason to manual_relaunch", async () => {
    const row = await one(
      `SELECT launch_reason FROM evaluation_participants WHERE study_id = '${ids.budgetRestart}'`,
    );

    expect(row.launch_reason).toBe("manual_relaunch");
  });

  it("synthesizes a terminal Partial legacy_advisory execution with one attempt per advisory", async () => {
    const exec = await one(
      `SELECT id, status, terminal_reason, method_revision_id FROM evaluation_executions WHERE study_id = '${ids.concludedWithAdvisory}'`,
    );

    expect(exec.status).toBe("partial");
    expect(exec.terminal_reason).toBe("legacy_advisory");
    expect(exec.method_revision_id).toBeNull();

    const attempt = await one(
      `SELECT role, status, reason, sealed_result->>'summary' AS summary FROM evaluation_judge_attempts WHERE execution_id = '${exec.id as string}'`,
    );

    expect(attempt.role).toBe("legacy");
    expect(attempt.status).toBe("completed");
    expect(attempt.reason).toBe("legacy_advisory");
    expect(attempt.summary).toBe("B edges A");
  });

  it("cites the synthesized execution in the concluded human verdict (winner)", async () => {
    const verdict = await one(
      `SELECT outcome, no_evaluation_evidence_ack, jsonb_array_length(execution_ids) AS execs, jsonb_array_length(participant_ids) AS parts FROM evaluation_human_verdicts WHERE study_id = '${ids.concludedWithAdvisory}'`,
    );

    expect(verdict.outcome).toBe("winner");
    expect(verdict.no_evaluation_evidence_ack).toBe(false);
    expect(Number(verdict.execs)).toBe(1);
    // Winner=B -> only B's participants are cited (1 of the 2).
    expect(Number(verdict.parts)).toBe(1);
  });

  it("writes a zero-citation verdict with the acknowledgement when no advisories exist", async () => {
    const verdict = await one(
      `SELECT outcome, no_evaluation_evidence_ack, jsonb_array_length(execution_ids) AS execs FROM evaluation_human_verdicts WHERE study_id = '${ids.concludedNoAdvisory}'`,
    );

    expect(verdict.outcome).toBe("tie");
    expect(verdict.no_evaluation_evidence_ack).toBe(true);
    expect(Number(verdict.execs)).toBe(0);
  });

  it("does not write a verdict for a non-concluded Experiment", async () => {
    const row = await one(
      `SELECT count(*)::int AS n FROM evaluation_human_verdicts WHERE study_id = '${ids.abandoned}'`,
    );

    expect(row.n).toBe(0);
  });

  it("is idempotent — re-running migrates nothing new", async () => {
    const before = await one(
      `SELECT count(*)::int AS n FROM evaluation_studies WHERE legacy_experiment_id IS NOT NULL`,
    );

    await backfill();
    const after = await one(
      `SELECT count(*)::int AS n FROM evaluation_studies WHERE legacy_experiment_id IS NOT NULL`,
    );

    expect(after.n).toBe(before.n);
  });

  it("loudly aborts (and rolls back) when an experiment_run cites an unknown variant", async () => {
    const badId = await insertExperiment({ status: "running" });
    // A member run whose variant key is not present in variants[].
    const runId = await makeRun();

    await db.insert(schema.experimentRuns).values({
      id: randomUUID(),
      experimentId: badId,
      runId,
      variantKey: "GHOST",
      replicateOrdinal: 1,
      launchReason: "initial",
      baseCommit: "abc123",
    });

    await expect(backfill()).rejects.toThrow();

    // The bad experiment's Study insert rolled back with the raise.
    const row = await one(
      `SELECT count(*)::int AS n FROM evaluation_studies WHERE legacy_experiment_id = '${badId}'`,
    );

    expect(row.n).toBe(0);
  });
});
