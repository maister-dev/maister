// ADR-181 D11 (RED 19): Open PR — a claim-fenced core, driven through the real
// route over real git and real Postgres. The provider is stubbed at the adapter
// seam (`selectPrAdapter`), modelling its real contract (a `generic` provider
// has no adapter); everything on the MAIster side is production.

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
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
import { MaisterError } from "@/lib/errors";
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

const requireProjectAction = vi.fn(async (..._args: unknown[]) => undefined);

vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => ({ id: "user-1" })),
  requireProjectAction: (...args: unknown[]) => requireProjectAction(...args),
}));

type PrArgs = {
  repoPath: string;
  remote: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  body: string;
  draft?: boolean;
};

const PR_URL = "https://github.com/acme/app/pull/42";
const preflight = vi.fn(async () => undefined);
const createOrUpdatePr = vi.fn(async (_args: PrArgs) => ({
  url: PR_URL,
  number: 42,
  reused: false,
}));

vi.mock("@/lib/runs/pr-adapter", () => ({
  selectPrAdapter: vi.fn((provider: string) => {
    // The real dispatch: no adapter for a generic remote.
    if (provider === "generic") {
      throw new MaisterError(
        "PRECONDITION",
        "PR mode unsupported for provider",
      );
    }

    return { preflight, createOrUpdatePr };
  }),
}));

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let root: string;
let repo: BareRemoteRepo;
let POST: typeof import("@/app/api/runs/[runId]/pr/route").POST;

const PUBLIC = "feature/ABC-1-open-a-pr";

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "workbench_git_pr_test",
  });
  db = testDatabase.db;
  ({ POST } = await import("@/app/api/runs/[runId]/pr/route"));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  await clearWorkbenchGitTables(testDatabase.pool);
  const worktreesRoot = process.env.MAISTER_WORKTREES_ROOT ?? tmpdir();

  await mkdir(worktreesRoot, { recursive: true });
  root = await mkdtemp(join(worktreesRoot, "wg-pr-"));
  repo = await initRepoWithBareRemote(root);
  requireProjectAction.mockReset();
  requireProjectAction.mockImplementation(async () => undefined);
  preflight.mockReset();
  preflight.mockImplementation(async () => undefined);
  createOrUpdatePr.mockReset();
  createOrUpdatePr.mockImplementation(async () => ({
    url: PR_URL,
    number: 42,
    reused: false,
  }));
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
    new Request(`http://localhost/api/runs/${runId}/pr`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ runId }) },
  );
}

const SCRATCH_OWNER = "user-1";

// A Failed run whose branch is pushed under its public name and recorded. With
// `scratch`, a Review scratch run whose `scratch_runs` row locks the target.
async function publishedRun(
  opts: {
    published?: boolean;
    publishedRemote?: string;
    prUrl?: string | null;
    provider?: string;
    scratch?: { targetBranch: string | null };
  } = {},
) {
  const branch = `maister/task-${randomUUID().slice(0, 8)}/attempt-1`;
  const worktree = await addRunWorktree(root, repo.parent, branch);
  const remote = opts.publishedRemote ?? "origin";

  if (remote !== "origin") {
    await gitIn(repo.parent, ["remote", "add", remote, repo.remote]);
  }
  if (opts.published !== false) {
    await gitIn(worktree, [
      "push",
      "-q",
      "--set-upstream",
      remote,
      `refs/heads/${branch}:refs/heads/${PUBLIC}`,
    ]);
  }

  if (opts.scratch) {
    await db
      .insert(schema.users)
      .values({
        id: SCRATCH_OWNER,
        email: `${SCRATCH_OWNER}@maister.test`,
        role: "member",
        accountStatus: "active",
        passwordHash: "x",
      })
      .onConflictDoNothing();
  }

  const seed = await seedWorkbenchRun(db, {
    parentRepoPath: repo.parent,
    worktreePath: worktree,
    branch,
    baseCommit: repo.baseSha,
    ...(opts.scratch
      ? {
          runKind: "scratch" as const,
          status: "Review",
          task: null,
          scratch: {
            createdByUserId: SCRATCH_OWNER,
            targetBranch: opts.scratch.targetBranch,
          },
        }
      : {
          status: "Failed",
          taskKey: "ABC",
          task: { number: 1, title: "Open a PR" },
        }),
    published: opts.published === false ? null : { branch: PUBLIC, remote },
    prUrl: opts.prUrl ?? null,
    prNumber: opts.prUrl ? 1 : null,
    prState: opts.prUrl ? "open" : null,
  });

  await db
    .update(schema.projects)
    .set({
      provider: opts.provider ?? "github",
      repoUrl: "https://github.com/acme/app.git",
    })
    .where(eq(schema.projects.id, seed.projectId));

  return { ...seed, branch, worktree };
}

