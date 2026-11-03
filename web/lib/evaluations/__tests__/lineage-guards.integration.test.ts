import type { Db } from "@/lib/execution-host/db";
import type { PlatformStatus } from "@/types/platform-status";
import type { TaskLaunchFixture } from "@/test-support/task-launch-admission";

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";

import { and, eq, inArray } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { NextRequest } from "next/server";
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

import {
  readyExecutionHostCapabilities,
  TEST_HOST_IDENTITY,
} from "@/test-support/supervisor-health-fixture";
import * as schemaModule from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import { automaticSelectorAdmissionSnapshot } from "@/test-support/automatic-qualification";
import { seedTaskLaunchFixture } from "@/test-support/task-launch-admission";
import { prepareEvaluationEngineFixture } from "@/test-support/evaluation-engine-launch";
import {
  launchConcurrentEngineRun,
  bindAcceptedEngineFixture,
} from "@/test-support/launch-engine-response";
import {
  createControlledLaunchBatch,
  runControlledLaunchBatch,
} from "@/lib/evaluations/launch-batch";
import { defaultLaunchRunSeam } from "@/lib/evaluations/launch-seam";
import { taskLaunchReceipt } from "@/lib/tasks/launch-receipt";
import { interactiveTaskLaunchPrincipal } from "@/lib/tasks/admission-types";
import { cancelInteractiveTaskLaunch } from "@/lib/tasks/launch-cancel";
import { abandonRunInTransaction } from "@/lib/runs/state-transitions";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import { prepareTaskQualification } from "@/lib/tasks/qualification";
import { qualificationFixture } from "@/test-support/task-qualification";
import { mkdtempReal } from "@/test-support/worktree-test-root";
import { git } from "@/test-support/git-fixture";

// Lineage-guard escape hatches (review findings C-2..C-5): a launched
// evaluation participant must never auto-promote/auto-deliver and its evidence
// must survive — across RESTART (successor participant + evaluation_study hold
// + force-mode launchability), BRANCH SYNC (launched-lineage refusal), WORKTREE
// GC (open-study retention hold), and the PROMOTION-HOLD route (no clearing an
// evaluation_study hold while the study is live). Real Postgres
// (Testcontainers), real Git fixtures and source-authorized launch intents;
// model dispatch is disabled at the Flow-driver seam.

const schema = schemaModule as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

function readyPlatformStatus(): PlatformStatus {
  return {
    kind: "ready",
    health: {
      status: "ready",
      host: TEST_HOST_IDENTITY,
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
    getExecutionHostCapabilities: async () => readyExecutionHostCapabilities(),
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
vi.mock("@/lib/authz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/authz")>()),
  requireActiveSession: async () => ({ id: fixture.userId }),
  requireProjectAction: async () => undefined,
}));

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

let root: string;
let fixture: TaskLaunchFixture;
const repositories: string[] = [];

async function seedProject(): Promise<void> {
  fixture = await seedTaskLaunchFixture(
    testDatabase,
    path.join(root, randomUUID()),
  );
  await testDatabase.pool.query("UPDATE projects SET task_key=$2 WHERE id=$1", [
    fixture.projectId,
    `EVAL${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`,
  ]);
  repositories.push(fixture.repo);
  projectId = fixture.projectId;
  flowId = fixture.flowId;
  await db
    .update(schema.flows)
    .set({ manifest: instructManifest })
    .where(eq(schema.flows.id, flowId));
  await db
    .update(schema.flowRevisions)
    .set({ manifest: instructManifest })
    .where(eq(schema.flowRevisions.flowRefId, flowId));
}

