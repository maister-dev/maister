import type { PlatformStatus } from "@/types/platform-status";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { NextRequest } from "next/server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import * as schemaModule from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// Lineage-guard escape hatches (review findings C-2..C-5): a launched
// evaluation participant must never auto-promote/auto-deliver and its evidence
// must survive — across RESTART (successor participant + evaluation_study hold
// + force-mode launchability), BRANCH SYNC (launched-lineage refusal), WORKTREE
// GC (open-study retention hold), and the PROMOTION-HOLD route (no clearing an
// evaluation_study hold while the study is live). Real Postgres
// (Testcontainers); git/supervisor mocked at the same seams as the
// relaunch-concurrency launch harness.

const schema = schemaModule as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

function readyPlatformStatus(): PlatformStatus {
  return {
    kind: "ready",
    health: {
      status: "ready",
      version: "0.0.1",
      uptimeMs: 1,
      checkedAt: new Date().toISOString(),
      sessions: { live: 0, exited: 0, crashed: 0 },
    },
  };
}

vi.mock("@/lib/supervisor-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/supervisor-client")>();

  return {
    ...actual,
    checkSupervisorHealth: async () => readyPlatformStatus(),
  };
});

vi.mock("@/lib/worktree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/worktree")>();

  return {
    ...actual,
    addWorktree: async (_input: unknown) => undefined,
    removeWorktree: async (_input: unknown) => undefined,
    listBranches: async (_repo: string) => ["main"],
    resolveBaseCommit: async (_args: unknown) =>
      "feedface00000000000000000000000000000000",
  };
});

// Keep the launch synchronous-only: no background runFlow, deterministic
// Pending return.
vi.mock("@/lib/scheduler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/scheduler")>();

  return {
    ...actual,
    tryStartRun: async () => ({ started: false, queuePosition: 1 }),
  };
});
vi.mock("@/lib/flows/runner", () => ({ runFlow: async () => undefined }));

// The promotion-hold route's authz seam; project-role wiring is not under test.
vi.mock("@/lib/authz", () => ({
  requireActiveSession: async () => undefined,
  requireProjectAction: async () => undefined,
}));

let launchRun: typeof import("@/lib/services/runs").launchRun;
let isLaunchedLineageRun: typeof import("@/lib/evaluations/membership").isLaunchedLineageRun;
let syncRunTarget: typeof import("@/lib/runs/sync-target").syncRunTarget;
let runWorkspaceGcSweep: typeof import("@/lib/gc/workspace-gc").runWorkspaceGcSweep;
let holdRoute: typeof import("@/app/api/runs/[runId]/promotion-hold/route");

const instructManifest = {
  schemaVersion: 1,
  name: "Instruct",
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "/aif-implement" },
      transitions: { success: "done" },
      settings: { enforcement: { mcps: "instruct" } },
    },
  ],
};

let projectId: string;
let flowId: string;

async function seedProject(): Promise<void> {
  projectId = `proj-${randomUUID().slice(0, 8)}`;
  flowId = `flow-${projectId}`;
  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug: projectId,
    name: projectId,
    repoPath: `/repos/${projectId}`,
    mainBranch: "main",
    maisterYamlPath: `/repos/${projectId}/maister.yaml`,
  });

  const revisionId = `rev-${projectId}`;

  await db.insert(schema.flowRevisions).values({
    id: revisionId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    versionLabel: "v1.0.0",
    resolvedRevision: projectId.padEnd(40, "x").slice(0, 40),
    manifestDigest: `digest-${projectId}`,
    manifest: instructManifest,
    schemaVersion: 1,
    installedPath: `/cache/${projectId}`,
    setupStatus: "not_required",
    packageStatus: "Installed",
  });
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: `/cache/${projectId}`,
    manifest: instructManifest,
    schemaVersion: 1,
    enabledRevisionId: revisionId,
    enablementState: "Enabled",
    trustStatus: "trusted_by_policy",
  });
}