describe("POST /api/runs/{runId}/pr", () => {
  it("opens the PR from the public name to the target, records it, and leaves the run status alone", async () => {
    const run = await publishedRun();

    const res = await post(run.runId, { draft: true });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      runId: run.runId,
      url: PR_URL,
      number: 42,
      state: "open",
      reused: false,
      draft: true,
      targetBranch: "main",
    });
    expect(createOrUpdatePr).toHaveBeenCalledTimes(1);
    expect(createOrUpdatePr).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: repo.parent,
        remote: "origin",
        sourceBranch: PUBLIC,
        targetBranch: "main",
        // C35: the server's defaults are the panel's — the task key and title,
        // and a body linking the run on the request's own origin.
        title: "ABC-1: Open a PR",
        body: expect.stringContaining(`http://localhost/runs/${run.runId}`),
        draft: true,
      }),
    );
    expect(requireProjectAction).toHaveBeenCalledWith(
      run.projectId,
      "promoteRun",
    );
    expect(await workspaceRow(db, run.workspaceId)).toMatchObject({
      prUrl: PR_URL,
      prNumber: 42,
      prState: "open",
      targetBranch: "main",
      lifecycleOperationState: "none",
      lifecycleOperationName: null,
    });
    expect((await runRow(db, run.runId)).status).toBe("Failed");
  });

  it("returns an existing open PR untouched, reporting reused and no draft", async () => {
    createOrUpdatePr.mockImplementation(async () => ({
      url: "https://github.com/acme/app/pull/9",
      number: 9,
      reused: true,
    }));
    const run = await publishedRun();

    const res = await post(run.runId, { draft: true, title: "ignored" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      url: "https://github.com/acme/app/pull/9",
      number: 9,
      reused: true,
      draft: false,
    });
    expect((await workspaceRow(db, run.workspaceId)).prNumber).toBe(9);
  });

  // C27: a different PR must not inherit the old one's ADR-140 evidence.
  it("clears the previous PR's lifecycle fields when a different PR is recorded", async () => {
    const run = await publishedRun({
      prUrl: "https://github.com/acme/app/pull/1",
    });

    await db
      .update(schema.workspaces)
      .set({
        prHasConflicts: true,
        prMergedAt: new Date(),
        prMergeCommitSha: "f".repeat(40),
      })
      .where(eq(schema.workspaces.id, run.workspaceId));

    expect((await post(run.runId)).status).toBe(200);
    expect(await workspaceRow(db, run.workspaceId)).toMatchObject({
      prUrl: PR_URL,
      prNumber: 42,
      prState: "open",
      prHasConflicts: null,
      prMergedAt: null,
      prMergeCommitSha: null,
    });
  });

  it.each([
    ["dirty_worktree", { dirty: true }],
    ["not_published", { published: false }],
    ["published_remote_not_origin", { publishedRemote: "fork" }],
    ["publish_stale", { stale: true }],
    ["target_branch_unknown", { target: "no-such-branch" }],
    ["provider_unsupported", { provider: "generic" }],
  ] as const)("refuses %s with 409 and opens no PR", async (reason, shape) => {
    const run = await publishedRun({
      published: "published" in shape ? shape.published : undefined,
      publishedRemote:
        "publishedRemote" in shape ? shape.publishedRemote : undefined,
      provider: "provider" in shape ? shape.provider : undefined,
    });

    if ("dirty" in shape) {
      await writeFile(join(run.worktree, "scratch.txt"), "dirty\n");
    }
    if ("stale" in shape) {
      await commitFile(run.worktree, "later.txt", "later\n", "after publish");
    }

    const res = await post(
      run.runId,
      "target" in shape ? { targetBranch: shape.target } : {},
    );
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.details?.reason).toBe(reason);
    expect(createOrUpdatePr).not.toHaveBeenCalled();

    const ws = await workspaceRow(db, run.workspaceId);

    expect(ws.prUrl).toBeNull();
    // A typed refusal before the provider call never holds the slot.
    expect(ws.lifecycleOperationState).not.toBe("claiming");
  });

  // D13: a scratch run's target is locked by its `scratch_runs` row, never by
  // the workspace's own `target_branch` (seeded as `main` here).
  it("opens a scratch run's PR onto the target its scratch row locks", async () => {
    await gitIn(repo.parent, ["branch", "release", "main"]);
    await gitIn(repo.parent, ["push", "-q", "origin", "release"]);
    const run = await publishedRun({ scratch: { targetBranch: "release" } });

    const res = await post(run.runId);

    expect(res.status).toBe(200);
    expect((await res.json()).targetBranch).toBe("release");
    expect(createOrUpdatePr).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceBranch: PUBLIC,
        targetBranch: "release",
      }),
    );
    expect((await workspaceRow(db, run.workspaceId)).targetBranch).toBe(
      "release",
    );
  });

  it("refuses a scratch PR onto any other target as target_locked, before a claim or a provider call", async () => {
    await gitIn(repo.parent, ["branch", "release", "main"]);
    await gitIn(repo.parent, ["push", "-q", "origin", "release"]);
    const run = await publishedRun({ scratch: { targetBranch: "release" } });

    const res = await post(run.runId, { targetBranch: "main" });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe("PRECONDITION");
    expect(body.details?.reason).toBe("target_locked");
    expect(createOrUpdatePr).not.toHaveBeenCalled();

    const ws = await workspaceRow(db, run.workspaceId);

    expect(ws.prUrl).toBeNull();
    expect(ws.lifecycleOperationState).not.toBe("claiming");
  });

  it("answers 503 on a transient provider failure, writes nothing and keeps the claim retryable", async () => {
    createOrUpdatePr.mockRejectedValueOnce(
      new MaisterError("EXECUTOR_UNAVAILABLE", "gh pr create failed"),
    );
    const run = await publishedRun();

    expect((await post(run.runId)).status).toBe(503);

    const ws = await workspaceRow(db, run.workspaceId);

    expect(ws.prUrl).toBeNull();
    // D19: a transient failure keeps the claim `claiming` under its lease —
    // retryable once it lapses, like a publish's.
    expect(ws.lifecycleOperationName).toBe("prOpen");
    expect(ws.lifecycleOperationState).toBe("claiming");
  });

  it("refuses unknown body fields with 400", async () => {
    const run = await publishedRun();

    expect((await post(run.runId, { branch: "x" })).status).toBe(400);
    expect(createOrUpdatePr).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown run", async () => {
    expect((await post(randomUUID())).status).toBe(404);
  });

  it("answers 403 below promoteRun and opens nothing", async () => {
    const run = await publishedRun();

    requireProjectAction.mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "viewer below promoteRun"),
    );

    expect((await post(run.runId)).status).toBe(403);
    expect(createOrUpdatePr).not.toHaveBeenCalled();
  });
});
