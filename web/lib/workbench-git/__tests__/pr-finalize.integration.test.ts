// ADR-181 D12 (RED 20): finalize a PR-backed run to Done. From Crashed |
// Failed | Abandoned it runs the extracted `finalizePullRequest` under the
// promotion claim; from Review it IS `promoteRun(pull_request)`. Driven through
// the real route over real git and real Postgres; the provider is stubbed at
// the adapter seam.

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { and, eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
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
  addRunWorktree,
  commitFile,
  gitIn,
  initRepoWithBareRemote,
  type BareRemoteRepo,
} from "@/test-support/git-remote-fixture";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  clearWorkbenchGitTables,
  runRow,
  seedWorkbenchRun,
  workspaceRow,
} from "@/test-support/workbench-git-seed";

let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => ({ id: "user-1" })),
  requireProjectAction: vi.fn(async () => undefined),
}));

const PR_URL = "https://github.com/acme/app/pull/42";
const createOrUpdatePr = vi.fn(async (_args: Record<string, unknown>) => ({
  url: PR_URL,
  number: 42,
  reused: true,
}));

vi.mock("@/lib/runs/pr-adapter", () => ({
  selectPrAdapter: vi.fn(() => ({
    preflight: async () => undefined,
    createOrUpdatePr,
  })),
}));

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let root: string;
let repo: BareRemoteRepo;
let POST: typeof import("@/app/api/runs/[runId]/pr/finalize/route").POST;

const PUBLIC = "feature/ABC-2-finalize-me";

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "workbench_git_pr_finalize_test",
  });
  db = testDatabase.db;
  ({ POST } = await import("@/app/api/runs/[runId]/pr/finalize/route"));
  // C41: resolve the mocked module ONCE before any racer — two concurrent
  // first lazy imports can hand the second the real module.
  await import("@/lib/authz");
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  await testDatabase.pool.query(`DELETE FROM "webhook_events"`);
  await testDatabase.pool.query(`DELETE FROM "domain_events"`);
  await clearWorkbenchGitTables(testDatabase.pool);
  const worktreesRoot = process.env.MAISTER_WORKTREES_ROOT ?? tmpdir();

  await mkdir(worktreesRoot, { recursive: true });
  root = await mkdtemp(join(worktreesRoot, "wg-finalize-"));
  repo = await initRepoWithBareRemote(root);
  createOrUpdatePr.mockClear();
});

afterEach(async () => {
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
});