async function seedTask(): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.tasks).values({
    number: Math.trunc(Math.random() * 1e9) + 1,
    id,
    projectId,
    title: "lineage task",
    prompt: "do it",
    flowId,
  });

  return id;
}

async function seedRun(
  taskId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.runs).values({
    id,
    taskId,
    projectId,
    flowId,
    capabilityAgent: "claude",
    flowVersion: "v1.0.0",
    ...overrides,
  });

  return id;
}

async function seedStudyWithLaunchedParticipant(args: {
  taskId: string;
  runId: string;
  studyStatus?: string;
  participantRemoved?: boolean;
  sourceType?: "launched" | "observed";
}): Promise<{ studyId: string; recipeId: string; participantId: string }> {
  const studyId = randomUUID();
  const recipeId = randomUUID();
  const participantId = randomUUID();
  const launched = (args.sourceType ?? "launched") === "launched";

  await db.insert(schema.evaluationStudies).values({
    id: studyId,
    projectId,
    taskId: args.taskId,
    title: "S",
    status: args.studyStatus ?? "open",
  });
  await db.insert(schema.evaluationRecipes).values({
    id: recipeId,
    studyId,
    key: "recipe-a",
    label: "A",
    definition: {},
    definitionDigest: "d",
  });
  await db.insert(schema.evaluationParticipants).values({
    id: participantId,
    studyId,
    runId: args.runId,
    sourceType: args.sourceType ?? "launched",
    ...(launched
      ? {
          recipeId,
          launchReason: "initial",
          replicateGroup: "recipe-a",
          replicateOrdinal: 1,
        }
      : {}),
    label: launched ? "A #1" : "observed",
    ...(args.participantRemoved ? { removedAt: new Date() } : {}),
  });

  return { studyId, recipeId, participantId };
}

const ctx = { actorUserId: null, authorize: async () => {} };

function budgetRestartInput(taskId: string, oldRunId: string) {
  // The exact shape hitl.ts launchBudgetRestart sends into launchRun.
  return {
    taskId,
    triggerSource: "manual" as const,
    triggerPayload: {
      kind: "budget_restart",
      oldRunId,
      hitlRequestId: "hitl-1",
      idempotencyKey: `budget_restart:${oldRunId}:hitl-1`,
    },
    allowConcurrent: false,
  };
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_eval_lineage_guards_test",
  });
  db = testDatabase.db;

  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow("claude-default", "claude"));
  await db.insert(schema.platformRuntimeSettings).values({
    id: "singleton",
    defaultRunnerId: "claude-default",
  });

  ({ launchRun } = await import("@/lib/services/runs"));
  ({ isLaunchedLineageRun } = await import("@/lib/evaluations/membership"));
  ({ syncRunTarget } = await import("@/lib/runs/sync-target"));
  ({ runWorkspaceGcSweep } = await import("@/lib/gc/workspace-gc"));
  holdRoute = await import("@/app/api/runs/[runId]/promotion-hold/route");
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  await seedProject();
});

