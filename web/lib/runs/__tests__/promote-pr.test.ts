import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createAssignment,
  ensureUserActor,
  findActiveAssignmentForRun,
  systemCloseActiveAssignmentsForRun,
} from "@/lib/assignments/service";
import {
  projects as projectsTable,
  runs as runsTable,
  scratchRuns as scratchRunsTable,
  workspaces as workspacesTable,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { assertEvidenceReady } from "@/lib/flows/graph/evidence-readiness";
import { selectPrAdapter } from "@/lib/runs/pr-adapter";
import {
  branchExists,
  promoteLocalMerge,
  pushBranch,
  resolveBaseCommit,
} from "@/lib/worktree";

// =============================================================================
// M18 Phase 3 — RED until `promoteRun`'s `pull_request` branch lands (it throws
// CONFIG "lands in Phase 3" today), `pushBranch` is added to worktree.ts, and
// `pr-adapter.ts` exists.
//
// UNIT test reusing the Phase-2 promote-service fake-DB harness. The PROVIDER
// boundary is mocked at the SERVICE seam:
//   * `pushBranch` (new worktree helper) → spy
//   * `selectPrAdapter(...).createOrUpdatePr(...)` → spy returning {url, number}
// so neither a real `gh`/`glab` nor a real Gitea `fetch` is touched here. (The
// adapter's own exec/fetch boundary is proven in pr-adapter.test.ts; live
// provider calls are manual-verification only — plan T3.5, "no silent caps".)
//
// ---- PINNED CONTRACT the Implementor builds (promoteRun pull_request branch):
//   preflight(provider) → pushBranch({projectRepoPath, remote, branch}) →
//   selectPrAdapter(provider, ctx).createOrUpdatePr({...}) → finalize stores
//   pr_url/pr_number, run → Done, records the PR artifact.
//   Idempotent by stored workspace.pr_url (set → the adapter UPDATES; no dup).
//   Failure classification (assert BOTH code AND route status via
//   httpStatusForCode — that mapping is pinned in route-status.test.ts):
//     remote unset / generic provider / CLI missing → PRECONDITION → 409
//     push rejected at runtime / PR-API 5xx → EXECUTOR_UNAVAILABLE → 503,
//       run stays Review, NO pr_url written.
// =============================================================================

type Row = Record<string, unknown>;
type Tables = {
  runs: Row[];
  scratch_runs: Row[];
  workspaces: Row[];
  projects: Row[];
};

const dbState: { tables: Tables } = {
  tables: { runs: [], scratch_runs: [], workspaces: [], projects: [] },
};

function tableOf(t: unknown): keyof Tables {
  if (t === runsTable) return "runs";
  if (t === scratchRunsTable) return "scratch_runs";
  if (t === workspacesTable) return "workspaces";
  if (t === projectsTable) return "projects";
  throw new Error("unknown table");
}

function selectChain() {
  const result = (table: unknown) => dbState.tables[tableOf(table)];

  return {
    from: (table: unknown) => {
      const whereResult = {
        for: async (_mode: string) => result(table),
        then: (resolve: (rows: Row[]) => unknown) => resolve(result(table)),
      };

      return {
        where: (_pred?: unknown) => whereResult,
      };
    },
  };
}

function updateChain(table: unknown) {
  return {
    set: (vals: Row) => ({
      where: async (_pred?: unknown) => {
        for (const row of dbState.tables[tableOf(table)]) {
          Object.assign(row, vals);
        }
      },
    }),
  };
}

const fakeDb: Record<string, unknown> = {
  select: selectChain,
  update: updateChain,
  insert: () => ({ values: async () => undefined }),
  execute: async () => undefined,
  transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn(fakeDb),
};

vi.mock("@/lib/db/client", () => ({
  getDb: () => fakeDb,
}));

// `pushBranch` + `selectPrAdapter` are the NEW seams. The createOrUpdatePr spy
// is shared so tests can inspect / reconfigure it.
const createOrUpdatePr = vi.fn(async () => ({
  url: "https://github.com/org/repo/pull/77",
  number: 77,
}));
const preflight = vi.fn(async () => undefined);

vi.mock("@/lib/runs/pr-adapter", () => ({
  selectPrAdapter: vi.fn(() => ({ preflight, createOrUpdatePr })),
}));

vi.mock("@/lib/worktree", () => ({
  branchExists: vi.fn(async () => true),
  promoteLocalMerge: vi.fn(async () => "merged00"),
  pushBranch: vi.fn(async () => undefined),
  resolveBaseCommit: vi.fn(async () => "tip00000"),
  resolveBaseRef: vi.fn(async () => "base0000"),
}));

vi.mock("@/lib/flows/graph/evidence-readiness", () => ({
  assertEvidenceReady: vi.fn(async () => ({ ready: true, reasons: [] })),
}));

vi.mock("@/lib/flows/graph/artifact-store", () => ({
  recordArtifact: vi.fn(async () => undefined),
}));

vi.mock("@/lib/assignments/service", () => ({
  createAssignment: vi.fn(async () => ({ id: "assignment-1" })),
  ensureUserActor: vi.fn(async () => ({ id: "actor-1" })),
  findActiveAssignmentForRun: vi.fn(async () => null),
  systemCloseActiveAssignmentsForRun: vi.fn(async () => []),
}));

vi.mock("@/lib/instance-config", () => ({
  gcAgeDays: () => 7,
  runtimeRoot: () => "/tmp/maister",
  worktreesRoot: () => "/tmp/maister/worktrees",
  promotionClaimTimeoutSeconds: () => 300,
}));

const sessionUser = { id: "user-1", name: "User One", email: "u1@test.com" };
const authorize = vi.fn(async (_projectId: string) => undefined);

function ctx() {
  return { sessionUser, authorize };
}

function seedGithubFlowRun(
  overrides: Partial<{
    prUrl: string | null;
    prNumber: number | null;
    promotionState: string;
    provider: string;
    repoUrl: string | null;
  }> = {},
): string {
  const runId = "run-pr-promote";

  dbState.tables.runs.push({
    id: runId,
    runKind: "flow",
    projectId: "project-1",
    taskId: "task-1",
    status: "Review",
    acpSessionId: "acp-1",
    currentStepId: "review-node",
    endedAt: null,
  });
  dbState.tables.projects.push({
    id: "project-1",
    slug: "demo",
    mainBranch: "main",
    provider: overrides.provider ?? "github",
    repoUrl:
      overrides.repoUrl === undefined
        ? "https://github.com/org/repo.git"
        : overrides.repoUrl,
  });
  dbState.tables.workspaces.push({
    id: "workspace-1",
    runId,
    projectId: "project-1",
    branch: "maister/flow-1",
    worktreePath: "/wt/flow-1",
    parentRepoPath: "/repos/demo",
    removedAt: null,
    baseBranch: "main",
    baseCommit: "base0000",
    targetBranch: "main",
    promotionMode: "pull_request",
    promotionState: overrides.promotionState ?? "none",
    promotionAttemptId: null,
    promotionClaimedAt: null,
    promotionOwnerUserId: null,
    prUrl: overrides.prUrl ?? null,
    prNumber: overrides.prNumber ?? null,
    promotedAt: null,
    scheduledRemovalAt: null,
  });

  return runId;
}

async function callPromote(runId: string, input: Record<string, unknown>) {
  const { promoteRun } = await import("../promote");

  return promoteRun(runId, input as never, ctx() as never);
}

async function expectMaisterCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toMatchObject({ code });
}

