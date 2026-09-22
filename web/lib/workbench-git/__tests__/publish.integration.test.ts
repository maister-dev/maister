// ADR-181 D4 (RED 7): publish pushes the internal branch under a PUBLIC name.
// Real git (bare remote + parent clone + run worktree) and real Postgres; only
// the session and the project-role check are stubbed. Every assertion reads an
// OUTCOME — the bare remote's refs, the worktree's git config, the workspace row —
// never the push argv.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

import { MaisterError } from "@/lib/errors";
import {
  addRunWorktree,
  advanceRemoteBranch,
  commitFile,
  gitConfigValue,
  gitIn,
  initRepoWithBareRemote,
  remoteHead,
  type BareRemoteRepo,
} from "@/test-support/git-remote-fixture";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  clearWorkbenchGitTables,
  seedWorkbenchRun,
  workspaceRow,
} from "@/test-support/workbench-git-seed";

vi.mock("@/lib/worktree", async (orig) => {
  const actual = await orig<typeof import("@/lib/worktree")>();

  return { ...actual, remoteBranchHead: vi.fn(actual.remoteBranchHead) };
});

let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => ({ id: "user-1" })),
  requireProjectAction: vi.fn(async () => undefined),
}));

const { remoteBranchHead } = await import("@/lib/worktree");
const { exportWorkbenchBranch } = await import(
  "@/lib/workbench-lifecycle/service"
);

let testDatabase: StartedPostgresTestDb;
let root: string;
let repo: BareRemoteRepo;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "workbench_git_publish_test",
  });
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  await clearWorkbenchGitTables(testDatabase.pool);
  root = await mkdtemp(join(tmpdir(), "wg-publish-"));
  repo = await initRepoWithBareRemote(root);
  vi.mocked(remoteBranchHead).mockClear();
});

afterEach(async () => {
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
});

async function seeded(opts: { taskTitle?: string; status?: string } = {}) {
  const branch = `maister/task-${Math.random().toString(36).slice(2)}/attempt-2`;
  const worktree = await addRunWorktree(root, repo.parent, branch);
  const seed = await seedWorkbenchRun(db, {
    parentRepoPath: repo.parent,
    worktreePath: worktree,
    branch,
    baseCommit: repo.baseSha,
    status: opts.status ?? "Failed",
    taskKey: "ABC",
    task: { number: 12, title: opts.taskTitle ?? "Fix login redirect" },
  });

  return { ...seed, branch, worktree };
}

function publish(
  runId: string,
  over: { branchName?: string | null; force?: boolean } = {},
) {
  return exportWorkbenchBranch(runId, {
    remote: "origin",
    branchName: over.branchName ?? null,
    snapshotDirty: false,
    commitMessage: null,
    force: over.force ?? false,
  });
}

async function refusal(p: Promise<unknown>): Promise<MaisterError> {
  const err = await p.then(
    () => {
      throw new Error("expected a refusal");
    },
    (e: unknown) => e,
  );

  expect(err).toBeInstanceOf(MaisterError);

  return err as MaisterError;
}