describe("C-2 — launched-participant restart", () => {
  it("budget-restarts a launched participant while a study sibling is active: succeeds, successor row + evaluation_study hold", async () => {
    const taskId = await seedTask();
    const oldRunId = await seedRun(taskId, {
      status: "Failed",
      endedAt: new Date(),
    });

    // A study sibling still active — the pre-fix busy gate refused exactly here.
    await seedRun(taskId, { status: "Running" });
    const { studyId, recipeId } = await seedStudyWithLaunchedParticipant({
      taskId,
      runId: oldRunId,
    });

    const result = await launchRun(
      budgetRestartInput(taskId, oldRunId),
      ctx,
      db,
    );

    expect(result.runId).toBeTruthy();

    // The replacement run carries the forced evaluation_study hold.
    const [newRun] = await db
      .select({ promotionHold: schema.runs.promotionHold })
      .from(schema.runs)
      .where(eq(schema.runs.id, result.runId));

    expect(newRun.promotionHold).toMatchObject({ source: "evaluation_study" });
    expect(String(newRun.promotionHold.reason)).toContain(studyId);

    // The successor participant row mirrors the launched lineage on the NEW run.
    const successors = await db
      .select()
      .from(schema.evaluationParticipants)
      .where(eq(schema.evaluationParticipants.runId, result.runId));

    expect(successors).toHaveLength(1);
    expect(successors[0]).toMatchObject({
      studyId,
      sourceType: "launched",
      recipeId,
      replicateGroup: "recipe-a",
      replicateOrdinal: 2,
      launchReason: "manual_relaunch",
      batchItemId: null,
      removedAt: null,
    });

    // The replacement is launched-lineage-held; the dead run's row is untouched.
    expect(await isLaunchedLineageRun(db as any, result.runId)).toBe(true);
    expect(await isLaunchedLineageRun(db as any, oldRunId)).toBe(true);
  });

  it("mirrors a tombstoned source: the successor row is tombstoned but still holds the replacement", async () => {
    const taskId = await seedTask();
    const oldRunId = await seedRun(taskId, {
      status: "Failed",
      endedAt: new Date(),
    });

    await seedStudyWithLaunchedParticipant({
      taskId,
      runId: oldRunId,
      participantRemoved: true,
    });

    const result = await launchRun(
      budgetRestartInput(taskId, oldRunId),
      ctx,
      db,
    );
    const successors = await db
      .select()
      .from(schema.evaluationParticipants)
      .where(eq(schema.evaluationParticipants.runId, result.runId));

    expect(successors).toHaveLength(1);
    expect(successors[0].removedAt).toBeInstanceOf(Date);
    expect(await isLaunchedLineageRun(db as any, result.runId)).toBe(true);
  });

  it("a decided study stops inheriting: the restart launches as a plain run (experiments-rule mirror)", async () => {
    const taskId = await seedTask();
    const oldRunId = await seedRun(taskId, {
      status: "Failed",
      endedAt: new Date(),
    });

    await seedStudyWithLaunchedParticipant({
      taskId,
      runId: oldRunId,
      studyStatus: "decided",
    });

    const result = await launchRun(
      budgetRestartInput(taskId, oldRunId),
      ctx,
      db,
    );
    const [newRun] = await db
      .select({ promotionHold: schema.runs.promotionHold })
      .from(schema.runs)
      .where(eq(schema.runs.id, result.runId));
    const successors = await db
      .select()
      .from(schema.evaluationParticipants)
      .where(eq(schema.evaluationParticipants.runId, result.runId));

    expect(newRun.promotionHold).toBeNull();
    expect(successors).toHaveLength(0);
  });
});

