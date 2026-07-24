import { randomUUID } from "node:crypto";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import { BUILT_IN_LANES } from "@/lib/auto-promotion/config";
import { MaisterError } from "@/lib/errors";
import { addTaskComment } from "@/lib/social/comments";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const mocks = vi.hoisted(() => ({
  promoteRun: vi.fn(),
  diffChangeStats: vi.fn(),
  assertEvidenceReady: vi.fn(),
}));

let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/runs/promote", () => ({ promoteRun: mocks.promoteRun }));
vi.mock("@/lib/worktree", async (orig) => ({
  ...(await orig<typeof import("@/lib/worktree")>()),
  diffChangeStats: mocks.diffChangeStats,
}));
vi.mock("@/lib/flows/graph/evidence-readiness", () => ({
  assertEvidenceReady: mocks.assertEvidenceReady,
}));
// Wrap the REAL addTaskComment so AC-1/AC-6 keep writing real comments, but the
// R2-F2 comment-failure test can override a single call with mockRejectedValueOnce.
vi.mock("@/lib/social/comments", async (orig) => {
  const real = await orig<typeof import("@/lib/social/comments")>();

  return { ...real, addTaskComment: vi.fn(real.addTaskComment) };
});

// Imported AFTER the mocks so the module graph binds the stubs.
const { runAutoPromoteJob, CANDIDATE_LIMIT } = await import(
  "@/lib/scheduler/handlers/auto-promote"
);
const { runSchedulerTick } = await import("@/lib/scheduler/tick-service");

const schema = fullSchema as unknown as Record<string, any>;
const { runs, workspaces, tasks, taskComments } = schema;

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let projectId: string;
let userId: string;
let runnerId: string;
let flowId: string;

const docsFile = {
  path: "README.md",
  status: "M",
  additions: 1,
  deletions: 0,
  binary: false,
};

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.MAISTER_AUTO_PROMOTION;
});