function post(runId: string, body: unknown = {}) {
  return POST(
    new Request(`http://localhost/api/runs/${runId}/pr/finalize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ runId }) },
  );
}

// A run whose branch is published under its public name with an open PR.
async function prRun(
  opts: {
    status?: string;
    runKind?: "flow" | "agent";
    prUrl?: string | null;
    prState?: "open" | "merged" | "closed" | null;
    sharedTreeAllocator?: boolean;
  } = {},
) {
  const branch = `maister/task-${randomUUID().slice(0, 8)}/attempt-1`;
  const worktree = await addRunWorktree(root, repo.parent, branch);
  const head = await gitIn(worktree, ["rev-parse", "HEAD"]);

  await gitIn(worktree, [
    "push",
    "-q",
    "--set-upstream",
    "origin",
    `refs/heads/${branch}:refs/heads/${PUBLIC}`,
  ]);

  const prUrl = opts.prUrl === undefined ? PR_URL : opts.prUrl;
  const seed = await seedWorkbenchRun(db, {
    parentRepoPath: repo.parent,
    worktreePath: worktree,
    branch,
    baseCommit: repo.baseSha,
    status: opts.status ?? "Failed",
    runKind: opts.runKind ?? "flow",
    taskKey: "ABC",
    task: { number: 2, title: "Finalize me" },
    published: { branch: PUBLIC, remote: "origin" },
    prUrl,
    prNumber: prUrl ? 42 : null,
    prState: prUrl ? (opts.prState === undefined ? "open" : opts.prState) : null,
    sharedTreeAllocator: opts.sharedTreeAllocator,
  });

  await db
    .update(schema.projects)
    .set({ provider: "github", repoUrl: "https://github.com/acme/app.git" })
    .where(eq(schema.projects.id, seed.projectId));

  return { ...seed, branch, worktree, head };
}

// A reuser of a shared tree: no workspace row of its own (ADR-102).
async function sharedSibling(
  run: { projectId: string; runId: string },
  status: string,
): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.runs).values({
    id,
    projectId: run.projectId,
    flowVersion: "v1.0.0",
    status,
    runKind: "flow",
    workspaceMode: "shared",
    agentWorkspace: "worktree",
    rootRunId: run.runId,
    parentRunId: run.runId,
    startedAt: new Date(),
  });

  return id;
}

async function webhookTypes(runId: string) {
  return (
    await db
      .select({
        type: schema.webhookEvents.type,
        data: schema.webhookEvents.data,
      })
      .from(schema.webhookEvents)
      .where(eq(schema.webhookEvents.runId, runId))
  ).sort((a: { type: string }, b: { type: string }) =>
    a.type < b.type ? 1 : -1,
  );
}

async function doneEvents(runId: string) {
  return db
    .select()
    .from(schema.domainEvents)
    .where(
      and(
        eq(schema.domainEvents.runId, runId),
        eq(schema.domainEvents.kind, "run.done"),
      ),
    );
}

describe("POST /api/runs/{runId}/pr/finalize", () => {
  it("finalizes a Failed run to Done at its published head, attributed pr_finalize", async () => {
    const run = await prRun();

    const res = await post(run.runId);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      mode: "pull_request",
      pullRequestUrl: PR_URL,
      prNumber: 42,
    });
    expect(await runRow(db, run.runId)).toMatchObject({
      status: "Done",
      promotedHeadSha: run.head,
      mergeCommitSha: null,
    });

    const ws = await workspaceRow(db, run.workspaceId);

    expect(ws).toMatchObject({
      promotionState: "done",
      promotionLane: null,
      prUrl: PR_URL,
      prNumber: 42,
      // Finalize never writes the ADR-140 state (C8).
      prState: "open",
    });
    expect(ws.promotedAt).not.toBeNull();
    expect(ws.scheduledRemovalAt).not.toBeNull();

    const events = await webhookTypes(run.runId);

    expect(events.map((e: { type: string }) => e.type)).toEqual([
      "run.promoted",
      "run.done",
    ]);
    expect(events[0].data).toMatchObject({
      source: "pr_finalize",
      pullRequestUrl: PR_URL,
    });
    expect(await doneEvents(run.runId)).toHaveLength(1);
    // Finalize is DB-only: no provider call on this path.
    expect(createOrUpdatePr).not.toHaveBeenCalled();
  });

  it.each(["Crashed", "Abandoned"])(
    "finalizes a %s run as it does a Failed one",
    async (status) => {
      const run = await prRun({ status });

      expect((await post(run.runId)).status).toBe(200);
      expect((await runRow(db, run.runId)).status).toBe("Done");
    },
  );

  it.each([
    ["pr_missing", { prUrl: null }],
    ["pr_closed", { prState: "closed" as const }],
  ])("refuses %s with 409 and changes nothing", async (reason, shape) => {
    const run = await prRun(shape);

    const res = await post(run.runId);

    expect(res.status).toBe(409);
    expect((await res.json()).details?.reason).toBe(reason);
    expect((await runRow(db, run.runId)).status).toBe("Failed");
    expect((await workspaceRow(db, run.workspaceId)).promotionState).toBe(
      "none",
    );
  });

  it("refuses publish_stale when the local HEAD moved past the published head", async () => {
    const run = await prRun();

    await commitFile(run.worktree, "late.txt", "late\n", "after publish");

    const res = await post(run.runId);

    expect(res.status).toBe(409);
    expect((await res.json()).details?.reason).toBe("publish_stale");
    expect((await runRow(db, run.runId)).status).toBe("Failed");
  });

  it("refuses the Review-only fields for a run that is not Review (400)", async () => {
    const run = await prRun();

    const res = await post(run.runId, { allowTargetDrift: true });

    expect(res.status).toBe(400);
    expect((await res.json()).details?.reason).toBe("review_only_field");
    expect((await runRow(db, run.runId)).status).toBe("Failed");
  });

  it("refuses an already-Done run as unsupported_status", async () => {
    const run = await prRun({ status: "Done" });

    const res = await post(run.runId);

    expect(res.status).toBe(409);
    expect((await res.json()).details?.reason).toBe("unsupported_status");
  });

  it("refuses while a live lifecycle claim holds the tree (one writer per worktree)", async () => {
    const run = await prRun();

    await db
      .update(schema.workspaces)
      .set({
        lifecycleOperationState: "claiming",
        lifecycleOperationName: "exportBranch",
        lifecycleOperationAttemptId: randomUUID(),
        lifecycleOperationClaimedAt: new Date(),
        lifecycleOperationLeaseExpiresAt: new Date(Date.now() + 60_000),
        lifecycleOperationExpectedRunStatus: "Failed",
      })
      .where(eq(schema.workspaces.id, run.workspaceId));

    const res = await post(run.runId);

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CONFLICT");
    expect((await runRow(db, run.runId)).status).toBe("Failed");
  });

  it("lets exactly one of two concurrent finalizes win", async () => {
    const run = await prRun();

    const statuses = (
      await Promise.all([post(run.runId), post(run.runId)])
    ).map((r: Response) => r.status);

    expect(statuses.sort()).toEqual([200, 409]);
    expect(
      (await webhookTypes(run.runId)).map((e: { type: string }) => e.type),
    ).toEqual(["run.promoted", "run.done"]);
    expect(await doneEvents(run.runId)).toHaveLength(1);
  });

  describe("a shared tree (ADR-102)", () => {
    it("settles the tree's Review siblings with the finalized allocator", async () => {
      const run = await prRun({ sharedTreeAllocator: true });
      const sibling = await sharedSibling(run, "Review");

      expect((await post(run.runId)).status).toBe(200);
      expect((await runRow(db, run.runId)).status).toBe("Done");
      expect((await runRow(db, sibling)).status).toBe("Done");
      expect(await doneEvents(sibling)).toHaveLength(1);
    });

    it("refuses with CONFLICT while a sibling is still writable", async () => {
      const run = await prRun({ sharedTreeAllocator: true });
      const sibling = await sharedSibling(run, "Running");

      const res = await post(run.runId);

      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("CONFLICT");
      expect((await runRow(db, run.runId)).status).toBe("Failed");
      expect((await runRow(db, sibling)).status).toBe("Running");
    });
  });

  // One step further (plan RED 20): the finalized run is tracked by the
  // ADR-140 scan, and the delivery scan closes the loop once the PR merged.
  it("is tracked afterwards: the PR scan marks it merged and the delivery scan records the merge", async () => {
    const run = await prRun();

    expect((await post(run.runId)).status).toBe(200);

    const { runPrStateScanJob } = await import(
      "@/lib/scheduler/handlers/pr-state-scan"
    );

    // The provider merges the PR onto `main`.
    await gitIn(repo.parent, [
      "merge",
      "--no-ff",
      "-q",
      "-m",
      "Merge pull request #42",
      run.branch,
    ]);
    await gitIn(repo.parent, ["push", "-q", "origin", "main"]);
    const mergeSha = await gitIn(repo.parent, ["rev-parse", "HEAD"]);

    await runPrStateScanJob({
      projectId: run.projectId,
      db: db as never,
      getPrState: (async () => ({
        kind: "state",
        state: "merged",
        mergedAt: new Date().toISOString(),
        mergeCommitSha: mergeSha,
        hasConflicts: null,
      })) as never,
    });
    expect((await workspaceRow(db, run.workspaceId)).prState).toBe("merged");

    const { runRepoDeliveryScanJob } = await import(
      "@/lib/scheduler/handlers/repo-delivery-scan"
    );

    await runRepoDeliveryScanJob({
      projectId: run.projectId,
      db: db as never,
      prHistoryLookup: async () => ({
        state: "resolved",
        targetSha: mergeSha,
      }),
    });
    expect((await runRow(db, run.runId)).mergeCommitSha).toBe(mergeSha);
  });

  describe("from Review — it is promoteRun(pull_request)", () => {
    it("requires the reviewed target commit, as every manual promotion does", async () => {
      const run = await prRun({ status: "Review", runKind: "agent" });

      const res = await post(run.runId);

      expect(res.status).toBe(409);
      expect((await runRow(db, run.runId)).status).toBe("Review");
    });

    it("refuses target_drift when the target moved since the panel rendered it", async () => {
      const run = await prRun({ status: "Review", runKind: "agent" });

      const res = await post(run.runId, {
        reviewedTargetCommit: "0".repeat(40),
      });

      expect(res.status).toBe(409);
      expect((await res.json()).details?.reason).toBe("target_drift");
      expect((await runRow(db, run.runId)).status).toBe("Review");
    });

    it("promotes through the promotion core: the open PR is reused, the run is Done", async () => {
      const run = await prRun({ status: "Review", runKind: "agent" });

      const res = await post(run.runId, { reviewedTargetCommit: repo.baseSha });

      expect(res.status).toBe(200);
      expect(createOrUpdatePr).toHaveBeenCalledWith(
        expect.objectContaining({ sourceBranch: PUBLIC, targetBranch: "main" }),
      );
      expect(await runRow(db, run.runId)).toMatchObject({
        status: "Done",
        promotedHeadSha: run.head,
      });

      // A promotion is not a pr_finalize: its event carries no such source.
      const promoted = (await webhookTypes(run.runId)).find(
        (e: { type: string }) => e.type === "run.promoted",
      );

      expect(promoted?.data).not.toHaveProperty("source");
    });
  });
});
