// ADR-181 D10 (RED 17): a removed (or vanished) worktree is re-attached from
// the first source that resolves — the local branch, then the publication, then
// the archive ref — with provenance v2 rebuilt from the database, and the row
// flips back to present only AFTER the worktree exists. Driven through the real
// route over real git and real Postgres.

import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
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
  gitConfigValue,
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

const { installWorktreeProvenance, readWorktreeProvenanceMetadata } =
  await import("@/lib/worktree-provenance");

let testDatabase: StartedPostgresTestDb;
let root: string;
let repo: BareRemoteRepo;
let POST: typeof import("@/app/api/runs/[runId]/reattach/route").POST;

const PUBLIC = "feature/ABC-9-bring-it-back";

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "workbench_git_reattach_test",
  });
  db = testDatabase.db;
  ({ POST } = await import("@/app/api/runs/[runId]/reattach/route"));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  await clearWorkbenchGitTables(testDatabase.pool);
  const worktreesRoot = process.env.MAISTER_WORKTREES_ROOT ?? tmpdir();

  await mkdir(worktreesRoot, { recursive: true });
  root = await mkdtemp(join(worktreesRoot, "wg-reattach-"));
  repo = await initRepoWithBareRemote(root);
  requireProjectAction.mockReset();
  requireProjectAction.mockImplementation(async () => undefined);
});

afterEach(async () => {
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
});

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function post(runId: string, body: unknown = {}) {
  return POST(
    new Request(`http://localhost/api/runs/${runId}/reattach`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ runId }) },
  );
}

// A dropped run: the worktree is gone from disk and the row says removed. The
// local branch, the publication and the archive ref exist only when asked for.
async function removedRun(opts: {
  keepLocal: boolean;
  published?: boolean;
  archive?: boolean;
}) {
  const branch = `maister/task-${Math.random().toString(36).slice(2)}/attempt-1`;
  const worktree = await addRunWorktree(root, repo.parent, branch);
  const tip = await gitIn(worktree, ["rev-parse", "HEAD"]);

  if (opts.published) {
    await gitIn(worktree, [
      "push",
      "-q",
      "--set-upstream",
      "origin",
      `refs/heads/${branch}:refs/heads/${PUBLIC}`,
    ]);
  }

  const archivedBranch = opts.archive
    ? `maister/archive/${Math.random().toString(36).slice(2)}`
    : null;

  if (archivedBranch) await gitIn(repo.parent, ["branch", archivedBranch, tip]);
  await gitIn(repo.parent, ["worktree", "remove", "--force", worktree]);
  if (!opts.keepLocal) await gitIn(repo.parent, ["branch", "-D", branch]);

  const seed = await seedWorkbenchRun(db, {
    parentRepoPath: repo.parent,
    worktreePath: worktree,
    branch,
    baseCommit: repo.baseSha,
    status: "Abandoned",
    taskKey: "ABC",
    task: { number: 9, title: "Bring it back" },
    removedAt: new Date(),
    archivedBranch,
    published: opts.published ? { branch: PUBLIC, remote: "origin" } : null,
  });

  return { ...seed, branch, worktree, tip, archivedBranch };
}

