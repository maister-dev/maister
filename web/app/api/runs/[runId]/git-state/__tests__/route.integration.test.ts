// ADR-181 D3 (RED 10): GET /api/runs/{runId}/git-state — the lazy read model.
// Real git, real Postgres, the real route; the session and project-role check
// are the only stubs. Also the integration twin of the policy matrix: the facts
// the ONE loader assembles (a Crashed run's retained assignment, a shared
// tree's live sibling, a removed row's resolvable sources) feed the predicate.

import { randomUUID } from "node:crypto";
import { readdir, readFile, rm, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

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
import { seedLocalHost } from "@/test-support/execution-host-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  clearWorkbenchGitTables,
  seedWorkbenchRun,
} from "@/test-support/workbench-git-seed";

const schema = fullSchema as unknown as Record<string, any>;

let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

const requireProjectAction = vi.fn(async (..._args: unknown[]) => undefined);

vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => ({ id: "user-1" })),
  requireProjectAction: (...args: unknown[]) => requireProjectAction(...args),
}));

let testDatabase: StartedPostgresTestDb;
let root: string;
let repo: BareRemoteRepo;
let GET: typeof import("@/app/api/runs/[runId]/git-state/route").GET;

const PUBLIC = "feature/ABC-7-parked-work";

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "workbench_git_state_test",
  });
  db = testDatabase.db;
  ({ GET } = await import("@/app/api/runs/[runId]/git-state/route"));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  await clearWorkbenchGitTables(testDatabase.pool);
  await testDatabase.pool.query(`DELETE FROM "execution_hosts"`);
  root = await mkdtemp(join(tmpdir(), "wg-state-"));
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

function get(runId: string) {
  return GET(new Request(`http://localhost/api/runs/${runId}/git-state`), {
    params: Promise.resolve({ runId }),
  });
}

async function body(runId: string): Promise<Record<string, any>> {
  const res = await get(runId);

  expect(res.status).toBe(200);

  return res.json();
}

function enabled(state: Record<string, any>): string[] {
  return (state.actions as Array<{ id: string; enabled: boolean }>)
    .filter((a) => a.enabled)
    .map((a) => a.id);
}

// A usable Failed run, published under PUBLIC with an upstream, one local
// commit ahead of the publication, one tracked edit and two untracked files.
async function publishedFailedRun() {
  const branch = "maister/task-parked/attempt-1";
  const worktree = await addRunWorktree(root, repo.parent, branch);

  await gitIn(worktree, [
    "push",
    "-q",
    "--set-upstream",
    "origin",
    `refs/heads/${branch}:refs/heads/${PUBLIC}`,
  ]);
  await commitFile(worktree, "later.txt", "later\n", "not yet published");
  await writeFile(join(worktree, "feature.txt"), "edited\n");
  await writeFile(join(worktree, "u1.txt"), "u1\n");
  await writeFile(join(worktree, "u2.txt"), "u2\n");

  const seed = await seedWorkbenchRun(db, {
    parentRepoPath: repo.parent,
    worktreePath: worktree,
    branch,
    baseCommit: repo.baseSha,
    status: "Failed",
    taskKey: "ABC",
    task: { number: 7, title: "Parked work" },
    published: { branch: PUBLIC, remote: "origin" },
  });

  return { ...seed, branch, worktree };
}