async function seedTask(): Promise<string> {
  const db: Db = testDatabase.db;
  const id = randomUUID();

  await db.insert(schema.tasks).values({
    number: Math.trunc(Math.random() * 1e9) + 1,
    id,
    projectId,
    title: "lineage task",
    prompt: "do it",
    flowId,
    runnerId: fixture.runnerId,
  });
  const sha = await git(fixture.repo, "rev-parse", "HEAD");
  const qualification = qualificationFixture();

  qualification.evidenceRefs = [
    { id: "repo", kind: "repository", reference: `git:${sha}:README.md` },
  ];
  const prepared = await prepareTaskQualification(testDatabase.db, {
    projectId,
    taskId: id,
    author: { kind: "user", identity: fixture.userId, userId: fixture.userId },
    request: {
      requestKey: randomUUID(),
      expectedInputRevision: 1,
      expectedQualificationRevision: null,
      qualification,
      flowId,
      runnerId: fixture.runnerId,
      enqueue: false,
    },
  });

  await db.transaction((tx) => prepared.apply(tx));

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
    taskAdmissionSnapshot: await automaticSelectorAdmissionSnapshot(
      testDatabase,
      taskId,
    ),
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

function context() {
  return { actorUserId: fixture.userId, authorize: async () => undefined };
}

async function relaunch(taskId: string, oldRunId: string) {
  return launchConcurrentEngineRun(
    { taskId, relaunchOfRunId: oldRunId, allowConcurrent: true },
    context(),
    testDatabase.db,
  );
}

async function evaluatedSource(taskId: string) {
  const prepared = await prepareEvaluationEngineFixture(
    testDatabase.db,
    { taskId },
    context(),
  );
  const source = await prepared.launch();

  await db
    .update(schema.runs)
    .set({ status: "Failed", endedAt: new Date() })
    .where(eq(schema.runs.id, source.runId));

  return { ...prepared, runId: source.runId };
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

  root = await mkdtempReal("evaluation-lineage-");
  ({ isLaunchedLineageRun } = await import("@/lib/evaluations/membership"));
  ({ syncRunTarget } = await import("@/lib/runs/sync-target"));
  ({ runWorkspaceGcSweep } = await import("@/lib/gc/workspace-gc"));
  holdRoute = await import("@/app/api/runs/[runId]/promotion-hold/route");
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
  for (const repository of repositories) {
    const worktrees = await git(repository, "worktree", "list", "--porcelain");

    for (const line of worktrees.split("\n")) {
      if (line.startsWith("worktree ") && line.slice(9) !== repository)
        await git(repository, "worktree", "remove", "--force", line.slice(9));
    }
  }
  if (root) await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await seedProject();
  await fakeExecutionHosts(testDatabase.db);
});

afterEach(async () => {
  // These technical allocations never dispatch a model. End their live pool
  // reservations explicitly so each case owns only its own capacity effects.
  const created = await testDatabase.db
    .select({ id: schemaModule.executionCommands.id })
    .from(schemaModule.executionCommands)
    .innerJoin(
      schemaModule.runs,
      eq(schemaModule.runs.id, schemaModule.executionCommands.runId),
    )
    .where(
      and(
        eq(schemaModule.runs.projectId, projectId),
        eq(schemaModule.executionCommands.kind, "session.create"),
      ),
    );

  expect(created).toHaveLength(0);
  const intents = await testDatabase.db
    .select()
    .from(schemaModule.taskLaunchIntents)
    .where(
      and(
        eq(schemaModule.taskLaunchIntents.projectId, projectId),
        inArray(schemaModule.taskLaunchIntents.state, [
          "queued",
          "preparing",
          "held",
          "run_bound",
        ]),
      ),
    );
  const principal = await interactiveTaskLaunchPrincipal();

  for (const intent of intents) {
    expect(intent.state).not.toBe("preparing");
    expect(intent.leaseToken).toBeNull();
    expect(intent.dispatchCommittedAt).toBeNull();
    await cancelInteractiveTaskLaunch(
      testDatabase.db,
      principal,
      intent.id,
      { expectedStateVersion: intent.stateVersion },
      randomUUID(),
    );
  }
  const retainedRuns = await testDatabase.db
    .select({
      id: schemaModule.runs.id,
      intentId: schemaModule.runs.taskLaunchIntentId,
    })
    .from(schemaModule.runs)
    .where(
      and(
        eq(schemaModule.runs.projectId, projectId),
        inArray(schemaModule.runs.status, [
          "Pending",
          "Running",
          "NeedsInput",
          "WaitingOnChildren",
        ]),
      ),
    );

  for (const run of retainedRuns) {
    // Only the historical technical rows remain after intent cancellation.
    expect(run.intentId).toBeNull();
    expect(
      await testDatabase.db.transaction((tx) =>
        abandonRunInTransaction(tx, run.id),
      ),
    ).toBe(true);
  }
  const activeIntents = await testDatabase.db
    .select({ id: schemaModule.taskLaunchIntents.id })
    .from(schemaModule.taskLaunchIntents)
    .where(
      and(
        eq(schemaModule.taskLaunchIntents.projectId, projectId),
        inArray(schemaModule.taskLaunchIntents.state, [
          "queued",
          "preparing",
          "held",
          "run_bound",
        ]),
      ),
    );

  expect(activeIntents).toEqual([]);
});