describe("publish under a public branch name", () => {
  it("renders the template, pushes internal:public with an upstream, and records the publication after the push", async () => {
    const run = await seeded();
    const head = await gitIn(run.worktree, ["rev-parse", "HEAD"]);

    const result = await publish(run.runId);

    expect(result).toMatchObject({
      ok: true,
      branch: run.branch,
      publishedBranch: "feature/ABC-12-fix-login-redirect",
      publishedRemote: "origin",
      publishedRef: "origin/feature/ABC-12-fix-login-redirect",
      pushedRef: "origin/feature/ABC-12-fix-login-redirect",
      nameSource: "template",
    });
    // The public name exists on the remote at the worktree HEAD; the internal
    // name was never pushed.
    expect(
      await remoteHead(repo.remote, "feature/ABC-12-fix-login-redirect"),
    ).toBe(head);
    expect(await remoteHead(repo.remote, run.branch)).toBeNull();
    // --set-upstream with a refspec writes the PUBLIC name into the internal
    // branch's merge config.
    expect(
      await gitConfigValue(repo.parent, `branch.${run.branch}.remote`),
    ).toBe("origin");
    expect(
      await gitConfigValue(repo.parent, `branch.${run.branch}.merge`),
    ).toBe("refs/heads/feature/ABC-12-fix-login-redirect");

    const ws = await workspaceRow(db, run.workspaceId);

    expect(ws.publishedBranch).toBe("feature/ABC-12-fix-login-redirect");
    expect(ws.publishedRemote).toBe("origin");
    expect(ws.publishedAt).toBeInstanceOf(Date);
    // The lease was captured by ls-remote BEFORE the push.
    expect(remoteBranchHead).toHaveBeenCalledWith(
      expect.objectContaining({
        remote: "origin",
        branch: "feature/ABC-12-fix-login-redirect",
      }),
    );
  });

  it("uses an explicit branchName when no upstream fixes the name", async () => {
    const run = await seeded();

    const result = await publish(run.runId, {
      branchName: "feature/hand-picked",
    });

    expect(result.nameSource).toBe("request");
    expect(result.publishedBranch).toBe("feature/hand-picked");
    expect(await remoteHead(repo.remote, "feature/hand-picked")).not.toBeNull();
  });

  it("keeps the upstream's name on the next publish and refuses a different branchName", async () => {
    const run = await seeded();

    await publish(run.runId);

    const refused = await refusal(
      publish(run.runId, { branchName: "feature/another-name" }),
    );

    expect(refused.code).toBe("PRECONDITION");
    expect(refused.details?.reason).toBe("public_name_fixed");
    expect(await remoteHead(repo.remote, "feature/another-name")).toBeNull();

    // A new local commit, then publish with no name: the upstream decides.
    const next = await commitFile(run.worktree, "more.txt", "more\n", "more");
    const again = await publish(run.runId);

    expect(again.nameSource).toBe("upstream");
    expect(
      await remoteHead(repo.remote, "feature/ABC-12-fix-login-redirect"),
    ).toBe(next);
  });

  it("is a no-op push when nothing changed since the last publish", async () => {
    const run = await seeded();

    await publish(run.runId);
    const before = await remoteHead(
      repo.remote,
      "feature/ABC-12-fix-login-redirect",
    );

    expect(before).not.toBeNull();
    await expect(publish(run.runId)).resolves.toMatchObject({ ok: true });
    expect(
      await remoteHead(repo.remote, "feature/ABC-12-fix-login-redirect"),
    ).toBe(before);
  });

  it("refuses a non-fast-forward publish with canForce, keeps the local branch, and records nothing", async () => {
    const run = await seeded();
    const local = await gitIn(run.worktree, ["rev-parse", "HEAD"]);
    // A prior attempt left the public name at an unrelated head.
    const foreign = await advanceRemoteBranch(
      root,
      repo.remote,
      "feature/ABC-12-fix-login-redirect",
    );

    const refused = await refusal(publish(run.runId));

    expect(refused.code).toBe("CONFLICT");
    expect(
      (refused as MaisterError & { pushRejected?: string }).pushRejected,
    ).toBe("non_fast_forward");
    expect((refused as MaisterError & { canForce?: boolean }).canForce).toBe(
      true,
    );
    expect(await gitIn(run.worktree, ["rev-parse", "HEAD"])).toBe(local);
    expect(
      await remoteHead(repo.remote, "feature/ABC-12-fix-login-redirect"),
    ).toBe(foreign);
    expect(
      (await workspaceRow(db, run.workspaceId)).publishedBranch,
    ).toBeNull();
  });

  it("overwrites on force with a fresh explicit-SHA lease", async () => {
    const run = await seeded();
    const local = await gitIn(run.worktree, ["rev-parse", "HEAD"]);

    await advanceRemoteBranch(
      root,
      repo.remote,
      "feature/ABC-12-fix-login-redirect",
    );

    const result = await publish(run.runId, { force: true });

    expect(result.publishedBranch).toBe("feature/ABC-12-fix-login-redirect");
    expect(
      await remoteHead(repo.remote, "feature/ABC-12-fix-login-redirect"),
    ).toBe(local);
  });

  it("refuses a forced publish whose lease went stale, and never overwrites the newer remote head", async () => {
    const run = await seeded();
    const local = await gitIn(run.worktree, ["rev-parse", "HEAD"]);
    const seen = await advanceRemoteBranch(
      root,
      repo.remote,
      "feature/ABC-12-fix-login-redirect",
    );

    // The lease is captured, THEN someone else pushes before our push lands.
    vi.mocked(remoteBranchHead).mockImplementationOnce(async () => {
      await advanceRemoteBranch(
        root,
        repo.remote,
        "feature/ABC-12-fix-login-redirect",
      );

      return seen;
    });

    const refused = await refusal(publish(run.runId, { force: true }));

    expect(refused.code).toBe("CONFLICT");
    expect(
      (refused as MaisterError & { pushRejected?: string }).pushRejected,
    ).toBe("non_fast_forward");
    const remoteNow = await remoteHead(
      repo.remote,
      "feature/ABC-12-fix-login-redirect",
    );

    expect(remoteNow).not.toBe(local);
    expect(remoteNow).not.toBe(seen);
    expect(await gitIn(run.worktree, ["rev-parse", "HEAD"])).toBe(local);
  });

  it("recovers a push that landed before its record was written (crash window)", async () => {
    const run = await seeded();
    const head = await gitIn(run.worktree, ["rev-parse", "HEAD"]);

    // The previous attempt's push succeeded and the process died before the
    // workspace row was written: upstream set, published_* still null.
    await gitIn(repo.parent, [
      "push",
      "-q",
      "--set-upstream",
      "origin",
      `refs/heads/${run.branch}:refs/heads/feature/ABC-12-fix-login-redirect`,
    ]);

    const result = await publish(run.runId);

    expect(result.nameSource).toBe("upstream");
    expect(result.publishedBranch).toBe("feature/ABC-12-fix-login-redirect");
    expect(
      await remoteHead(repo.remote, "feature/ABC-12-fix-login-redirect"),
    ).toBe(head);
    expect((await workspaceRow(db, run.workspaceId)).publishedBranch).toBe(
      "feature/ABC-12-fix-login-redirect",
    );
  });

  it("publishes a task-less run as run-<8hex>", async () => {
    const branch = "maister/agent-x-1a2b3c4d";
    const worktree = await addRunWorktree(root, repo.parent, branch);
    const seed = await seedWorkbenchRun(db, {
      parentRepoPath: repo.parent,
      worktreePath: worktree,
      branch,
      runKind: "agent",
      task: null,
    });

    const result = await publish(seed.runId);

    expect(result.publishedBranch).toBe(
      `feature/run-${seed.runId.slice(0, 8)}`,
    );
  });
});