beforeEach(() => {
  dbState.tables = { runs: [], scratch_runs: [], workspaces: [], projects: [] };
  vi.mocked(branchExists).mockReset().mockResolvedValue(true);
  vi.mocked(promoteLocalMerge).mockReset().mockResolvedValue("merged00");
  vi.mocked(pushBranch).mockReset().mockResolvedValue(undefined);
  vi.mocked(resolveBaseCommit).mockReset().mockResolvedValue("tip00000");
  vi.mocked(assertEvidenceReady)
    .mockReset()
    .mockResolvedValue({ ready: true, reasons: [] });
  vi.mocked(selectPrAdapter)
    .mockReset()
    .mockReturnValue({ preflight, createOrUpdatePr } as never);
  preflight.mockReset().mockResolvedValue(undefined);
  createOrUpdatePr.mockReset().mockResolvedValue({
    url: "https://github.com/org/repo/pull/77",
    number: 77,
  });
  vi.mocked(createAssignment)
    .mockReset()
    .mockResolvedValue({ id: "assignment-1" } as never);
  vi.mocked(ensureUserActor)
    .mockReset()
    .mockResolvedValue({ id: "actor-1" } as never);
  vi.mocked(findActiveAssignmentForRun).mockReset().mockResolvedValue(null);
  vi.mocked(systemCloseActiveAssignmentsForRun)
    .mockReset()
    .mockResolvedValue([]);
  authorize.mockReset().mockResolvedValue(undefined);
});

// =============================================================================
// happy path — github → preflight → push → createOrUpdatePr → finalize
// =============================================================================

