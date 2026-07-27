import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// FIXME(any): drizzle-orm dual peer-dep variants — runtime works, cast silences
// the type-only clash (matches evaluation-legacy-backfill.integration.test.ts).
import * as fullSchema from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import {
  applyMainMigration,
  startMainPostgresTestDb,
  startMainPostgresTestDbUpTo,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

const VARIANTS = [
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

// T5.1 — the destructive leg of ADR-150. 0120 first re-runs the idempotent
// backfill (a safety valve that converts any surviving legacy Experiment into a
// Study), then drops the `experiments` / `experiment_runs` tables and the
// function. This suite seeds a legacy Experiment at 0119, applies 0120, and
// proves the seeded row was preserved as a Study before the tables vanished.
describe("migration 0120 — seeded legacy experiments backfill then drop", () => {
  let testDatabase: StartedPostgresTestDb;
  let db: NodePgDatabase;
  let experimentId: string;

  beforeAll(async () => {
    testDatabase = await startMainPostgresTestDbUpTo(
      { databaseName: "maister_migration_0119_seeded" },
      "0119_tough_morlun",
    );
    db = testDatabase.db;

    const projectId = randomUUID();
    const executorId = randomUUID();
    const flowId = randomUUID();
    const taskId = randomUUID();
    const runId = randomUUID();

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
    // Raw SQL rather than `db.insert(schema.runs)`: this database is stopped at
    // an OLDER migration, while the drizzle `runs` object is the CURRENT schema
    // and emits every column it knows (ADR-152 added `agent_memory_hash` at
    // 0122). Naming columns explicitly decouples this fixture from any future
    // additive `runs` column — the same reason `experiments` is inserted raw.
    await db.execute(sql`
      INSERT INTO runs (id, task_id, project_id, flow_id, flow_version)
      VALUES (${runId}, ${taskId}, ${projectId}, ${flowId}, 'v1.0.0')
    `);

    // Raw SQL: the `experiments` drizzle table object was removed from the
    // schema barrel by ADR-150, but the table still exists at 0119.
    experimentId = randomUUID();
    await db.execute(sql`
      INSERT INTO experiments (
        id, project_id, task_id, title, base_branch, base_commit,
        variants, rubric, status
      ) VALUES (
        ${experimentId}, ${projectId}, ${taskId}, 'Legacy exp', 'main', 'abc123',
        ${JSON.stringify(VARIANTS)}::jsonb, ${JSON.stringify(RUBRIC)}::jsonb,
        'running'
      )
    `);
    await db.execute(sql`
      INSERT INTO experiment_runs (
        id, experiment_id, run_id, variant_key, replicate_ordinal,
        launch_reason, base_commit
      ) VALUES (
        ${randomUUID()}, ${experimentId}, ${runId}, 'A', 1, 'initial', 'abc123'
      )
    `);

    await applyMainMigration(db, "0120_living_captain_marvel");
  }, 180_000);

  afterAll(async () => {
    await testDatabase?.stop();
  });

  it("backfilled the seeded experiment into a study preserving its id and snapshot", async () => {
    const { rows } = await db.execute<{
      id: string;
      legacy_experiment_id: string;
      legacy_snapshot: unknown;
    }>(sql`
      SELECT id, legacy_experiment_id, legacy_snapshot
        FROM evaluation_studies
       WHERE legacy_experiment_id = ${experimentId}
    `);

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(experimentId);
    expect(rows[0].legacy_experiment_id).toBe(experimentId);
    expect(rows[0].legacy_snapshot).not.toBeNull();
  });

  it("launched the seeded member as an evaluation participant", async () => {
    const { rows } = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n
        FROM evaluation_participants
       WHERE study_id = ${experimentId} AND source_type = 'launched'
    `);

    expect(rows[0].n).toBe(1);
  });

  it("dropped the legacy experiments and experiment_runs tables", async () => {
    const { rows } = await db.execute<{ table_name: string }>(sql`
      SELECT table_name
        FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('experiments', 'experiment_runs')
    `);

    expect(rows).toHaveLength(0);
  });

  it("dropped the evaluation_backfill_from_experiments function", async () => {
    const { rows } = await db.execute<{ proname: string }>(sql`
      SELECT proname
        FROM pg_proc
       WHERE proname = 'evaluation_backfill_from_experiments'
    `);

    expect(rows).toHaveLength(0);
  });
});

// The empty-DB arm: the full 0000→0120 chain must apply cleanly on a fresh
// container (startMainPostgresTestDb runs the whole lineage — a throw would fail
// beforeAll), with the 0120 safety-valve backfill a no-op over zero legacy rows.
describe("migration 0120 — full chain is clean on an empty database", () => {
  let testDatabase: StartedPostgresTestDb;

  beforeAll(async () => {
    testDatabase = await startMainPostgresTestDb({
      databaseName: "maister_migration_0120_empty",
    });
  }, 180_000);

  afterAll(async () => {
    await testDatabase?.stop();
  });

  it("leaves no experiments or experiment_runs tables", async () => {
    const { rows } = await testDatabase.db.execute<{ table_name: string }>(sql`
      SELECT table_name
        FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('experiments', 'experiment_runs')
    `);

    expect(rows).toHaveLength(0);
  });

  it("leaves no evaluation_backfill_from_experiments function", async () => {
    const { rows } = await testDatabase.db.execute<{ proname: string }>(sql`
      SELECT proname
        FROM pg_proc
       WHERE proname = 'evaluation_backfill_from_experiments'
    `);

    expect(rows).toHaveLength(0);
  });
});
