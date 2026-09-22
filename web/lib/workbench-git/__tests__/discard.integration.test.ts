// ADR-181 D7 (RED 9): discard is PRESERVE-FIRST. The dirty tree (staged,
// unstaged AND untracked) is written to refs/maister/rescue/<runId>/<n> through
// a temporary index before `reset --hard` + `clean -fd`. Driven through the real
// route (the wire body is part of the contract) over real git and real Postgres.

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
} from "@/test-support/workbench-git-seed";

vi.mock("@/lib/worktree", async (orig) => {
  const actual = await orig<typeof import("@/lib/worktree")>();

  return {
    ...actual,
    discardWorktreeChanges: vi.fn(actual.discardWorktreeChanges),
  };
});

let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

const requireProjectAction = vi.fn(async (..._args: unknown[]) => undefined);

vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => ({ id: "user-1" })),
  requireProjectAction: (...args: unknown[]) => requireProjectAction(...args),
}));

const { discardWorktreeChanges } = await import("@/lib/worktree");

let testDatabase: StartedPostgresTestDb;
let root: string;
let repo: BareRemoteRepo;
let POST: typeof import("@/app/api/runs/[runId]/discard-changes/route").POST;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "workbench_git_discard_test",
  });
  db = testDatabase.db;
  ({ POST } = await import("@/app/api/runs/[runId]/discard-changes/route"));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  await clearWorkbenchGitTables(testDatabase.pool);
  // Under the test worktrees root: drop removes only a worktree it owns there.
  root = await mkdtemp(
    join(process.env.MAISTER_WORKTREES_ROOT ?? tmpdir(), "wg-discard-"),
  );
  repo = await initRepoWithBareRemote(root);
  requireProjectAction.mockReset();
  requireProjectAction.mockImplementation(async () => undefined);
  vi.mocked(discardWorktreeChanges).mockClear();
});

afterEach(async () => {
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
});

async function seeded() {
  const branch = `maister/task-${Math.random().toString(36).slice(2)}/attempt-1`;
  const worktree = await addRunWorktree(root, repo.parent, branch);

  await writeFile(join(worktree, ".gitignore"), "ignored.log\n");
  await gitIn(worktree, ["add", ".gitignore"]);
  await gitIn(worktree, ["commit", "-q", "-m", "ignore"]);

  const seed = await seedWorkbenchRun(db, {
    parentRepoPath: repo.parent,
    worktreePath: worktree,
    branch,
    baseCommit: repo.baseSha,
    status: "Failed",
  });

  return { ...seed, branch, worktree };
}

// Staged, unstaged, untracked and ignored — every kind of state a tree holds.
async function dirty(worktree: string): Promise<Record<string, string>> {
  await writeFile(join(worktree, "feature.txt"), "staged edit\n");
  await gitIn(worktree, ["add", "feature.txt"]);
  await writeFile(join(worktree, "base.txt"), "unstaged edit\n");
  await writeFile(join(worktree, "brand-new.txt"), "untracked\n");
  await writeFile(join(worktree, "ignored.log"), "ignored\n");

  return {
    "feature.txt": "staged edit\n",
    "base.txt": "unstaged edit\n",
    "brand-new.txt": "untracked\n",
  };
}

