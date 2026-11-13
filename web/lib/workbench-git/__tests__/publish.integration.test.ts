// ADR-181 D4 (RED 7): publish pushes the internal branch under a PUBLIC name.
// Real git (bare remote + parent clone + run worktree) and real Postgres; only
// the session and the project-role check are stubbed. Every assertion reads an
// OUTCOME — the bare remote's refs, the worktree's git config, the workspace row —
// never the push argv.

import { mkdtemp, rm } from "node:fs/promises";
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

import { MaisterError } from "@/lib/errors";
import {
  artifactInstances,
  projects,
  runs,
  users,
  workspaces,
} from "@/lib/db/schema";
import { deliverRunIfAutoReady } from "@/lib/runs/auto-delivery";
import { promoteRun } from "@/lib/runs/promote";
import { operationalContractFixture } from "@/test-support/operational-agent";
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

let db: NodePgDatabase<typeof import("@/lib/db/schema")>;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => ({ id: "user-1" })),
  requireProjectAction: vi.fn(async () => undefined),
}));

const { remoteBranchHead } = await import("@/lib/worktree");
const { exportWorkbenchBranch } =
  await import("@/lib/workbench-lifecycle/service");

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
  over: { branchName?: string | null; expectedHead?: string } = {},
) {
  const common = {
    remote: "origin",
    branchName: over.branchName ?? null,
    snapshotDirty: false,
    commitMessage: null,
  };

  // A force is always bound to the head the operator confirmed replacing.
  return exportWorkbenchBranch(
    runId,
    over.expectedHead !== undefined
      ? { ...common, force: true, expectedHead: over.expectedHead }
      : common,
  );
}

async function seedBranchDelivery() {
  const run = await seeded({ status: "Review" });
  const userId = `user-${run.runId}`;

  await db
    .insert(users)
    .values({ id: userId, email: `${userId}@example.invalid` });
  await db
    .update(runs)
    .set({
      createdByUserId: userId,
      deliveryPolicySnapshot: {
        strategy: "publish_branch",
        trigger: "auto_on_ready",
        push: "on_success",
        targetBranch: "main",
      },
    })
    .where(eq(runs.id, run.runId));

  return {
    ...run,
    retry: () =>
      promoteRun(
        run.runId,
        {},
        {
          sessionUser: { id: userId },
          authorize: async () => undefined,
        },
        db,
      ),
  };
}

describe("publish branch delivery", () => {
  const branch = "feature/ABC-12-fix-login-redirect";

  it("waits for review evidence and delivers to a Git-only remote", async () => {
    const run = await seedBranchDelivery();
    const noteId = `review-note-${run.runId}`;
    const head = await gitIn(run.worktree, ["rev-parse", "HEAD"]);

    await gitIn(repo.parent, ["remote", "rename", "origin", "delivery"]);
    await db.insert(artifactInstances).values({
      id: noteId,
      runId: run.runId,
      artifactDefId: "review-note",
      kind: "human_note",
      producer: "human",
      locator: { kind: "inline", text: "Approved" },
      requiredFor: ["review"],
      validity: "stale",
    });
    await expect(run.retry()).rejects.toThrow("evidence not ready");
    expect(await remoteHead(repo.remote, branch)).toBeNull();

    await db
      .update(artifactInstances)
      .set({ validity: "current" })
      .where(eq(artifactInstances.id, noteId));
    await deliverRunIfAutoReady(run.runId, db);

    expect(await remoteHead(repo.remote, branch)).toBe(head);
    expect(await remoteHead(repo.remote, "main")).toBe(repo.baseSha);
    expect(await remoteHead(repo.remote, run.branch)).toBeNull();
    expect(await workspaceRow(db, run.workspaceId)).toMatchObject({
      publishedBranch: branch,
      publishedRemote: "delivery",
      promotionState: "done",
      promotionMode: "publish_branch",
      prUrl: null,
    });
    const [delivered] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, run.runId));

    expect(delivered).toMatchObject({ status: "Done", mergeCommitSha: null });
  });

  it("reclaims an interrupted push using its saved destination and preserves later remote commits", async () => {
    const run = await seedBranchDelivery();

    // The remote write landed, but the process stopped before updating the
    // local upstream and before recording delivery.
    await gitIn(repo.parent, [
      "push",
      "origin",
      `refs/heads/${run.branch}:refs/heads/${branch}`,
    ]);
    const remoteCommit = await advanceRemoteBranch(root, repo.remote, branch);

    await db
      .update(workspaces)
      .set({
        promotionState: "claiming",
        promotionClaimedAt: new Date(0),
        branchDelivery: {
          target: { remote: "origin", remoteBranch: branch },
          error: null,
        },
      })
      .where(eq(workspaces.id, run.workspaceId));
    await db
      .update(projects)
      .set({ publicBranchTemplate: "other/{task_key}" })
      .where(eq(projects.id, run.projectId));

    await expect(run.retry()).rejects.toThrow("git push");
    expect(await remoteHead(repo.remote, branch)).toBe(remoteCommit);
    expect(await remoteHead(repo.remote, "other/ABC-12")).toBeNull();
    expect(await workspaceRow(db, run.workspaceId)).toMatchObject({
      promotionState: "failed",
      publishedBranch: null,
      branchDelivery: {
        target: { remote: "origin", remoteBranch: branch },
        error: expect.stringContaining("git push"),
      },
    });

    await gitIn(run.worktree, ["fetch", "origin"]);
    await gitIn(run.worktree, ["merge", "--ff-only", `origin/${branch}`]);
    await expect(run.retry()).resolves.toMatchObject({
      mode: "publish_branch",
      publication: { remote: "origin", remoteBranch: branch },
    });
    expect(await remoteHead(repo.remote, branch)).toBe(remoteCommit);
    expect(await workspaceRow(db, run.workspaceId)).toMatchObject({
      promotionState: "done",
      publishedBranch: branch,
      branchDelivery: { error: null },
    });
  });
});