describe("C-5 — evaluation_study promotion hold", () => {
  it("a controlled evaluation launch (seam contract) stamps an evaluation_study hold", async () => {
    const taskId = await seedTask();
    const studyId = randomUUID();

    await db.insert(schema.evaluationStudies).values({
      id: studyId,
      projectId,
      taskId,
      title: "S",
      status: "open",
    });

    const result = await launchRun(
      { taskId, autoPromote: false, evaluationStudyId: studyId },
      ctx,
      db,
    );
    const [run] = await db
      .select({ promotionHold: schema.runs.promotionHold })
      .from(schema.runs)
      .where(eq(schema.runs.id, result.runId));

    expect(run.promotionHold).toMatchObject({ source: "evaluation_study" });
  });

  it("DELETE/PUT refuse mutating an evaluation_study hold while the study is live; DELETE clears after decided", async () => {
    const taskId = await seedTask();
    const runId = await seedRun(taskId, {
      status: "Review",
      promotionHold: {
        source: "evaluation_study",
        reason: "launched evaluation participant",
        createdAt: new Date().toISOString(),
      },
    });
    const { studyId } = await seedStudyWithLaunchedParticipant({
      taskId,
      runId,
    });
    const params = { params: Promise.resolve({ runId }) };

    const del = await holdRoute.DELETE(
      new NextRequest(`http://test/api/runs/${runId}/promotion-hold`, {
        method: "DELETE",
      }),
      params,
    );

    expect(del.status).toBe(409);
    expect((await del.json()).code).toBe("CONFLICT");

    // PUT must not downgrade the hold to `user` (which DELETE would then clear).
    const put = await holdRoute.PUT(
      new NextRequest(`http://test/api/runs/${runId}/promotion-hold`, {
        method: "PUT",
      }),
      params,
    );

    expect(put.status).toBe(409);

    const [held] = await db
      .select({ promotionHold: schema.runs.promotionHold })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId));

    expect(held.promotionHold).toMatchObject({ source: "evaluation_study" });

    // Study decided → the hold releases like any other.
    await db
      .update(schema.evaluationStudies)
      .set({ status: "decided", decidedAt: new Date() })
      .where(eq(schema.evaluationStudies.id, studyId));

    const delAfter = await holdRoute.DELETE(
      new NextRequest(`http://test/api/runs/${runId}/promotion-hold`, {
        method: "DELETE",
      }),
      params,
    );

    expect(delAfter.status).toBe(200);

    const [cleared] = await db
      .select({ promotionHold: schema.runs.promotionHold })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId));

    expect(cleared.promotionHold).toBeNull();
  });

  it("a plain user hold still clears through DELETE", async () => {
    const taskId = await seedTask();
    const runId = await seedRun(taskId, {
      status: "Review",
      promotionHold: {
        source: "user",
        createdAt: new Date().toISOString(),
      },
    });

    const res = await holdRoute.DELETE(
      new NextRequest(`http://test/api/runs/${runId}/promotion-hold`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ runId }) },
    );

    expect(res.status).toBe(200);
  });
});

describe("C-3 — branch sync refuses launched lineage", () => {
  it("a launched participant in Review cannot sync its branch mid-study", async () => {
    const taskId = await seedTask();
    const runId = await seedRun(taskId, { status: "Review" });

    await db.insert(schema.workspaces).values({
      id: randomUUID(),
      runId,
      projectId,
      branch: `maister/task-${taskId}/attempt-1`,
      worktreePath: `/tmp/nonexistent-${runId}`,
      parentRepoPath: `/repos/${projectId}`,
      baseBranch: "main",
    });
    await seedStudyWithLaunchedParticipant({ taskId, runId });

    await expect(
      syncRunTarget({ runId, actor: { type: "user", id: null }, db }),
    ).rejects.toMatchObject({
      code: "PRECONDITION",
      message: expect.stringContaining("participant cannot sync"),
    });
  });
});