describe("C-2 — launched-participant restart", () => {
  it("explicitly relaunches a launched participant while a study sibling is active: succeeds, successor row + evaluation_study hold", async () => {
    const taskId = await seedTask();
    const {
      runId: oldRunId,
      studyId,
      recipeId,
    } = await evaluatedSource(taskId);

    // A study sibling still active — the pre-fix busy gate refused exactly here.
    await seedRun(taskId, { status: "Running" });
    const result = await relaunch(taskId, oldRunId);
    const [originalParticipant] = await db
      .select()
      .from(schema.evaluationParticipants)
      .where(eq(schema.evaluationParticipants.runId, oldRunId));

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
      replicateGroup: originalParticipant.replicateGroup,
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
    const { runId: oldRunId } = await evaluatedSource(taskId);

    await db
      .update(schema.evaluationParticipants)
      .set({ removedAt: new Date() })
      .where(eq(schema.evaluationParticipants.runId, oldRunId));
    const result = await relaunch(taskId, oldRunId);
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
    const { runId: oldRunId, studyId } = await evaluatedSource(taskId);

    await db
      .update(schema.evaluationStudies)
      .set({ status: "decided", decidedAt: new Date() })
      .where(eq(schema.evaluationStudies.id, studyId));
    const result = await relaunch(taskId, oldRunId);
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
    const prepared = await prepareEvaluationEngineFixture(
      testDatabase.db,
      { taskId },
      context(),
    );
    const result = await prepared.launch();
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
      parentRepoPath: fixture.repo,
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
      parentRepoPath: fixture.repo,
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
      parentRepoPath: fixture.repo,
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

describe("ADR-150 — controlled-launch seam idempotency (T1.2)", () => {
  it("launches with the forced evaluation_study hold and persists the batch-item binding", async () => {
    const taskId = await seedTask();
    const prepared = await prepareEvaluationEngineFixture(
      testDatabase.db,
      { taskId },
      context(),
    );
    const result = await prepared.launch();
    const { studyId, batchItemId } = prepared;

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
    const prepared = await prepareEvaluationEngineFixture(
      testDatabase.db,
      { taskId },
      context(),
    );
    const first = await prepared.launch();
    const second = await prepared.launch();
    const { batchItemId } = prepared;

    expect(second.runId).toBe(first.runId);

    const runs = await db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(eq(schema.runs.evaluationBatchItemId, batchItemId));

    expect(runs).toHaveLength(1);
  });

  it("keeps distinct batch items as distinct runs (no false adoption)", async () => {
    const taskId = await seedTask();
    const prepared = await prepareEvaluationEngineFixture(
      testDatabase.db,
      { taskId },
      context(),
    );
    const a = await prepared.launch();
    const batch = await createControlledLaunchBatch(
      {
        studyId: prepared.studyId,
        projectId,
        requestedByUserId: fixture.userId,
        items: [{ recipeId: prepared.recipeId }],
      },
      testDatabase.db,
    );
    const seam = defaultLaunchRunSeam(context(), testDatabase.db);
    const bound: string[] = [];

    await runControlledLaunchBatch(
      batch.batchId,
      async (args) => {
        const accepted = await seam(args);

        if ("runId" in accepted)
          throw new Error("New batch item reused an existing Run");
        const [intent] = await testDatabase.db
          .select()
          .from(schemaModule.taskLaunchIntents)
          .where(eq(schemaModule.taskLaunchIntents.id, accepted.intentId));

        if (!intent)
          throw new Error("Accepted batch item has no durable intent");
        const next = await bindAcceptedEngineFixture(
          testDatabase.db,
          taskLaunchReceipt(intent),
        );

        bound.push(next.runId);

        return next;
      },
      testDatabase.db,
    );
    expect(bound).toHaveLength(1);
    const b = { runId: bound[0] };

    expect(b.runId).not.toBe(a.runId);
  });

  it("threads a recipe hard-pin slot binding onto the run's session runner", async () => {
    const taskId = await seedTask();
    const prepared = await prepareEvaluationEngineFixture(
      testDatabase.db,
      {
        taskId,
        sessionRunnerOverrides: { default: "claude-default" },
      },
      context(),
    );
    const result = await prepared.launch();
    const { runId } = result;

    const [session] = await db
      .select({ runnerId: schema.runSessions.runnerId })
      .from(schema.runSessions)
      .where(eq(schema.runSessions.runId, runId));

    expect(session.runnerId).toBe("claude-default");
  });
});
