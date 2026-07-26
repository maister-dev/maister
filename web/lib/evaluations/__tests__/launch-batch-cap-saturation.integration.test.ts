import type { PlatformStatus } from "@/types/platform-status";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
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

// Test-Matrix Row 4 (/aif-verify gap): a controlled-launch batch item driven
// while the GLOBAL run cap (MAISTER_MAX_CONCURRENT_RUNS) is saturated must land
// `launched` (its run queued `Pending`), NEVER `failed`. The cap is a QUEUE, not
// a launch refusal — `launchRun` returns a `Pending` run rather than throwing, so
// the default seam returns a runId and the drive records the item `launched`. A
// seam/drive bug that treated the Pending result as a failure would ship uncaught.
//
// This uses the REAL `defaultLaunchRunSeam` → `launchRun` → REAL scheduler
// `tryStartRun` cap gate (git/supervisor/runFlow mocked at the same seams the
// relaunch-concurrency harness uses). `@/lib/scheduler` is DELIBERATELY NOT
// mocked — the real cap is the thing under test.

const schema = schemaModule as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof schemaModule>;

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

// Background runFlow is never invoked on the queued (Pending) path, but mock it
// so a cap-not-saturated regression cannot spawn a real flow run.
vi.mock("@/lib/flows/runner", () => ({ runFlow: async () => undefined }));

let launchRun: typeof import("@/lib/services/runs").launchRun;
let defaultLaunchRunSeam: typeof import("@/lib/evaluations/launch-seam").defaultLaunchRunSeam;
let createStudy: typeof import("@/lib/evaluations/studies").createStudy;
let createControlledRecipe: typeof import("@/lib/evaluations/recipes").createControlledRecipe;
let createControlledLaunchBatch: typeof import("@/lib/evaluations/launch-batch").createControlledLaunchBatch;
let runControlledLaunchBatch: typeof import("@/lib/evaluations/launch-batch").runControlledLaunchBatch;
let maxConcurrentRunsCap: typeof import("@/lib/scheduler").maxConcurrentRunsCap;
let buildFlowContractProjection!: typeof import("@/lib/evaluations/preflight-loaders").buildFlowContractProjection;
let computeInputContractDigest!: typeof import("@/lib/evaluations/recipe").computeInputContractDigest;
let computeArtifactContractDigest!: typeof import("@/lib/evaluations/recipe").computeArtifactContractDigest;

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
    title: "cap task",
    prompt: "do it",
    flowId,
  });

  return id;
}

// A live flow run that holds a scheduler slot (Running ∈ the cap predicate).
async function seedLiveRun(taskId: string): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.runs).values({
    id,
    taskId,
    projectId,
    flowId,
    capabilityAgent: "claude",
    flowVersion: "v1.0.0",
    status: "Running",
  });

  return id;
}

const ctx = { actorUserId: null, authorize: async () => {} };

// Codex-1: the default seam now preflights fail-closed against the LIVE
// contracts, so the recipe must pin the REAL seeded revision with digests
// derived from the same projection the preflight computes.
async function recipeDefinition(): Promise<Record<string, unknown>> {
  const flowRevisionId = `rev-${projectId}`;
  const projection = await buildFlowContractProjection(
    { projectId, flowRefId: "bugfix", flowRevisionId },
    db,
  );

  return {
    schemaVersion: 1,
    flow: {
      flowRefId: "bugfix",
      flowRevisionId,
      inputContractDigest: computeInputContractDigest(projection),
      artifactContractDigest: computeArtifactContractDigest(projection),
    },
    inputs: { taskSnapshotRef: "snap", formValues: {} },
    executionPolicy: { preset: "supervised" },
  };
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_eval_launch_cap_sat_test",
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
  ({ defaultLaunchRunSeam } = await import("@/lib/evaluations/launch-seam"));
  ({ createStudy } = await import("@/lib/evaluations/studies"));
  ({ createControlledRecipe } = await import("@/lib/evaluations/recipes"));
  ({ createControlledLaunchBatch, runControlledLaunchBatch } = await import(
    "@/lib/evaluations/launch-batch"
  ));
  ({ maxConcurrentRunsCap } = await import("@/lib/scheduler"));
  ({ buildFlowContractProjection } = await import(
    "@/lib/evaluations/preflight-loaders"
  ));
  ({ computeInputContractDigest, computeArtifactContractDigest } = await import(
    "@/lib/evaluations/recipe"
  ));

  // Silence the unused-binding lint on the imported symbol; the real seam path
  // is what the drive exercises. (launchRun is imported so a future direct-call
  // assertion can reuse the harness without re-wiring.)
  void launchRun;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  await seedProject();
});

describe("Test-Matrix Row 4 — cap-saturated controlled launch queues Pending", () => {
  it("records the item launched with a Pending run (never failed) when the global cap is saturated", async () => {
    // Saturate the REAL global flow cap: seed exactly `cap` live (Running) flow
    // runs so the next launch cannot start and must queue.
    const cap = maxConcurrentRunsCap();
    const fillerTask = await seedTask();

    for (let i = 0; i < cap; i += 1) {
      await seedLiveRun(fillerTask);
    }

    // A real study + recipe + one-item launch batch on a fresh task.
    const taskId = await seedTask();
    const study = await createStudy({ projectId, taskId, title: "cap" }, db);
    const recipe = await createControlledRecipe(
      {
        studyId: study.id as string,
        projectId,
        key: "a",
        label: "A",
        definition: await recipeDefinition(),
      },
      db,
    );
    const { batchId } = await createControlledLaunchBatch(
      {
        studyId: study.id as string,
        projectId,
        items: [{ recipeId: recipe.id as string }],
      },
      db,
    );

    // Drive the batch through the REAL default seam → REAL launchRun → REAL cap.
    const outcome = await runControlledLaunchBatch(
      batchId,
      defaultLaunchRunSeam(ctx),
      db,
    );

    // The drive must count it launched, not failed — launchRun QUEUED (did not
    // throw) at the saturated cap.
    expect(outcome).toEqual({ launched: 1, failed: 0, skipped: 0 });

    const [item] = await db
      .select()
      .from(schema.evaluationLaunchBatchItems)
      .where(eq(schema.evaluationLaunchBatchItems.batchId, batchId));

    expect(item.status).toBe("launched");
    expect(item.runId).toBeTruthy();
    expect(item.errorReason).toBeNull();

    // The launched run itself is Pending (queued behind the saturated cap): the
    // proof that the cap yields a Pending run rather than a thrown refusal.
    const [run] = await db
      .select({ status: schema.runs.status, runKind: schema.runs.runKind })
      .from(schema.runs)
      .where(eq(schema.runs.id, item.runId));

    expect(run.runKind).toBe("flow");
    expect(run.status).toBe("Pending");

    // Sanity: the run is the one bound to the batch item.
    const [batchItemRun] = await db
      .select({ evaluationBatchItemId: schema.runs.evaluationBatchItemId })
      .from(schema.runs)
      .where(eq(schema.runs.id, item.runId));

    expect(batchItemRun.evaluationBatchItemId).toBe(item.id);
  });
});