describe("C-4 — worktree GC holds open-study evidence", () => {
  it("excludes a launched participant's worktree while the study is open, collects after decided; observed never holds", async () => {
    // Past the GC horizon: DEFAULT_GC_AGE_DAYS = 14 (instance-config.ts), so the
    // collectable runs must have ended earlier than that.
    const fifteenDaysAgo = new Date(Date.now() - 15 * 86_400_000);
    const taskId = await seedTask();

    // Launched participant, open study — must be held back.
    const heldRunId = await seedRun(taskId, {
      status: "Done",
      endedAt: fifteenDaysAgo,
    });
    const heldWorkspaceId = randomUUID();

    await db.insert(schema.workspaces).values({
      id: heldWorkspaceId,
      runId: heldRunId,
      projectId,
      branch: "b-held",
      worktreePath: `/tmp/gone-${heldRunId}`,
      parentRepoPath: `/repos/${projectId}`,
      baseBranch: "main",
    });
    const { studyId } = await seedStudyWithLaunchedParticipant({
      taskId,
      runId: heldRunId,
    });

    // Observed participant of the SAME open study — selection must never change
    // run behavior, so its worktree is collectable.
    const observedRunId = await seedRun(taskId, {
      status: "Done",
      endedAt: fifteenDaysAgo,
    });
    const observedWorkspaceId = randomUUID();

    await db.insert(schema.workspaces).values({
      id: observedWorkspaceId,
      runId: observedRunId,
      projectId,
      branch: "b-observed",
      worktreePath: `/tmp/gone-${observedRunId}`,
      parentRepoPath: `/repos/${projectId}`,
      baseBranch: "main",
    });
    await db.insert(schema.evaluationParticipants).values({
      id: randomUUID(),
      studyId,
      runId: observedRunId,
      sourceType: "observed",
      label: "observed",
    });

    const sweepOpts = {
      db,
      worktreeExists: async () => false,
      deleteRunCheckpointRefs: async () => 0,
    };

    const first = await runWorkspaceGcSweep(sweepOpts);

    expect(first.scanned).toBe(1);
    expect(first.pruned).toBe(1);

    const [heldWs] = await db
      .select({ removedAt: schema.workspaces.removedAt })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, heldWorkspaceId));
    const [observedWs] = await db
      .select({ removedAt: schema.workspaces.removedAt })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, observedWorkspaceId));

    expect(heldWs.removedAt).toBeNull();
    expect(observedWs.removedAt).toBeInstanceOf(Date);

    // Study decided → the retention hold releases.
    await db
      .update(schema.evaluationStudies)
      .set({ status: "decided", decidedAt: new Date() })
      .where(eq(schema.evaluationStudies.id, studyId));

    const second = await runWorkspaceGcSweep(sweepOpts);

    expect(second.scanned).toBe(1);
    expect(second.pruned).toBe(1);

    const [heldAfter] = await db
      .select({ removedAt: schema.workspaces.removedAt })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, heldWorkspaceId));

    expect(heldAfter.removedAt).toBeInstanceOf(Date);
  });
});

describe("ADR-149 — controlled-launch seam idempotency (T1.2)", () => {
  function controlledInput(taskId: string, studyId: string, batchItemId: string) {
    return {
      taskId,
      triggerSource: "manual" as const,
      allowConcurrent: true,
      autoPromote: false,
      evaluationStudyId: studyId,
      evaluationBatchItemId: batchItemId,
    };
  }

  it("launches with the forced evaluation_study hold and persists the batch-item binding", async () => {
    const taskId = await seedTask();
    const studyId = randomUUID();
    const batchItemId = randomUUID();

    const result = await launchRun(
      controlledInput(taskId, studyId, batchItemId),
      ctx,
      db,
    );

    const [run] = await db
      .select({
        promotionHold: schema.runs.promotionHold,
        evaluationBatchItemId: schema.runs.evaluationBatchItemId,
      })
      .from(schema.runs)
      .where(eq(schema.runs.id, result.runId));

    expect(run.promotionHold).toMatchObject({ source: "evaluation_study" });
    expect(String(run.promotionHold.reason)).toContain(studyId);
    expect(run.evaluationBatchItemId).toBe(batchItemId);
  });

  it("adopts the existing run when the same launchKey is re-driven (never a second run)", async () => {
    const taskId = await seedTask();
    const studyId = randomUUID();
    const batchItemId = randomUUID();

    const first = await launchRun(
      controlledInput(taskId, studyId, batchItemId),
      ctx,
      db,
    );
    const second = await launchRun(
      controlledInput(taskId, studyId, batchItemId),
      ctx,
      db,
    );

    expect(second.runId).toBe(first.runId);

    const runs = await db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(eq(schema.runs.evaluationBatchItemId, batchItemId));

    expect(runs).toHaveLength(1);
  });

  it("keeps distinct batch items as distinct runs (no false adoption)", async () => {
    const taskId = await seedTask();
    const studyId = randomUUID();

    const a = await launchRun(
      controlledInput(taskId, studyId, randomUUID()),
      ctx,
      db,
    );
    const b = await launchRun(
      controlledInput(taskId, studyId, randomUUID()),
      ctx,
      db,
    );

    expect(b.runId).not.toBe(a.runId);
  });
});