describe("promoteRun — pull_request happy path (github)", () => {
  it("preflights, pushes the branch, creates the PR, persists pr_url/pr_number, run → Done", async () => {
    const runId = seedGithubFlowRun();

    const res = (await callPromote(runId, {
      mode: "pull_request",
      reviewedTargetCommit: "tip00000",
    })) as {
      ok: boolean;
      mode: string;
      pullRequestUrl: string | null;
      prNumber?: number | null;
    };

    expect(res.ok).toBe(true);
    expect(res.mode).toBe("pull_request");
    expect(res.pullRequestUrl).toBe("https://github.com/org/repo/pull/77");
    expect(res.prNumber).toBe(77);

    // Provider dispatch ran against the project's provider.
    expect(selectPrAdapter).toHaveBeenCalledWith("github", expect.anything());
    expect(preflight).toHaveBeenCalledTimes(1);

    // Branch pushed before the PR is opened.
    expect(pushBranch).toHaveBeenCalledWith({
      projectRepoPath: "/repos/demo",
      remote: "origin",
      branch: "maister/flow-1",
    });
    const pushOrder = vi.mocked(pushBranch).mock.invocationCallOrder[0];
    const prOrder = createOrUpdatePr.mock.invocationCallOrder[0];

    expect(pushOrder).toBeLessThan(prOrder);

    // createOrUpdatePr received the source/target branches.
    expect(createOrUpdatePr).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: "/repos/demo",
        sourceBranch: "maister/flow-1",
        targetBranch: "main",
      }),
    );

    // local_merge was NOT used for a PR-mode promotion.
    expect(promoteLocalMerge).not.toHaveBeenCalled();

    // Finalize: run Done, pr_url/pr_number persisted on the workspace.
    expect(dbState.tables.runs[0].status).toBe("Done");
    expect(dbState.tables.workspaces[0].promotionState).toBe("done");
    expect(dbState.tables.workspaces[0].prUrl).toBe(
      "https://github.com/org/repo/pull/77",
    );
    expect(dbState.tables.workspaces[0].prNumber).toBe(77);
    expect(systemCloseActiveAssignmentsForRun).toHaveBeenCalled();
  });

  it("records a PR artifact carrying pr_url/pr_number in its payload", async () => {
    const runId = seedGithubFlowRun();
    const { recordArtifact } = await import("@/lib/flows/graph/artifact-store");

    await callPromote(runId, {
      mode: "pull_request",
      reviewedTargetCommit: "tip00000",
    });

    expect(recordArtifact).toHaveBeenCalled();
    const payloadArg = vi.mocked(recordArtifact).mock.calls.at(-1)?.[0];
    const serialized = JSON.stringify(payloadArg);

    // The PR url/number is captured in the recorded artifact (no new kind — Q3).
    expect(serialized).toContain("https://github.com/org/repo/pull/77");
  });
});

// =============================================================================
// idempotent re-promote — workspace.pr_url already set → adapter UPDATES, no dup
// =============================================================================

describe("promoteRun — idempotent re-promote (pr_url already set)", () => {
  it("re-promote with a stored pr_url calls createOrUpdatePr (UPDATE path), never creating a second PR", async () => {
    // A prior attempt stored the PR, but the run is still Review (e.g. a
    // transient finalize hiccup), so the user re-promotes.
    const runId = seedGithubFlowRun({
      prUrl: "https://github.com/org/repo/pull/77",
      prNumber: 77,
    });

    // The adapter's createOrUpdatePr is idempotent: it detects the existing PR
    // (via the provider query inside the adapter) and updates, returning the
    // SAME url/number.
    createOrUpdatePr.mockResolvedValueOnce({
      url: "https://github.com/org/repo/pull/77",
      number: 77,
    });

    const res = (await callPromote(runId, {
      mode: "pull_request",
      reviewedTargetCommit: "tip00000",
    })) as { ok: boolean; prNumber?: number | null };

    expect(res.ok).toBe(true);
    expect(res.prNumber).toBe(77);
    // Exactly one createOrUpdatePr call — a single PR, updated not duplicated.
    expect(createOrUpdatePr).toHaveBeenCalledTimes(1);
    expect(dbState.tables.workspaces[0].prUrl).toBe(
      "https://github.com/org/repo/pull/77",
    );
    expect(dbState.tables.runs[0].status).toBe("Done");
  });
});

// =============================================================================
// crash-window — PR exists upstream, pr_url unset, claim stale → re-promote
// detects via the provider query and UPDATES (single PR), finalizes Done.
// =============================================================================

