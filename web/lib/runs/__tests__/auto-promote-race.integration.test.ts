import type { MaisterError } from "@/lib/errors";

import { randomUUID } from "node:crypto";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import {
  afterAll,
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
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const promoteLocalMergeSpy = vi.fn(async () => undefined);

// Stub the git side-effects so promoteRun's DB claim/finalize logic (the claim
// token + workspaces.promotion_lane write) runs without a real repo.
vi.mock("@/lib/worktree", async (orig) => ({
  ...(await orig<typeof import("@/lib/worktree")>()),
  resolveBaseCommit: vi.fn(async () => "targettip000000"),
  branchExists: vi.fn(async () => true),
  pushBranch: vi.fn(async () => undefined),
  promoteLocalMerge: (...args: unknown[]) =>
    promoteLocalMergeSpy(...(args as [])),
  // ADR-134 delivery evidence: promoteRun's finalize captures a diff stat via
  // git AFTER the merge. These suites deliberately run with NO real repo (the
  // git side effects above are stubbed), and the stat call was added later
  // without joining that list — so it threw, and because
  // `deliveryHistoryStats` maps a git failure to CONFLICT, the promote read it
  // as a rebase conflict and diverted into the resolver path.
  deliveryHistoryStats: vi.fn(async () => ({
    files: 1,
    additions: 1,
    deletions: 0,
  })),
  deliveryCommitStats: vi.fn(async () => ({
    files: 1,
    additions: 1,
    deletions: 0,
  })),
}));

let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

const { promoteRun } = await import("@/lib/runs/promote");

const schema = fullSchema as unknown as Record<string, any>;
const { runs, workspaces, tasks } = schema;

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let projectId: string;
let userId: string;
let runnerId: string;
let flowId: string;

function systemCtx(): any {
  return {
    sessionUser: { id: `auto-promotion:${projectId}` },
    authorize: async () => undefined,
    actor: { kind: "system" },
  };
}

function userCtx(): any {
  return {
    sessionUser: { id: userId },
    authorize: async () => undefined,
    actor: { kind: "user" },
  };
}

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

beforeEach(async () => {
  for (const t of [
    "workspaces",
    "runs",
    "tasks",
    "flows",
    "platform_acp_runners",
    "projects",
    "users",
  ]) {
    await pool.query(`DELETE FROM "${t}"`);
  }

  promoteLocalMergeSpy.mockClear();
  promoteLocalMergeSpy.mockResolvedValue(undefined);

  projectId = randomUUID();
  userId = randomUUID();
  runnerId = randomUUID();
  flowId = randomUUID();

  await db.insert(schema.users).values({ id: userId, email: `u@t.test` });
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

async function seedPromotableRun(): Promise<string> {
  const runId = randomUUID();
  const taskId = randomUUID();

  await db.insert(tasks).values({
    id: taskId,
    projectId,
    number: 1,
    title: "t",
    prompt: "p",
    status: "InFlight",
  });
  await db.insert(runs).values({
    id: runId,
    projectId,
    taskId,
    flowId,
    runnerId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(runnerId),
    flowVersion: "v1.0.0",
    status: "Review",
    runKind: "flow",
    createdByUserId: userId,
  });
  await db.insert(workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch: `maister/${runId.slice(0, 8)}`,
    worktreePath: `/tmp/wt/${runId}`,
    parentRepoPath: `/repos/${projectId}`,
    baseBranch: "main",
    baseCommit: "abc123",
    targetBranch: "main",
    promotionState: "none",
  });

  return runId;
}

function autoPromoteInput(): any {
  return {
    autoOnReady: true,
    mode: "local_merge",
    targetBranch: "main",
    attribution: { source: "auto_promotion", laneClass: "docs" },
  };
}

async function readRun(runId: string): Promise<{ status: string }> {
  const [row] = await db
    .select({ status: runs.status })
    .from(runs)
    .where(eq(runs.id, runId));

  return row;
}

async function readLane(runId: string): Promise<string | null> {
  const [row] = await db
    .select({ lane: workspaces.promotionLane })
    .from(workspaces)
    .where(eq(workspaces.runId, runId));

  return row.lane;
}

describe("promoteRun attribution (T11)", () => {
  it("writes workspaces.promotion_lane on an auto-promotion merge", async () => {
    const runId = await seedPromotableRun();

    await promoteRun(runId, autoPromoteInput(), systemCtx(), db);

    expect((await readRun(runId)).status).toBe("Done");
    expect(await readLane(runId)).toBe("docs");
    expect(promoteLocalMergeSpy).toHaveBeenCalledTimes(1);
  });

  it("leaves promotion_lane NULL for a human promote (no attribution)", async () => {
    const runId = await seedPromotableRun();

    await promoteRun(
      runId,
      { mode: "local_merge", targetBranch: "main", autoOnReady: true },
      userCtx(),
      db,
    );

    expect((await readRun(runId)).status).toBe("Done");
    expect(await readLane(runId)).toBeNull();
  });
});

describe("AC-7 / INV-5 — exactly one promotion wins under concurrency", () => {
  it("sweep (system, attributed) vs human race: one Done, the other CONFLICT/PRECONDITION, merge once", async () => {
    const runId = await seedPromotableRun();

    const results = await Promise.allSettled([
      promoteRun(runId, autoPromoteInput(), systemCtx(), db),
      promoteRun(
        runId,
        { mode: "local_merge", targetBranch: "main", autoOnReady: true },
        userCtx(),
        db,
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(["CONFLICT", "PRECONDITION"]).toContain(
      (rejected[0].reason as MaisterError).code,
    );
    expect((await readRun(runId)).status).toBe("Done");
    // The merge git side-effect ran exactly once (the loser never merged).
    expect(promoteLocalMergeSpy).toHaveBeenCalledTimes(1);
  });
});

describe("promoteRun supersede gate (ADR-126 — Codex F2)", () => {
  it("aborts an attributed promote when a hold landed under the claim; never merges", async () => {
    const runId = await seedPromotableRun();

    await db
      .update(runs)
      .set({
        promotionHold: { source: "user", createdAt: new Date().toISOString() },
      })
      .where(eq(runs.id, runId));

    await expect(
      promoteRun(runId, autoPromoteInput(), systemCtx(), db),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { autoPromotionSuperseded: "held" },
    });

    expect((await readRun(runId)).status).toBe("Review");
    expect(await readLane(runId)).toBeNull();
    expect(promoteLocalMergeSpy).not.toHaveBeenCalled();
  });

  it("aborts an attributed promote when the project lane config was disabled", async () => {
    const runId = await seedPromotableRun();

    await db
      .update(schema.projects)
      .set({ autoPromotion: { enabled: false, lanes: BUILT_IN_LANES } })
      .where(eq(schema.projects.id, projectId));

    await expect(
      promoteRun(runId, autoPromoteInput(), systemCtx(), db),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { autoPromotionSuperseded: "disabled" },
    });

    expect((await readRun(runId)).status).toBe("Review");
    expect(promoteLocalMergeSpy).not.toHaveBeenCalled();
  });

  it("a human promote (no attribution) is NOT blocked by a hold — explicit override merges", async () => {
    const runId = await seedPromotableRun();

    await db
      .update(runs)
      .set({
        promotionHold: { source: "user", createdAt: new Date().toISOString() },
      })
      .where(eq(runs.id, runId));

    await promoteRun(
      runId,
      { mode: "local_merge", targetBranch: "main", autoOnReady: true },
      userCtx(),
      db,
    );

    expect((await readRun(runId)).status).toBe("Done");
    expect(promoteLocalMergeSpy).toHaveBeenCalledTimes(1);
  });
});