type PushRefusal = MaisterError & {
  pushRejected?: string;
  canForce?: boolean;
  remoteHead?: string | null;
  remoteRef?: string;
};

async function refusal(p: Promise<unknown>): Promise<PushRefusal> {
  const err = await p.then(
    () => {
      throw new Error("expected a refusal");
    },
    (e: unknown) => e,
  );

  expect(err).toBeInstanceOf(MaisterError);

  return err as PushRefusal;
}

describe("publish under a public branch name", () => {
  it("IT-OPL-04 refuses operational delivery at service boundaries before any repository or provider mutation", async () => {
    const branch = "maister/operational";
    const worktree = await addRunWorktree(root, repo.parent, branch);
    const seed = await seedWorkbenchRun(db, {
      parentRepoPath: repo.parent,
      worktreePath: worktree,
      branch,
      baseCommit: repo.baseSha,
      status: "Running",
      runKind: "agent",
      agentKind: "operational",
      agentWorkspace: "worktree",
      resultContract: operationalContractFixture(),
    });
    const { finalizeAgentRun } = await import("@/lib/agents/finalization");

    await finalizeAgentRun(seed.runId, "Failed", { db });
    const lifecycle = await import("@/lib/workbench-lifecycle/service");
    const services = await import("@/lib/workbench-git/service");
    const { promoteRun } = await import("@/lib/runs/promote");
    const { syncRunTarget } = await import("@/lib/runs/sync-target");
    const before = await gitIn(repo.remote, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
    ]);
    const refusal = {
      code: "PRECONDITION",
      details: { reason: "operational_delivery_forbidden" },
    };

    for (const action of [
      () => publish(seed.runId),
      () =>
        lifecycle.snapshotWorkbenchCommit(seed.runId, {
          commitMessage: "Forbidden snapshot",
          allowPausedBudgetRun: true,
        }),
      () =>
        lifecycle.createWorkbenchHandoffBranch(seed.runId, {
          remote: "origin",
          handoffBranch: "forbidden-handoff",
          allowPausedBudgetRun: true,
        }),
      () =>
        services.openPullRequest(
          seed.runId,
          {},
          { origin: "http://localhost:3000" },
        ),
      () => services.finalizePullRequestRun(seed.runId, {}),
      () => services.reattachWorkbench(seed.runId),
      () =>
        promoteRun(
          seed.runId,
          { mode: "local_merge", autoOnReady: true },
          { sessionUser: { id: "user-1" }, authorize: async () => undefined },
          db,
        ),
      () =>
        syncRunTarget({
          runId: seed.runId,
          actor: { type: "user", id: "user-1" },
          db,
        }),
    ])
      await expect(action()).rejects.toMatchObject(refusal);
    expect(
      await gitIn(repo.remote, [
        "for-each-ref",
        "--format=%(refname) %(objectname)",
      ]),
    ).toBe(before);
    expect(
      (await workspaceRow(db, seed.workspaceId)).publishedBranch,
    ).toBeNull();
  });
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
    expect(ws.promotionState).toBe("none");
    const [unchanged] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, run.runId));

    expect(unchanged.status).toBe("Failed");
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

  it("refuses a non-fast-forward publish naming the remote head it would replace, and records nothing", async () => {
    const run = await seeded();
    const local = await gitIn(run.worktree, ["rev-parse", "HEAD"]);
    // A prior attempt left the public name at an unrelated head.
    const foreign = await advanceRemoteBranch(
      root,
      repo.remote,
      "feature/ABC-12-fix-login-redirect",
    );

    const refused = await refusal(publish(run.runId));

    expect(refused).toMatchObject({
      code: "CONFLICT",
      pushRejected: "non_fast_forward",
      canForce: true,
      remoteHead: foreign,
      remoteRef: "origin/feature/ABC-12-fix-login-redirect",
    });
    expect(await gitIn(run.worktree, ["rev-parse", "HEAD"])).toBe(local);
    expect(
      await remoteHead(repo.remote, "feature/ABC-12-fix-login-redirect"),
    ).toBe(foreign);
    expect(
      (await workspaceRow(db, run.workspaceId)).publishedBranch,
    ).toBeNull();
  });

  it("overwrites on force exactly the head the operator confirmed", async () => {
    const run = await seeded();
    const local = await gitIn(run.worktree, ["rev-parse", "HEAD"]);

    await advanceRemoteBranch(
      root,
      repo.remote,
      "feature/ABC-12-fix-login-redirect",
    );

    const refused = await refusal(publish(run.runId));
    const result = await publish(run.runId, {
      expectedHead: refused.remoteHead!,
    });

    expect(result.publishedBranch).toBe("feature/ABC-12-fix-login-redirect");
    expect(
      await remoteHead(repo.remote, "feature/ABC-12-fix-login-redirect"),
    ).toBe(local);
  });

  // D4: the confirmation names one head. A remote that moved on after it was
  // shown is someone else's work the operator never saw — the force is refused
  // with the NEW head for a fresh confirmation, never taken by a live re-read.
  it("refuses a confirmed force once the remote moved past the confirmed head, naming the new one", async () => {
    const run = await seeded();
    const local = await gitIn(run.worktree, ["rev-parse", "HEAD"]);

    await advanceRemoteBranch(
      root,
      repo.remote,
      "feature/ABC-12-fix-login-redirect",
    );

    const shown = (await refusal(publish(run.runId))).remoteHead!;
    const newer = await advanceRemoteBranch(
      root,
      repo.remote,
      "feature/ABC-12-fix-login-redirect",
    );
    const refused = await refusal(publish(run.runId, { expectedHead: shown }));

    expect(refused).toMatchObject({
      code: "CONFLICT",
      pushRejected: "non_fast_forward",
      canForce: true,
      remoteHead: newer,
    });
    expect(
      await remoteHead(repo.remote, "feature/ABC-12-fix-login-redirect"),
    ).toBe(newer);
    expect(await gitIn(run.worktree, ["rev-parse", "HEAD"])).toBe(local);
    expect(
      (await workspaceRow(db, run.workspaceId)).publishedBranch,
    ).toBeNull();
  });

  it("refuses a confirmed force whose remote moved between the read and the push, never overwriting the newer head", async () => {
    const run = await seeded();
    const local = await gitIn(run.worktree, ["rev-parse", "HEAD"]);
    const seen = await advanceRemoteBranch(
      root,
      repo.remote,
      "feature/ABC-12-fix-login-redirect",
    );

    // The read answers the confirmed head, THEN someone else pushes before our
    // push lands: only the push's own lease can catch it.
    vi.mocked(remoteBranchHead).mockImplementationOnce(async () => {
      await advanceRemoteBranch(
        root,
        repo.remote,
        "feature/ABC-12-fix-login-redirect",
      );

      return seen;
    });

    const refused = await refusal(publish(run.runId, { expectedHead: seen }));

    expect(refused.code).toBe("CONFLICT");
    expect(refused.pushRejected).toBe("non_fast_forward");
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
