import type { CreateExperimentInput } from "@/lib/experiments/http-schemas";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;
let services: typeof import("@/lib/experiments/service");
let advisory: typeof import("@/lib/experiments/advisory");
let comparison: typeof import("@/lib/experiments/comparison");

vi.mock("@/lib/db/client", () => ({
  getDb: () => db,
}));

vi.mock("@/lib/worktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/worktree")>()),
  resolveBaseCommit: vi.fn(
    async () => "abcdef1234567890abcdef1234567890abcdef12",
  ),
  assertBaseCommitReachable: vi.fn(
    async () => "abcdef1234567890abcdef1234567890abcdef12",
  ),
}));

vi.mock("@/lib/workbench-lifecycle/service", () => ({
  stopWorkbenchRun: vi.fn(async (runId: string) => ({
    ok: true,
    runId,
    runStatus: "Abandoned",
  })),
}));

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "experiments_service_test",
  });
  db = testDatabase.db;

  services = await import("@/lib/experiments/service");
  advisory = await import("@/lib/experiments/advisory");
  comparison = await import("@/lib/experiments/comparison");
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

async function seedBase(): Promise<{
  projectId: string;
  slug: string;
  taskId: string;
  userId: string;
}> {
  const projectId = randomUUID();
  const slug = `exp-${projectId.slice(0, 8)}`;
  const taskId = randomUUID();
  const userId = randomUUID();

  await db.execute(sql`
    INSERT INTO users (id, email, role, account_status)
    VALUES (${userId}, ${`u-${userId.slice(0, 8)}@example.test`}, 'member', 'active')
  `);
  await db.execute(sql`
    INSERT INTO projects (id, slug, name, repo_path, task_key, main_branch)
    VALUES (${projectId}, ${slug}, 'Experiment project', ${`/tmp/${slug}`}, 'KEY', 'main')
  `);
  await db.execute(sql`
    INSERT INTO tasks (id, project_id, number, title, prompt, created_by_user_id)
    VALUES (${taskId}, ${projectId}, 12, 'Compare variants', 'Build both options', ${userId})
  `);

  return { projectId, slug, taskId, userId };
}

function createInput(taskId: string): CreateExperimentInput {
  return {
    taskId,
    title: "Pinned comparison",
    baseBranch: "main",
    variants: [
      { key: "a", label: "Control", config: {} },
      { key: "b", label: "Candidate", config: {} },
    ],
  };
}

async function seedComparableRuns(args: {
  projectId: string;
  taskId: string;
  experimentId: string;
}): Promise<{ runA: string; runB: string }> {
  const runA = randomUUID();
  const runB = randomUUID();
  const memberA = randomUUID();
  const memberB = randomUUID();

  await db.execute(sql`
    INSERT INTO runs (id, task_id, project_id, flow_version, status, started_at, ended_at)
    VALUES
      (${runA}, ${args.taskId}, ${args.projectId}, 'test', 'Review', now() - interval '3 minutes', now() - interval '1 minute'),
      (${runB}, ${args.taskId}, ${args.projectId}, 'test', 'Review', now() - interval '4 minutes', now() - interval '2 minutes')
  `);
  await db.execute(sql`
    INSERT INTO experiment_runs (
      id,
      experiment_id,
      run_id,
      variant_key,
      replicate_ordinal,
      launch_reason,
      base_commit,
      diff_snapshot,
      diff_snapshot_truncated,
      diff_snapshot_bytes,
      diff_snapshot_captured_at,
      diff_files_summary,
      materialization_delta
    )
    VALUES
      (
        ${memberA},
        ${args.experimentId},
        ${runA},
        'a',
        1,
        'initial',
        'abcdef1234567890abcdef1234567890abcdef12',
        'diff --git a/a.ts b/a.ts',
        false,
        120,
        now(),
        ${JSON.stringify([{ path: "a.ts", status: "M", additions: 1, deletions: 0, patchHash: "ha" }])}::jsonb,
        ${JSON.stringify({ experimentId: args.experimentId, variantKey: "a", added: { rules: [], skills: [], mcps: [], subagents: [] }, removed: { rules: [], skills: [], mcps: [], subagents: [] } })}::jsonb
      ),
      (
        ${memberB},
        ${args.experimentId},
        ${runB},
        'b',
        1,
        'initial',
        'abcdef1234567890abcdef1234567890abcdef12',
        'diff --git a/b.ts b/b.ts',
        false,
        140,
        now(),
        ${JSON.stringify([{ path: "b.ts", status: "A", additions: 2, deletions: 0, patchHash: "hb" }])}::jsonb,
        ${JSON.stringify({ experimentId: args.experimentId, variantKey: "b", added: { rules: [], skills: [], mcps: [], subagents: [] }, removed: { rules: [], skills: [], mcps: [], subagents: [] } })}::jsonb
      )
  `);

  return { runA, runB };
}

describe("Experiment service integration", () => {
  it("creates, lists, heals comparable status, appends advisory, and concludes through real Postgres rows", async () => {
    const seed = await seedBase();
    const created = await services.createExperiment({
      projectId: seed.projectId,
      slug: seed.slug,
      actorUserId: seed.userId,
      input: createInput(seed.taskId),
    });

    expect(created.status).toBe("draft");
    expect(created.baseCommit).toBe("abcdef1234567890abcdef1234567890abcdef12");

    const listed = await services.listProjectExperiments(seed.projectId);

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: created.id,
      title: "Pinned comparison",
      taskNumber: 12,
      status: "draft",
      variantsCount: 2,
    });

    await db.execute(sql`
      UPDATE experiments SET status = 'running' WHERE id = ${created.id}
    `);
    const seededRuns = await seedComparableRuns({
      projectId: seed.projectId,
      taskId: seed.taskId,
      experimentId: created.id,
    });
    const dto = await comparison.getExperimentComparison({
      projectId: seed.projectId,
      experimentId: created.id,
      viewerType: "session",
    });

    expect(dto.experiment.status).toBe("comparable");
    expect(dto.runs.map((run) => run.runId).sort()).toEqual(
      [seededRuns.runA, seededRuns.runB].sort(),
    );
    expect(dto.runs[0].files.length + dto.runs[1].files.length).toBe(2);

    await advisory.appendExperimentAdvisory({
      projectId: seed.projectId,
      experimentId: created.id,
      actorLabel: "core:experiment-judge",
      agentRunId: "run-judge",
      input: {
        summary: "Candidate scores higher.",
        confidence: 0.72,
        scores: { correctness: { a: 3, b: 5 } },
      },
    });

    const concluded = await services.concludeExperiment({
      projectId: seed.projectId,
      experimentId: created.id,
      actor: { type: "user", id: seed.userId },
      input: {
        outcome: "winner",
        winnerVariantKey: "b",
        comment: "Ship candidate.",
        scores: { correctness: { a: 3, b: 5 } },
        abandonLosers: false,
      },
    });

    expect(concluded.status).toBe("concluded");
    expect(concluded.verdict?.human?.winnerVariantKey).toBe("b");
    expect(concluded.verdict?.judgeAdvisories?.[0]?.summary).toBe(
      "Candidate scores higher.",
    );

    const activity = await db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count
      FROM task_activity
      WHERE task_id = ${seed.taskId}
        AND event_kind = 'experiment_concluded'
    `);

    expect(Number(activity.rows[0].count)).toBe(1);
  });
});