describe("POST /api/runs/{runId}/reattach", () => {
  it("re-attaches from the local branch, rebuilds provenance, then clears the removal", async () => {
    const run = await removedRun({ keepLocal: true, archive: true });

    const res = await post(run.runId);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      runId: run.runId,
      source: "local",
      head: run.tip,
    });
    expect(
      await gitIn(run.worktree, ["rev-parse", "--abbrev-ref", "HEAD"]),
    ).toBe(run.branch);
    await expect(
      readWorktreeProvenanceMetadata(run.worktree),
    ).resolves.toMatchObject({
      version: 2,
      runId: run.runId,
      branch: run.branch,
      parentRepoPath: repo.parent,
      projectId: run.projectId,
      task: "ABC-9",
    });

    const ws = await workspaceRow(db, run.workspaceId);

    expect(ws.removedAt).toBeNull();
    expect(ws.scheduledRemovalAt).toBeNull();
    // The archive ref is the operator's recovery point; a re-attach keeps it.
    expect(ws.archivedBranch).toBe(run.archivedBranch);
    expect(ws.lifecycleOperationState).toBe("none");
  });

  it("re-attaches from the publication when the local branch is gone, re-setting the upstream", async () => {
    const run = await removedRun({ keepLocal: false, published: true });

    const res = await post(run.runId);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      source: "published",
      head: run.tip,
    });
    // The next publish keeps the public name because the upstream names it.
    expect(
      await gitConfigValue(repo.parent, `branch.${run.branch}.merge`),
    ).toBe(`refs/heads/${PUBLIC}`);

    const { exportWorkbenchBranch } = await import(
      "@/lib/workbench-lifecycle/service"
    );
    const published = await exportWorkbenchBranch(run.runId, {
      remote: "origin",
      branchName: null,
      snapshotDirty: false,
      commitMessage: null,
      force: false,
    });

    expect(published).toMatchObject({
      nameSource: "upstream",
      publishedBranch: PUBLIC,
    });
  });

  it("re-attaches from the archive ref when neither the branch nor a publication exists", async () => {
    const run = await removedRun({ keepLocal: false, archive: true });

    const res = await post(run.runId);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      source: "archive",
      head: run.tip,
    });
    expect(
      await gitIn(run.worktree, ["rev-parse", "--abbrev-ref", "HEAD"]),
    ).toBe(run.branch);
  });

  it("refuses when no source resolves, and creates nothing", async () => {
    const run = await removedRun({ keepLocal: false });

    const res = await post(run.runId);

    expect(res.status).toBe(409);
    expect((await res.json()).details?.reason).toBe("no_reattach_source");
    expect(await exists(run.worktree)).toBe(false);
    expect((await workspaceRow(db, run.workspaceId)).removedAt).not.toBeNull();
  });

  it("refuses an occupied worktree path and leaves the directory untouched", async () => {
    const run = await removedRun({ keepLocal: true });

    await mkdir(run.worktree, { recursive: true });
    await writeFile(join(run.worktree, "someone-elses.txt"), "keep me\n");

    const res = await post(run.runId);

    expect(res.status).toBe(409);
    const body = await res.json();

    expect(body.code).toBe("CONFLICT");
    expect(body.details?.reason).toBe("worktree_path_occupied");
    expect(
      await readFile(join(run.worktree, "someone-elses.txt"), "utf8"),
    ).toBe("keep me\n");
    expect((await workspaceRow(db, run.workspaceId)).removedAt).not.toBeNull();
  });

  // C31: a retry after a crash between `worktree add` and the row write finds
  // its OWN worktree — registered, on the internal branch, provenance naming
  // this run — and adopts it rather than refusing or adding a second one.
  it("adopts its own crashed attempt instead of refusing the path", async () => {
    const run = await removedRun({ keepLocal: true });

    await gitIn(repo.parent, [
      "worktree",
      "add",
      "-q",
      run.worktree,
      run.branch,
    ]);
    await installWorktreeProvenance({
      worktreePath: run.worktree,
      metadata: {
        version: 2,
        runId: run.runId,
        parentRepoPath: repo.parent,
        projectId: run.projectId,
        branch: run.branch,
        workspaceKind: "flow",
        createdAt: new Date().toISOString(),
      },
    });

    const res = await post(run.runId);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ source: "local", head: run.tip });
    expect((await workspaceRow(db, run.workspaceId)).removedAt).toBeNull();

    const registered = (
      await gitIn(repo.parent, ["worktree", "list", "--porcelain"])
    )
      .split("\n")
      .filter((line) => line === `worktree ${run.worktree}`);

    expect(registered).toHaveLength(1);
  });

  it("refuses unknown body fields with 400", async () => {
    const run = await removedRun({ keepLocal: true });

    expect((await post(run.runId, { source: "archive" })).status).toBe(400);
  });

  it("answers 403 below recoverRun and touches nothing", async () => {
    const run = await removedRun({ keepLocal: true });

    requireProjectAction.mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "viewer below recoverRun"),
    );

    expect((await post(run.runId)).status).toBe(403);
    expect(requireProjectAction).toHaveBeenCalledWith(
      run.projectId,
      "recoverRun",
    );
    expect(await exists(run.worktree)).toBe(false);
  });

  it("answers 404 to an unknown run", async () => {
    expect((await post("00000000-0000-4000-8000-000000000000")).status).toBe(
      404,
    );
  });
});