describe("GET /api/runs/{runId}/git-state", () => {
  it("returns the exact read model for a usable, published Failed run", async () => {
    const run = await publishedFailedRun();
    const head = await gitIn(run.worktree, ["rev-parse", "HEAD"]);
    const published = await gitIn(repo.parent, [
      "rev-parse",
      `origin/${PUBLIC}`,
    ]);

    const state = await body(run.runId);

    expect(Object.keys(state).sort()).toEqual(
      [
        "actions",
        "aheadBehind",
        "busy",
        "commands",
        "dirty",
        "hasActiveAssignment",
        "hasLiveSharedSibling",
        "head",
        "internalBranch",
        "pr",
        "prDefaults",
        "publicBranch",
        "publishedAt",
        "publishedRemote",
        "publishedRemoteHead",
        "reattachSources",
        "remoteReachable",
        "remotes",
        "rescueRefs",
        "runId",
        "runKind",
        "runStatus",
        "suggestedPublicBranch",
        "targetHead",
        "unpushedCommits",
        "upstream",
        "warnings",
        "workspaceRemoved",
        "worktreePresent",
      ].sort(),
    );
    expect(state).toMatchObject({
      runId: run.runId,
      runKind: "flow",
      runStatus: "Failed",
      internalBranch: run.branch,
      publicBranch: PUBLIC,
      publishedRemote: "origin",
      upstream: { remote: "origin", branch: PUBLIC },
      remotes: ["origin"],
      worktreePresent: true,
      workspaceRemoved: false,
      head,
      targetHead: repo.baseSha,
      dirty: { tracked: 1, untracked: 2 },
      unpushedCommits: 1,
      aheadBehind: {
        base: { ahead: 2, behind: 0 },
        target: { ahead: 2, behind: 0 },
        published: { ahead: 1, behind: 0 },
      },
      publishedRemoteHead: published,
      remoteReachable: true,
      pr: null,
      busy: null,
      hasActiveAssignment: false,
      hasLiveSharedSibling: false,
      reattachSources: { local: null, published: null, archive: null },
      rescueRefs: [],
      warnings: [],
      // The upstream fixes the name; the PR defaults come from the task.
      suggestedPublicBranch: PUBLIC,
      prDefaults: {
        title: "ABC-7: Parked work",
        body: `http://localhost/runs/${run.runId}\n\nPublished ${PUBLIC} → main (run ${run.runId}).`,
        targetBranch: "main",
      },
    });
    expect(state.commands.checkout).toEqual([
      `git -C ${repo.parent} fetch origin ${PUBLIC}`,
      `git -C ${repo.parent} switch --track origin/${PUBLIC}`,
    ]);
    expect(state.commands.restoreRescue).toBeNull();
    expect(enabled(state)).toEqual(
      expect.arrayContaining([
        "snapshotCommit",
        "discardChanges",
        "exportBranch",
        "update",
        "openPr",
      ]),
    );
    expect(enabled(state)).not.toContain("reattach");
  });

  it("names the rescue refs and the restore command after a discard", async () => {
    const run = await publishedFailedRun();

    await gitIn(run.worktree, [
      "update-ref",
      `refs/maister/rescue/${run.runId}/1`,
      "HEAD",
    ]);

    const state = await body(run.runId);

    expect(state.rescueRefs).toEqual([
      {
        ref: `refs/maister/rescue/${run.runId}/1`,
        sha: await gitIn(run.worktree, ["rev-parse", "HEAD"]),
        createdAt: expect.any(String),
      },
    ]);
    expect(state.commands.restoreRescue).toBe(
      `git -C ${run.worktree} restore --source=refs/maister/rescue/${run.runId}/1 -- .`,
    );
  });

  it("degrades to 200 with remoteReachable false when ls-remote fails", async () => {
    const run = await publishedFailedRun();

    await gitIn(repo.parent, [
      "remote",
      "set-url",
      "origin",
      join(root, "vanished-remote.git"),
    ]);

    const state = await body(run.runId);

    expect(state.remoteReachable).toBe(false);
    expect(state.publishedRemoteHead).toBeNull();
    expect(state.warnings).toContain("publishedRemoteHead");
    // The tracking ref still answers the local questions.
    expect(state.unpushedCommits).toBe(1);
  });

  it("offers only reattach for a removed workspace, naming the local source", async () => {
    const branch = "maister/task-removed/attempt-1";
    const worktree = await addRunWorktree(root, repo.parent, branch);
    const tip = await gitIn(worktree, ["rev-parse", "HEAD"]);

    await gitIn(repo.parent, ["worktree", "remove", "--force", worktree]);

    const seed = await seedWorkbenchRun(db, {
      parentRepoPath: repo.parent,
      worktreePath: worktree,
      branch,
      status: "Abandoned",
      removedAt: new Date(),
    });

    const state = await body(seed.runId);

    expect(state).toMatchObject({
      worktreePresent: false,
      workspaceRemoved: true,
      head: null,
      dirty: null,
      unpushedCommits: null,
      reattachSources: { local: tip, published: null, archive: null },
    });
    expect(enabled(state)).toEqual(["reattach"]);
  });

  it("treats a vanished path on a live row (worktree-gone) as not usable", async () => {
    const branch = "maister/task-gone/attempt-1";
    const worktree = await addRunWorktree(root, repo.parent, branch);

    await gitIn(repo.parent, ["worktree", "remove", "--force", worktree]);

    const seed = await seedWorkbenchRun(db, {
      parentRepoPath: repo.parent,
      worktreePath: worktree,
      branch,
      status: "Crashed",
    });

    const state = await body(seed.runId);

    expect(state.worktreePresent).toBe(false);
    expect(state.workspaceRemoved).toBe(false);
    expect(enabled(state)).toEqual(["reattach"]);
    expect(
      state.actions.find((a: { id: string }) => a.id === "exportBranch")
        .disabledReason,
    ).toBe("worktree-missing");
  });

  // C14: a Crashed run keeps its `active` execution assignment by ADR-166
  // design; the status is the no-live-writer witness, the row is information.
  it("admits a Crashed run that still holds its active execution assignment", async () => {
    const branch = "maister/task-crashed/attempt-1";
    const worktree = await addRunWorktree(root, repo.parent, branch);
    const seed = await seedWorkbenchRun(db, {
      parentRepoPath: repo.parent,
      worktreePath: worktree,
      branch,
      status: "Crashed",
    });
    const host = await seedLocalHost(db);

    await db.insert(schema.executionAssignments).values({
      id: randomUUID(),
      runId: seed.runId,
      executionHostId: host.id,
      epoch: 1,
      state: "active",
      placementReason: "launch",
    });

    const state = await body(seed.runId);

    expect(state.hasActiveAssignment).toBe(true);
    expect(enabled(state)).toEqual(
      expect.arrayContaining(["snapshotCommit", "exportBranch", "archive"]),
    );
  });

  it("reports busy while a shared-tree sibling still writes the allocator's tree", async () => {
    const branch = "maister/tree-root/shared";
    const worktree = await addRunWorktree(root, repo.parent, branch);
    const rootRun = await seedWorkbenchRun(db, {
      parentRepoPath: repo.parent,
      worktreePath: join(root, `root-${randomUUID()}`),
      branch: "maister/tree-root/own",
      status: "WaitingOnChildren",
    });
    const allocator = randomUUID();
    const reuser = randomUUID();

    for (const [id, status] of [
      [allocator, "Review"],
      [reuser, "Running"],
    ] as const) {
      await db.insert(schema.runs).values({
        id,
        projectId: rootRun.projectId,
        flowVersion: "v1.0.0",
        status,
        runKind: "flow",
        workspaceMode: "shared",
        agentWorkspace: "worktree",
        rootRunId: rootRun.runId,
        parentRunId: rootRun.runId,
        startedAt: new Date(),
      });
    }
    await db.insert(schema.workspaces).values({
      id: randomUUID(),
      runId: allocator,
      projectId: rootRun.projectId,
      branch,
      worktreePath: worktree,
      parentRepoPath: repo.parent,
    });

    const state = await body(allocator);

    expect(state.hasLiveSharedSibling).toBe(true);
    expect(enabled(state)).toEqual([]);
    expect(
      state.actions.find((a: { id: string }) => a.id === "snapshotCommit")
        .disabledReason,
    ).toBe("busy");
  });

  it("answers 403 to a viewer", async () => {
    const run = await publishedFailedRun();

    requireProjectAction.mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "viewer below recoverRun"),
    );

    expect((await get(run.runId)).status).toBe(403);
    expect(requireProjectAction).toHaveBeenCalledWith(
      run.projectId,
      "recoverRun",
    );
  });

  it("answers 404 to an unknown run", async () => {
    expect((await get(randomUUID())).status).toBe(404);
  });

  // Trap 5: ~10 git calls + one network read — the read model is lazy. Only its
  // own route may import it; a page RSC or the run-detail loader never does.
  it("is imported by its route alone", async () => {
    const webRoot = join(__dirname, "../../../../../..");
    const importers: string[] = [];

    async function walk(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === ".next") continue;
        const full = join(dir, entry.name);

        if (entry.isDirectory()) {
          if (entry.name === "__tests__") continue;
          await walk(full);
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
          const text = await readFile(full, "utf8");

          if (text.includes("@/lib/workbench-git/read-model")) {
            importers.push(relative(webRoot, full));
          }
        }
      }
    }

    for (const top of ["app", "components", "lib"]) {
      await walk(join(webRoot, top));
    }

    expect(importers).toEqual(["app/api/runs/[runId]/git-state/route.ts"]);
  });
});