describe("promoteRun — crash-window (PR upstream, pr_url unset, stale claim)", () => {
  it("re-promote of a stale claim detects the upstream PR and updates without duplicating, finalizing Done", async () => {
    // Stale `claiming` claim past the timeout (300s mock): a prior attempt
    // pushed + created the PR but crashed before storing pr_url.
    const runId = seedGithubFlowRun({
      promotionState: "claiming",
      prUrl: null,
    });

    dbState.tables.workspaces[0].promotionClaimedAt = new Date(
      Date.now() - 10 * 60_000,
    );
    dbState.tables.workspaces[0].promotionAttemptId = "crashed-token";

    // The adapter's createOrUpdatePr finds the existing PR (provider query) and
    // returns it — no duplicate create.
    createOrUpdatePr.mockResolvedValueOnce({
      url: "https://github.com/org/repo/pull/77",
      number: 77,
    });

    const res = (await callPromote(runId, {
      mode: "pull_request",
      reviewedTargetCommit: "tip00000",
    })) as { ok: boolean; prNumber?: number | null };

    expect(res.ok).toBe(true);
    expect(createOrUpdatePr).toHaveBeenCalledTimes(1);
    expect(dbState.tables.runs[0].status).toBe("Done");
    expect(dbState.tables.workspaces[0].prUrl).toBe(
      "https://github.com/org/repo/pull/77",
    );
    // The reclaim re-minted the attempt token (not the crashed one).
    expect(dbState.tables.workspaces[0].promotionAttemptId).not.toBe(
      "crashed-token",
    );
  });
});

// =============================================================================
// retryable-vs-config split — assert the CODE here; the status mapping
// (PRECONDITION→409, EXECUTOR_UNAVAILABLE→503) is pinned in route-status.test.ts.
// =============================================================================

describe("promoteRun — config failures → PRECONDITION (409), no pr_url, stays Review", () => {
  it("remote unset → PRECONDITION (no push, no PR, no pr_url)", async () => {
    const runId = seedGithubFlowRun({ repoUrl: null });

    // The remote being unconfigured surfaces as a preflight PRECONDITION.
    preflight.mockRejectedValueOnce(
      new MaisterError("PRECONDITION", "remote not configured"),
    );

    await expectMaisterCode(
      callPromote(runId, {
        mode: "pull_request",
        reviewedTargetCommit: "tip00000",
      }),
      "PRECONDITION",
    );

    expect(pushBranch).not.toHaveBeenCalled();
    expect(createOrUpdatePr).not.toHaveBeenCalled();
    expect(dbState.tables.runs[0].status).toBe("Review");
    expect(dbState.tables.workspaces[0].prUrl).toBeNull();
  });

  it("generic provider → PRECONDITION (PR mode unsupported)", async () => {
    const runId = seedGithubFlowRun({ provider: "generic", repoUrl: null });

    // selectPrAdapter throws for a generic provider.
    vi.mocked(selectPrAdapter).mockImplementationOnce(() => {
      throw new MaisterError(
        "PRECONDITION",
        "PR mode unsupported for provider",
      );
    });

    await expectMaisterCode(
      callPromote(runId, {
        mode: "pull_request",
        reviewedTargetCommit: "tip00000",
      }),
      "PRECONDITION",
    );

    expect(pushBranch).not.toHaveBeenCalled();
    expect(dbState.tables.runs[0].status).toBe("Review");
  });
});

describe("promoteRun — transient failures → EXECUTOR_UNAVAILABLE (503), no pr_url, stays Review", () => {
  it("push rejected at runtime → EXECUTOR_UNAVAILABLE, run stays Review, no pr_url", async () => {
    const runId = seedGithubFlowRun();

    vi.mocked(pushBranch).mockRejectedValueOnce(
      new MaisterError("EXECUTOR_UNAVAILABLE", "push rejected (retryable)"),
    );

    await expectMaisterCode(
      callPromote(runId, {
        mode: "pull_request",
        reviewedTargetCommit: "tip00000",
      }),
      "EXECUTOR_UNAVAILABLE",
    );

    expect(createOrUpdatePr).not.toHaveBeenCalled();
    expect(dbState.tables.runs[0].status).toBe("Review");
    expect(dbState.tables.workspaces[0].prUrl).toBeNull();
    // The durable claim is NOT marked done; a same-attempt retry / stale reclaim
    // can resume (transient leaves promotion_state='claiming' per §3.2).
    expect(dbState.tables.workspaces[0].promotionState).not.toBe("done");
  });

  it("PR-API 5xx → EXECUTOR_UNAVAILABLE, run stays Review, no pr_url", async () => {
    const runId = seedGithubFlowRun();

    createOrUpdatePr.mockRejectedValueOnce(
      new MaisterError("EXECUTOR_UNAVAILABLE", "PR API 503 (retryable)"),
    );

    await expectMaisterCode(
      callPromote(runId, {
        mode: "pull_request",
        reviewedTargetCommit: "tip00000",
      }),
      "EXECUTOR_UNAVAILABLE",
    );

    expect(pushBranch).toHaveBeenCalledTimes(1);
    expect(dbState.tables.runs[0].status).toBe("Review");
    expect(dbState.tables.workspaces[0].prUrl).toBeNull();
    expect(dbState.tables.workspaces[0].promotionState).not.toBe("done");
  });
});