function post(runId: string, body: unknown = {}) {
  return POST(
    new Request(`http://localhost/api/runs/${runId}/discard-changes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ runId }) },
  );
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

describe("POST /api/runs/{runId}/discard-changes", () => {
  it("writes the rescue ref first, then leaves a clean tree (ignored files kept)", async () => {
    const run = await seeded();
    const headBefore = await gitIn(run.worktree, ["rev-parse", "HEAD"]);
    const expected = await dirty(run.worktree);

    const res = await post(run.runId);

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toEqual({
      ok: true,
      runId: run.runId,
      rescueRef: `refs/maister/rescue/${run.runId}/1`,
      sha: expect.stringMatching(/^[0-9a-f]{40}$/),
      restoreCommand: `git -C ${run.worktree} restore --source=refs/maister/rescue/${run.runId}/1 -- .`,
    });
    expect(await gitIn(run.worktree, ["status", "--porcelain"])).toBe("");
    expect(await gitIn(run.worktree, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(await exists(join(run.worktree, "ignored.log"))).toBe(true);

    // The rescue commit holds every kind of change, on top of the old HEAD.
    expect(await gitIn(run.worktree, ["rev-parse", `${body.rescueRef}^`])).toBe(
      headBefore,
    );
    for (const [file, content] of Object.entries(expected)) {
      expect(
        await gitIn(run.worktree, ["show", `${body.rescueRef}:${file}`]),
      ).toBe(content.trimEnd());
    }
    await expect(
      gitIn(run.worktree, ["show", `${body.rescueRef}:ignored.log`]),
    ).rejects.toThrow();
  });

  it("restores the discarded bytes from the rescue ref", async () => {
    const run = await seeded();
    const expected = await dirty(run.worktree);
    const body = await (await post(run.runId)).json();

    await gitIn(run.worktree, [
      "restore",
      `--source=${body.rescueRef}`,
      "--",
      ".",
    ]);

    for (const [file, content] of Object.entries(expected)) {
      expect(await readFile(join(run.worktree, file), "utf8")).toBe(content);
    }
  });

  it("refuses a clean tree with details.reason clean_worktree", async () => {
    const run = await seeded();

    const res = await post(run.runId);

    expect(res.status).toBe(409);
    const body = await res.json();

    expect(body.code).toBe("PRECONDITION");
    expect(body.details?.reason).toBe("clean_worktree");
  });

  it("keeps the real index and the rescue ref when the reset dies, and a retry writes a second ref", async () => {
    const run = await seeded();

    await dirty(run.worktree);
    const porcelainBefore = await gitIn(run.worktree, [
      "status",
      "--porcelain",
    ]);

    vi.mocked(discardWorktreeChanges).mockRejectedValueOnce(
      new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        "simulated crash after the rescue",
      ),
    );

    expect((await post(run.runId)).status).toBe(503);
    // Staged stays staged, unstaged stays unstaged, untracked stays untracked:
    // the rescue went through a temporary index.
    expect(await gitIn(run.worktree, ["status", "--porcelain"])).toBe(
      porcelainBefore,
    );
    expect(
      await gitIn(run.worktree, [
        "rev-parse",
        `refs/maister/rescue/${run.runId}/1`,
      ]),
    ).toMatch(/^[0-9a-f]{40}$/);

    // The transient failure left the claim `claiming`: a retry inside its lease
    // is `busy`. Once the lease lapses (the process that held it is gone), the
    // retry reclaims the slot.
    const early = await post(run.runId);

    expect(early.status).toBe(409);
    expect((await early.json()).details?.reason).toBe("busy");
    await testDatabase.pool.query(
      `UPDATE workspaces SET lifecycle_operation_lease_expires_at = now() - interval '1 second' WHERE id = $1`,
      [run.workspaceId],
    );

    const retry = await post(run.runId);

    expect(retry.status).toBe(200);
    expect((await retry.json()).rescueRef).toBe(
      `refs/maister/rescue/${run.runId}/2`,
    );
    expect(await gitIn(run.worktree, ["status", "--porcelain"])).toBe("");
  });

  it("keeps the rescue ref after the workspace is dropped", async () => {
    const run = await seeded();

    await dirty(run.worktree);
    const body = await (await post(run.runId)).json();
    const { dropWorkbench } = await import("@/lib/workbench-lifecycle/service");

    await dropWorkbench(run.runId);

    expect(await exists(run.worktree)).toBe(false);
    expect(await gitIn(repo.parent, ["rev-parse", body.rescueRef])).toBe(
      body.sha,
    );
  });

  it("refuses unknown body fields with 400", async () => {
    const run = await seeded();

    await dirty(run.worktree);

    expect((await post(run.runId, { force: true })).status).toBe(400);
  });

  it("answers 403 to a viewer and touches nothing", async () => {
    const run = await seeded();

    await dirty(run.worktree);
    const porcelainBefore = await gitIn(run.worktree, [
      "status",
      "--porcelain",
    ]);

    requireProjectAction.mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "viewer cannot promoteRun"),
    );

    expect((await post(run.runId)).status).toBe(403);
    expect(await gitIn(run.worktree, ["status", "--porcelain"])).toBe(
      porcelainBefore,
    );
    await expect(
      gitIn(run.worktree, [
        "rev-parse",
        "--verify",
        `refs/maister/rescue/${run.runId}/1`,
      ]),
    ).rejects.toThrow();
  });

  it("answers 404 to an unknown run", async () => {
    expect((await post("00000000-0000-4000-8000-000000000000")).status).toBe(
      404,
    );
  });
});