beforeEach(async () => {
  await pool.query(`DELETE FROM "task_comments"`);
  await pool.query(`DELETE FROM "workspaces"`);
  // evaluation_studies.task_id is ON DELETE RESTRICT, so studies (and their
  // cascading participants/recipes) must be cleared before the tasks delete.
  await pool.query(`DELETE FROM "evaluation_participants"`);
  await pool.query(`DELETE FROM "evaluation_recipes"`);
  await pool.query(`DELETE FROM "evaluation_studies"`);
  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "tasks"`);
  await pool.query(`DELETE FROM "flows"`);
  await pool.query(`DELETE FROM "platform_acp_runners"`);
  await pool.query(`DELETE FROM "projects"`);
  await pool.query(`DELETE FROM "users"`);
  await pool.query(`DELETE FROM "scheduler_job_runs"`);
  await pool.query(`DELETE FROM "scheduler_jobs"`);

  delete process.env.MAISTER_AUTO_PROMOTION;
  vi.clearAllMocks();
  mocks.diffChangeStats.mockResolvedValue([docsFile]);
  mocks.assertEvidenceReady.mockResolvedValue({ ready: true });
  mocks.promoteRun.mockResolvedValue({});

  projectId = randomUUID();
  userId = randomUUID();
  runnerId = randomUUID();
  flowId = randomUUID();

  await db
    .insert(schema.users)
    .values({ id: userId, email: `u-${userId.slice(0, 8)}@t.test` });
  await db.insert(schema.projects).values({
    id: projectId,
    slug: `p-${projectId.slice(0, 8)}`,
    name: "P",
    repoPath: `/repos/${projectId}`,
    maisterYamlPath: "/tmp/m.yaml",
    taskKey: `T${projectId
      .replace(/[^0-9A-Za-z]/g, "")
      .slice(0, 7)
      .toUpperCase()}`,
    autoPromotion: { enabled: true, lanes: BUILT_IN_LANES },
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(runnerId, "claude"));
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "g",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/g",
    manifest: {},
    schemaVersion: 1,
  });
});

let taskCounter = 0;

async function seedReviewRun(
  overrides: {
    reviewMinutesAgo?: number | null;
    promotionHold?: unknown;
    workspaceMode?: string | null;
    status?: string;
  } = {},
): Promise<string> {
  const runId = randomUUID();
  const taskId = randomUUID();

  taskCounter += 1;

  await db.insert(tasks).values({
    id: taskId,
    projectId,
    number: taskCounter,
    title: "t",
    prompt: "p",
    status: "InFlight",
  });

  const reviewMinutesAgo =
    overrides.reviewMinutesAgo === undefined ? 30 : overrides.reviewMinutesAgo;

  await db.insert(runs).values({
    id: runId,
    projectId,
    taskId,
    flowId,
    runnerId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(runnerId),
    flowVersion: "v1.0.0",
    status: overrides.status ?? "Review",
    runKind: "flow",
    createdByUserId: userId,
    workspaceMode: overrides.workspaceMode ?? null,
    promotionHold: overrides.promotionHold ?? null,
    reviewEnteredAt:
      reviewMinutesAgo === null
        ? null
        : new Date(Date.now() - reviewMinutesAgo * 60_000),
  });

  await db.insert(workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch: `maister/${runId.slice(0, 8)}`,
    worktreePath: `/tmp/wt/${runId}`,
    parentRepoPath: `/repos/${projectId}`,
    baseCommit: "abc123",
    promotionState: "none",
  });

  return { runId, taskId } as unknown as string;
}

async function commentCount(taskId: string): Promise<number> {
  const rows = await db
    .select({ id: taskComments.id })
    .from(taskComments)
    .where(eq(taskComments.taskId, taskId));

  return rows.length;
}

describe("runAutoPromoteJob — AC-1 happy path", () => {
  it("promotes an eligible docs run via promoteRun with system attribution + posts one comment", async () => {
    const { runId, taskId } = (await seedReviewRun()) as unknown as {
      runId: string;
      taskId: string;
    };

    const summary = await runAutoPromoteJob({ db, promote: mocks.promoteRun });

    expect(summary.promoted).toBe(1);
    expect(mocks.promoteRun).toHaveBeenCalledTimes(1);
    expect(mocks.promoteRun).toHaveBeenCalledWith(
      runId,
      expect.objectContaining({
        autoOnReady: true,
        attribution: { source: "auto_promotion", laneClass: "docs" },
      }),
      expect.objectContaining({ actor: { kind: "system" } }),
      db,
    );
    expect(await commentCount(taskId)).toBe(1);
  });
});

describe("runAutoPromoteJob — AC-5 readiness gate", () => {
  it("skips (no promote) when readiness is not green", async () => {
    mocks.assertEvidenceReady.mockRejectedValue(
      new MaisterError("PRECONDITION", "not ready"),
    );
    await seedReviewRun();

    const summary = await runAutoPromoteJob({ db, promote: mocks.promoteRun });

    expect(mocks.promoteRun).not.toHaveBeenCalled();
    expect(summary.promoted).toBe(0);
  });
});

describe("runAutoPromoteJob — AC-6 conflict give-up", () => {
  it("on CONFLICT sets a system hold + exactly one comment; a second tick does nothing", async () => {
    mocks.promoteRun.mockRejectedValue(
      new MaisterError("CONFLICT", "conflict"),
    );
    const { runId, taskId } = (await seedReviewRun()) as unknown as {
      runId: string;
      taskId: string;
    };

    const first = await runAutoPromoteJob({ db, promote: mocks.promoteRun });

    expect(first.gaveUp).toBe(1);

    const [row] = await db
      .select({ hold: runs.promotionHold })
      .from(runs)
      .where(eq(runs.id, runId));

    expect(row.hold?.source).toBe("system");
    expect(await commentCount(taskId)).toBe(1);

    // Second tick: the held run is excluded by the prefilter → no dup.
    mocks.promoteRun.mockClear();
    const second = await runAutoPromoteJob({ db, promote: mocks.promoteRun });

    expect(mocks.promoteRun).not.toHaveBeenCalled();
    expect(second.candidates).toBe(0);
    expect(await commentCount(taskId)).toBe(1);
  });
});

describe("runAutoPromoteJob — AC-8 holds, toggles, kill switch", () => {
  it("a launch-held run is never a candidate", async () => {
    await seedReviewRun({
      promotionHold: { source: "launch", createdAt: new Date().toISOString() },
    });

    const summary = await runAutoPromoteJob({ db, promote: mocks.promoteRun });

    expect(summary.candidates).toBe(0);
    expect(mocks.promoteRun).not.toHaveBeenCalled();
  });

  it("the platform env kill switch stops the tick", async () => {
    process.env.MAISTER_AUTO_PROMOTION = "off";
    await seedReviewRun();

    const summary = await runAutoPromoteJob({ db, promote: mocks.promoteRun });

    expect(summary.candidates).toBe(0);
    expect(mocks.promoteRun).not.toHaveBeenCalled();
  });

  it("the project master toggle off makes the run ineligible", async () => {
    await db
      .update(schema.projects)
      .set({ autoPromotion: { enabled: false, lanes: BUILT_IN_LANES } })
      .where(eq(schema.projects.id, projectId));
    await seedReviewRun();

    const summary = await runAutoPromoteJob({ db, promote: mocks.promoteRun });

    expect(mocks.promoteRun).not.toHaveBeenCalled();
    expect(summary.promoted).toBe(0);
  });
});

describe("runSchedulerTick × auto_promote — through-dispatch (codex F2)", () => {
  it("the real claim→dispatch path runs the sweep handler (a missing case would leave promote uncalled)", async () => {
    const { runId } = (await seedReviewRun()) as unknown as { runId: string };

    // runSchedulerTick seeds the auto_promote.default singleton, claims it, and
    // dispatches through runClaimedJob → case "auto_promote" → the handler (which
    // uses the module-mocked promoteRun).
    await runSchedulerTick({ jobKind: "auto_promote" });

    expect(mocks.promoteRun).toHaveBeenCalledWith(
      runId,
      expect.objectContaining({
        attribution: { source: "auto_promotion", laneClass: "docs" },
      }),
      expect.anything(),
      expect.anything(),
    );
  });
});

// ADR-150 (enforcing ADR-142 D3): a launched evaluation participant is
// structurally non-promotable. The SQL prefilter now excludes on
// `evaluation_participants.source_type = 'launched'` (NOT the retired
// `experiment_runs`, which `0119` drops) — this block is the cross-check that
// the replaced predicate still keeps a launched participant out of the sweep.
describe("runAutoPromoteJob — ADR-150: launched participants are never candidates", () => {
  async function makeMember(runId: string, taskId: string): Promise<void> {
    const studyId = randomUUID();

    await db.insert(schema.evaluationStudies).values({
      id: studyId,
      projectId,
      taskId,
      title: "fork vs upstream",
      status: "open",
    });

    const recipeId = randomUUID();

    await db.insert(schema.evaluationRecipes).values({
      id: recipeId,
      studyId,
      key: "a",
      label: "A",
      definition: {},
      definitionDigest: "d",
    });

    await db.insert(schema.evaluationParticipants).values({
      id: randomUUID(),
      studyId,
      runId,
      sourceType: "launched",
      recipeId,
      label: "launched",
      launchReason: "initial",
      replicateOrdinal: 1,
    });
  }

  it("the candidate query excludes the launched participant; the sibling non-participant still promotes (regression arm)", async () => {
    const member = (await seedReviewRun()) as unknown as {
      runId: string;
      taskId: string;
    };
    const plain = (await seedReviewRun()) as unknown as {
      runId: string;
      taskId: string;
    };

    await makeMember(member.runId, member.taskId);

    const summary = await runAutoPromoteJob({ db, promote: mocks.promoteRun });

    // The SQL prefilter never selects the member (candidates = 1), and the
    // evaluate term is the apply-site backstop — asserting the COUNT pins the
    // prefilter arm specifically.
    expect(summary.candidates).toBe(1);
    expect(mocks.promoteRun).toHaveBeenCalledTimes(1);
    expect(mocks.promoteRun).toHaveBeenCalledWith(
      plain.runId,
      expect.anything(),
      expect.anything(),
      db,
    );
  });

  it("the runSchedulerTick through-dispatch path never promotes a launched participant end-to-end (wiring seam)", async () => {
    const member = (await seedReviewRun()) as unknown as {
      runId: string;
      taskId: string;
    };

    await makeMember(member.runId, member.taskId);

    await runSchedulerTick({ jobKind: "auto_promote" });

    expect(mocks.promoteRun).not.toHaveBeenCalled();
  });
});

describe("runAutoPromoteJob — F2 supersede is a benign skip, not a give-up", () => {
  it("a details-tagged supersede abort skips without a system hold or comment", async () => {
    mocks.promoteRun.mockRejectedValue(
      new MaisterError("CONFLICT", "superseded", {
        details: { autoPromotionSuperseded: "held" },
      }),
    );
    const { runId, taskId } = (await seedReviewRun()) as unknown as {
      runId: string;
      taskId: string;
    };

    const summary = await runAutoPromoteJob({ db, promote: mocks.promoteRun });

    expect(summary.skipped).toBe(1);
    expect(summary.gaveUp).toBe(0);

    const [row] = await db
      .select({ hold: runs.promotionHold })
      .from(runs)
      .where(eq(runs.id, runId));

    expect(row.hold).toBeNull();
    expect(await commentCount(taskId)).toBe(0);
  });
});

describe("runAutoPromoteJob — F1 rotation defeats starvation", () => {
  it("promotes an eligible run stranded behind a full window of permanent-skip runs", async () => {
    const srcFile = {
      path: "src/app.ts",
      status: "M",
      additions: 1,
      deletions: 0,
      binary: false,
    };

    // A full CANDIDATE_LIMIT window of OLDER no-lane runs (permanent skips that
    // never mutate) sorts ahead of ONE newer eligible docs run.
    for (let i = 0; i < CANDIDATE_LIMIT; i += 1) {
      await seedReviewRun({ reviewMinutesAgo: 60 });
    }
    const { runId: eligibleRunId } = (await seedReviewRun({
      reviewMinutesAgo: 20,
    })) as unknown as { runId: string; taskId: string };

    const eligibleWt = `/tmp/wt/${eligibleRunId}`;

    mocks.diffChangeStats.mockImplementation(
      async ({ worktreePath }: { worktreePath: string }) =>
        worktreePath === eligibleWt ? [docsFile] : [srcFile],
    );

    // Seed the singleton job row so the rotation cursor persists across ticks.
    await pool.query(`
      INSERT INTO scheduler_jobs
        (id, project_id, job_kind, target, cadence_interval_seconds, next_run_at, max_failures, created_at, updated_at)
      VALUES ('auto_promote.default', NULL, 'auto_promote', '{}'::jsonb, 60, now(), 3, now(), now())
      ON CONFLICT (id) DO NOTHING
    `);

    // Tick 1: the window is entirely older no-lane runs — the eligible run is
    // never evaluated. The old unordered+capped sweep could starve here forever.
    const tick1 = await runAutoPromoteJob({ db, promote: mocks.promoteRun });

    expect(tick1.candidates).toBe(CANDIDATE_LIMIT);
    expect(tick1.promoted).toBe(0);
    expect(mocks.promoteRun).not.toHaveBeenCalled();

    // Tick 2: the cursor resumes past the processed window and reaches the run.
    const tick2 = await runAutoPromoteJob({ db, promote: mocks.promoteRun });

    expect(tick2.promoted).toBe(1);
    expect(mocks.promoteRun).toHaveBeenCalledWith(
      eligibleRunId,
      expect.objectContaining({
        attribution: { source: "auto_promotion", laneClass: "docs" },
      }),
      expect.anything(),
      db,
    );

    // Short tail window ⇒ cursor reset, so the next tick re-scans from the head.
    const { rows } = await pool.query(
      `SELECT target FROM scheduler_jobs WHERE id = 'auto_promote.default'`,
    );

    expect(rows[0].target.cursor).toBeNull();
  });
});

describe("runAutoPromoteJob — R2-F1 malformed config must not crash the sweep", () => {
  it("a project whose autoPromotion.enabled is non-boolean does not throw the tick", async () => {
    // The old `(auto_promotion->>'enabled')::boolean` cast threw a Postgres error
    // on this row and failed the singleton job; @> containment excludes it safely.
    await db
      .update(schema.projects)
      .set({ autoPromotion: { enabled: "x" } })
      .where(eq(schema.projects.id, projectId));
    await seedReviewRun();

    const summary = await runAutoPromoteJob({ db, promote: mocks.promoteRun });

    expect(summary.candidates).toBe(0);
    expect(mocks.promoteRun).not.toHaveBeenCalled();
  });
});

describe("runAutoPromoteJob — R2-F2 give-up path is race- and comment-safe", () => {
  it("a race loser (run moved to Done under the promote) gets no false hold/comment", async () => {
    const { runId, taskId } = (await seedReviewRun()) as unknown as {
      runId: string;
      taskId: string;
    };

    // Simulate the human winner finishing during our promote attempt: the run is
    // Done by the time promoteRun throws its claim CONFLICT.
    mocks.promoteRun.mockImplementation(async () => {
      await db.update(runs).set({ status: "Done" }).where(eq(runs.id, runId));

      throw new MaisterError("CONFLICT", "lost the race");
    });

    const summary = await runAutoPromoteJob({ db, promote: mocks.promoteRun });

    expect(summary.gaveUp).toBe(0);
    expect(summary.skipped).toBe(1);

    const [row] = await db
      .select({ hold: runs.promotionHold, status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId));

    expect(row.hold).toBeNull();
    expect(row.status).toBe("Done");
    expect(await commentCount(taskId)).toBe(0);
  });

  it("a comment failure after a successful promote does not trigger give-up", async () => {
    const { runId, taskId } = (await seedReviewRun()) as unknown as {
      runId: string;
      taskId: string;
    };

    mocks.promoteRun.mockResolvedValue({});
    vi.mocked(addTaskComment).mockRejectedValueOnce(new Error("comment boom"));

    const summary = await runAutoPromoteJob({ db, promote: mocks.promoteRun });

    expect(summary.promoted).toBe(1);
    expect(summary.gaveUp).toBe(0);

    const [row] = await db
      .select({ hold: runs.promotionHold })
      .from(runs)
      .where(eq(runs.id, runId));

    expect(row.hold).toBeNull();
    expect(await commentCount(taskId)).toBe(0);
  });
});
