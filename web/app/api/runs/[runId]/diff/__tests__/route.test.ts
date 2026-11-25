import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireProjectAction } from "@/lib/authz";
import { assertRunKnowledgeDisclosure } from "@/lib/brain/knowledge-run-disclosure";
import {
  hitlRequests as hitlRequestsTable,
  nodeAttempts as nodeAttemptsTable,
  projects as projectsTable,
  runs as runsTable,
  scratchRuns as scratchRunsTable,
  workspaces as workspacesTable,
} from "@/lib/db/schema";
import {
  buildPreparedDiffCacheEntry,
  clearPreparedDiffCache,
  setCachedPreparedDiff,
} from "@/lib/diff/cache";
import { prepareDiff } from "@/lib/diff/prepare";
import { MaisterError } from "@/lib/errors";
import {
  diffNameStatus,
  diffRunWorkspace,
  diffWorkingTree,
  resolveBaseRef,
  resolveRefSha,
} from "@/lib/worktree";

// M22 Phase 5 (T5.2, RED): the diff route now dispatches on `run.runKind`.
//   - SCRATCH path is UNCHANGED (readScratchRun, no `files`) — all the existing
//     scratch cases below MUST stay green.
//   - FLOW path is NEW: load run (must be flow) + its non-removed `workspaces`
//     row + the `projects` row (for mainBranch); requireProjectAction(projectId,
//     "readBoard"); base = workspace.baseCommit ?? resolveBaseRef({worktreePath,
//     branch, mainBranch}); diff = diffRunWorkspace({projectRepoPath:
//     worktreePath, baseCommit: base, branch}); files = diffNameStatus(
//     {worktreePath, baseRef: base, branch}); respond 200 with {runId, baseCommit,
//     sourceBranch, targetBranch, diff, files}.
//
// The route uses a fakeDb (raw db.select), so this MIGRATES the old
// "rejects non-scratch runs → 409" assertion into a flow-run SUCCESS (200) and
// adds the null-baseCommit/resolveBaseRef, removed-workspace, and viewer-denied
// flow cases. RED until the route is extended.

type Row = Record<string, unknown>;
type Tables = {
  runs: Row[];
  scratch_runs: Row[];
  workspaces: Row[];
  projects: Row[];
  // M30 (ADR-082): the scope availability map reads these two.
  hitl_requests: Row[];
  node_attempts: Row[];
};

const dbState: { tables: Tables } = {
  tables: {
    runs: [],
    scratch_runs: [],
    workspaces: [],
    projects: [],
    hitl_requests: [],
    node_attempts: [],
  },
};

function tableOf(t: unknown): keyof Tables {
  if (t === runsTable) return "runs";
  if (t === scratchRunsTable) return "scratch_runs";
  if (t === workspacesTable) return "workspaces";
  if (t === projectsTable) return "projects";
  if (t === hitlRequestsTable) return "hitl_requests";
  if (t === nodeAttemptsTable) return "node_attempts";
  throw new Error("unknown table");
}

// Thenable chain: the original flow queries `await ...where()`, the M30 scope
// queries chain `.where().orderBy().limit()` — both resolve to the rows.
const selectChain = () => ({
  from: (table: unknown) => {
    const rows = dbState.tables[tableOf(table)];
    const chain: Record<string, unknown> = {
      then: (onFulfilled: (v: unknown) => unknown) =>
        Promise.resolve(rows).then(onFulfilled),
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
    };

    return chain;
  },
});

const fakeDb = {
  select: selectChain,
};

// Legacy route fixture; native worktree/source grants are qualified against real Git and Postgres.
vi.mock("@/lib/brain/knowledge-run-disclosure", () => ({
  assertRunKnowledgeDisclosure: vi.fn(async () => undefined),
}));

vi.mock("@/lib/db/client", () => ({
  getDb: () => fakeDb,
}));

vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => ({
    id: "user-1",
    role: "member",
    accountStatus: "active",
    mustChangePassword: false,
  })),
  requireProjectAction: vi.fn(async () => ({
    user: {
      id: "user-1",
      role: "viewer",
      accountStatus: "active",
      mustChangePassword: false,
    },
    role: "viewer",
  })),
}));

vi.mock("@/lib/diff/prepare", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/diff/prepare")>();

  return {
    ...actual,
    prepareDiff: vi.fn(actual.prepareDiff),
  };
});

vi.mock("@/lib/worktree", () => ({
  diffRunWorkspace: vi.fn(async () => ({
    text: "diff --git a/file.txt b/file.txt\n",
    truncated: false,
  })),
  diffNameStatus: vi.fn(async () => [{ path: "file.txt", status: "M" }]),
  resolveBaseRef: vi.fn(async () => "resolvedbase0000000000000000000000000000"),
  // M30 (ADR-082): scope-switcher imports — unused in these M22 default-scope
  // cases but required for the module factory to satisfy the route's imports.
  diffRange: vi.fn(async () => ({ text: "", truncated: false })),
  diffWorkingTree: vi.fn(async () => ({
    text: "",
    truncated: false,
    nameStatus: [],
  })),
  headCommit: vi.fn(async () => "headsha0000000000000000000000000000000000"),
  resolveRefSha: vi.fn(async () => "refsha00000000000000000000000000000000000"),
}));

function seedScratchRun(
  overrides: Partial<{
    runKind: "flow" | "scratch";
    removedAt: Date | null;
    targetBranch: string | null;
  }> = {},
): string {
  const runId = "run-diff";

  dbState.tables.runs.push({
    id: runId,
    runKind: overrides.runKind ?? "scratch",
    projectId: "project-1",
    status: "Review",
  });
  if ((overrides.runKind ?? "scratch") === "scratch") {
    dbState.tables.scratch_runs.push({
      runId,
      projectId: "project-1",
      baseBranch: "main",
      baseCommit: "abc1234",
      targetBranch: overrides.targetBranch ?? null,
    });
  }
  dbState.tables.workspaces.push({
    id: "workspace-1",
    runId,
    projectId: "project-1",
    branch: "scratch/demo",
    worktreePath: "/repos/demo/.maister/scratch-1",
    parentRepoPath: "/repos/demo",
    removedAt: overrides.removedAt ?? null,
  });

  return runId;
}

function seedFlowRun(
  overrides: Partial<{
    removedAt: Date | null;
    baseCommit: string | null;
    targetBranch: string | null;
    baseBranch: string | null;
  }> = {},
): string {
  const runId = "run-diff";

  dbState.tables.runs.push({
    id: runId,
    runKind: "flow",
    projectId: "project-1",
    status: "Running",
  });
  dbState.tables.projects.push({
    id: "project-1",
    mainBranch: "main",
    repoPath: "/repos/demo",
  });
  dbState.tables.workspaces.push({
    id: "workspace-1",
    runId,
    projectId: "project-1",
    branch: "maister/feature-x",
    worktreePath: "/repos/demo/.maister/wt-1",
    parentRepoPath: "/repos/demo",
    baseCommit:
      overrides.baseCommit === undefined ? "feedbeef" : overrides.baseCommit,
    baseBranch:
      overrides.baseBranch === undefined ? "main" : overrides.baseBranch,
    targetBranch:
      overrides.targetBranch === undefined ? "release" : overrides.targetBranch,
    removedAt: overrides.removedAt ?? null,
  });

  return runId;
}

async function invokeGet(runId: string, query = "") {
  const { GET } = await import("../route");
  const req = new NextRequest(
    new Request(`http://localhost/api/runs/${runId}/diff${query}`, {
      method: "GET",
    }),
  );

  return GET(req, { params: Promise.resolve({ runId }) });
}

beforeEach(() => {
  clearPreparedDiffCache();
  dbState.tables = {
    runs: [],
    scratch_runs: [],
    workspaces: [],
    projects: [],
    hitl_requests: [],
    node_attempts: [],
  };
  vi.mocked(prepareDiff).mockClear();
  vi.mocked(diffRunWorkspace).mockClear();
  vi.mocked(diffRunWorkspace).mockResolvedValue({
    text: "diff --git a/file.txt b/file.txt\n",
    truncated: false,
  });
  vi.mocked(diffNameStatus).mockClear();
  vi.mocked(diffNameStatus).mockResolvedValue([
    { path: "file.txt", status: "M" },
  ]);
  vi.mocked(diffWorkingTree).mockClear();
  vi.mocked(diffWorkingTree).mockResolvedValue({
    text: "diff --git a/file.txt b/file.txt\n",
    truncated: false,
    nameStatus: [{ path: "file.txt", status: "M" }],
  });
  vi.mocked(resolveBaseRef).mockClear();
  vi.mocked(resolveBaseRef).mockResolvedValue(
    "resolvedbase0000000000000000000000000000",
  );
  vi.mocked(resolveRefSha).mockClear();
  vi.mocked(resolveRefSha).mockResolvedValue(
    "refsha00000000000000000000000000000000000",
  );
  vi.mocked(assertRunKnowledgeDisclosure).mockClear();
  vi.mocked(assertRunKnowledgeDisclosure).mockResolvedValue(undefined);
  vi.mocked(requireProjectAction).mockClear();
  vi.mocked(requireProjectAction).mockResolvedValue({
    user: {
      id: "user-1",
      role: "viewer",
      accountStatus: "active",
      mustChangePassword: false,
    },
    role: "viewer",
  });
});

describe("GET /api/runs/[runId]/diff — scratch (prepared shape, M35 T3.3)", () => {
  it("returns the server-derived scratch branch diff", async () => {
    const runId = seedScratchRun({ targetBranch: "release" });

    const res = await invokeGet(runId, "?raw=1");
    const body = (await res.json()) as {
      diff?: string;
      sourceBranch?: string;
      targetBranch?: string;
    };

    expect(res.status).toBe(200);
    // Base commit → working tree (incl. untracked), run in the worktree.
    expect(diffWorkingTree).toHaveBeenCalledWith(
      "/repos/demo/.maister/scratch-1",
      "abc1234",
    );
    expect(diffRunWorkspace).not.toHaveBeenCalled();
    expect(body.diff).toContain("diff --git");
    expect(body.sourceBranch).toBe("scratch/demo");
    expect(body.targetBranch).toBe("release");
  });

  it("gates the scratch path with readScratchRun", async () => {
    const runId = seedScratchRun();

    await invokeGet(runId);

    expect(requireProjectAction).toHaveBeenCalledWith(
      "project-1",
      "readScratchRun",
    );
  });

  it("includes a prepared files/perFile summary in scratch diff responses", async () => {
    const runId = seedScratchRun();

    const res = await invokeGet(runId, "?raw=1");
    const body = (await res.json()) as {
      files?: {
        path: string;
        status: string;
        additions: number;
        deletions: number;
      }[];
      perFile?: unknown[];
      scope?: string;
      diff?: string;
    };

    expect(res.status).toBe(200);
    // The shared <RunDiff> consumes files/perFile; scratch derives them from the
    // working-tree name-status (base → worktree, same tree as the raw diff).
    expect(body.files).toEqual([
      { path: "file.txt", status: "M", additions: 0, deletions: 0 },
    ]);
    expect(Array.isArray(body.perFile)).toBe(true);
    expect(body.scope).toBe("run");
    // Opt-in ?raw=1 returns the raw diff string alongside prepared files/perFile.
    expect(body.diff).toContain("diff --git");
  });

  it("returns an empty files list for an empty scratch diff", async () => {
    const runId = seedScratchRun();

    vi.mocked(diffWorkingTree).mockResolvedValueOnce({
      text: "",
      truncated: false,
      nameStatus: [],
    });

    const res = await invokeGet(runId, "?raw=1");
    const body = (await res.json()) as {
      files?: unknown[];
      perFile?: unknown[];
      diff?: string;
    };

    expect(res.status).toBe(200);
    expect(body.files).toEqual([]);
    expect(body.perFile).toEqual([]);
    expect(body.diff).toBe("");
  });

  it("propagates truncated:true for an oversized scratch diff", async () => {
    const runId = seedScratchRun();

    vi.mocked(diffWorkingTree).mockResolvedValueOnce({
      text: "diff --git a/file.txt b/file.txt\n+partial\n",
      truncated: true,
      nameStatus: [{ path: "file.txt", status: "M" }],
    });

    const res = await invokeGet(runId, "?raw=1");
    const body = (await res.json()) as { truncated?: boolean; diff?: string };

    expect(res.status).toBe(200);
    expect(body.truncated).toBe(true);
    expect(body.diff).toContain("diff --git");
  });

  it("does not include upload artifact storage paths in scratch diff responses", async () => {
    const runId = seedScratchRun();

    vi.mocked(diffWorkingTree).mockResolvedValueOnce({
      text: "",
      truncated: false,
      nameStatus: [],
    });

    const res = await invokeGet(runId, "?raw=1");
    const body = (await res.json()) as { diff?: string };

    expect(res.status).toBe(200);
    expect(body.diff).toBe("");
    expect(JSON.stringify(body)).not.toContain(".maister/");
    expect(JSON.stringify(body)).not.toContain("uploads/");
  });

  it("rejects removed scratch workspaces", async () => {
    const runId = seedScratchRun({ removedAt: new Date() });

    const res = await invokeGet(runId);

    expect(res.status).toBe(409);
    expect(diffWorkingTree).not.toHaveBeenCalled();
  });

  it("enforces project visibility before reading git diff", async () => {
    const runId = seedScratchRun();

    vi.mocked(requireProjectAction).mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "not a project member"),
    );

    const res = await invokeGet(runId);

    expect(res.status).toBe(403);
    expect(diffWorkingTree).not.toHaveBeenCalled();
  });
});

describe("GET /api/runs/[runId]/diff — flow run (M22)", () => {
  it("returns 200 with diff + files + sourceBranch + baseCommit for a flow run", async () => {
    const runId = seedFlowRun();

    const res = await invokeGet(runId, "?raw=1");
    const body = (await res.json()) as {
      runId?: string;
      baseCommit?: string;
      sourceBranch?: string;
      targetBranch?: string;
      diff?: string;
      truncated?: boolean;
      files?: {
        path: string;
        status: string;
        additions: number;
        deletions: number;
      }[];
      perFile?: { path: string; fileLang: string; bundle: unknown }[];
    };

    expect(res.status).toBe(200);
    expect(body.runId).toBe(runId);
    expect(body.baseCommit).toBe("feedbeef");
    expect(body.sourceBranch).toBe("maister/feature-x");
    expect(body.targetBranch).toBe("release");
    expect(body.diff).toContain("diff --git");
    // A diff that fit the buffer is NOT flagged truncated.
    expect(body.truncated).toBe(false);
    // ADR-066 T2.4: files[] gains additive per-file +/- counts (no hunks in the
    // mocked diff → 0/0); the per-file prepared payload rides alongside.
    expect(body.files).toEqual([
      { path: "file.txt", status: "M", additions: 0, deletions: 0 },
    ]);
    expect(Array.isArray(body.perFile)).toBe(true);
    // FINDING C: the response is a client DTO — no server-only handle leaks.
    const serialized = JSON.stringify(body);

    for (const key of [
      "worktree",
      "worktreePath",
      "repoPath",
      "acpSessionId",
      "acp_session_id",
    ]) {
      expect(serialized).not.toContain(`"${key}"`);
    }
  });

  it("propagates truncated:true when diffRunWorkspace cuts an oversized diff", async () => {
    const runId = seedFlowRun();

    vi.mocked(diffRunWorkspace).mockResolvedValueOnce({
      text: "diff --git a/file.txt b/file.txt\n+partial\n",
      truncated: true,
    });

    const res = await invokeGet(runId, "?raw=1");
    const body = (await res.json()) as { truncated?: boolean; diff?: string };

    expect(res.status).toBe(200);
    // The structured flag rides the response so the workbench/review surface can
    // block on it instead of treating the partial prefix as the whole change.
    expect(body.truncated).toBe(true);
    expect(body.diff).toContain("diff --git");
  });

  it("computes the flow diff over workspace.worktreePath using the resolved headSha, not parentRepoPath", async () => {
    const runId = seedFlowRun();

    await invokeGet(runId);

    expect(diffRunWorkspace).toHaveBeenCalledWith({
      projectRepoPath: "/repos/demo/.maister/wt-1",
      baseCommit: "feedbeef",
      branch: "refsha00000000000000000000000000000000000",
    });
    expect(diffNameStatus).toHaveBeenCalledWith({
      worktreePath: "/repos/demo/.maister/wt-1",
      baseRef: "feedbeef",
      branch: "refsha00000000000000000000000000000000000",
    });
  });

  it("gates the flow path with readBoard (not readScratchRun)", async () => {
    const runId = seedFlowRun();

    await invokeGet(runId);

    expect(requireProjectAction).toHaveBeenCalledWith("project-1", "readBoard");
    expect(requireProjectAction).not.toHaveBeenCalledWith(
      "project-1",
      "readScratchRun",
    );
  });

  it("falls back to resolveBaseRef when workspace.baseCommit is null", async () => {
    const runId = seedFlowRun({ baseCommit: null });

    const res = await invokeGet(runId);
    const body = (await res.json()) as { baseCommit?: string };

    expect(res.status).toBe(200);
    expect(resolveBaseRef).toHaveBeenCalledWith({
      worktreePath: "/repos/demo/.maister/wt-1",
      branch: "maister/feature-x",
      mainBranch: "main",
    });
    expect(body.baseCommit).toBe("resolvedbase0000000000000000000000000000");
    expect(diffRunWorkspace).toHaveBeenCalledWith({
      projectRepoPath: "/repos/demo/.maister/wt-1",
      baseCommit: "resolvedbase0000000000000000000000000000",
      branch: "refsha00000000000000000000000000000000000",
    });
  });

  it("rejects a removed flow workspace with 409", async () => {
    const runId = seedFlowRun({ removedAt: new Date() });

    const res = await invokeGet(runId);

    expect(res.status).toBe(409);
    expect(diffRunWorkspace).not.toHaveBeenCalled();
  });

  it("returns 403 when the viewer is denied readBoard on the flow path", async () => {
    const runId = seedFlowRun();

    vi.mocked(requireProjectAction).mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "not a project member"),
    );

    const res = await invokeGet(runId);

    expect(res.status).toBe(403);
    expect(diffRunWorkspace).not.toHaveBeenCalled();
  });
});

describe("GET /api/runs/[runId]/diff — missing run (M22)", () => {
  it("returns 404 (not 409) for a run id that does not exist, matching the files/graph routes", async () => {
    const res = await invokeGet("does-not-exist");

    expect(res.status).toBe(404);
    expect(requireProjectAction).not.toHaveBeenCalled();
    expect(diffRunWorkspace).not.toHaveBeenCalled();
  });
});

describe("GET /api/runs/[runId]/diff — opt-in ?raw=1 & prepared LRU cache", () => {
  it("omits raw diff by default while returning prepared files and perFile", async () => {
    const runId = seedFlowRun();

    const res = await invokeGet(runId);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect("diff" in body).toBe(false);
    expect(body.files).toEqual([
      { path: "file.txt", status: "M", additions: 0, deletions: 0 },
    ]);
    expect(Array.isArray(body.perFile)).toBe(true);
  });

  it("hits the SHA LRU cache on a second default request without re-reading git or re-running prepareDiff", async () => {
    const runId = seedFlowRun();

    const firstRes = await invokeGet(runId);
    const firstBody = (await firstRes.json()) as Record<string, unknown>;
    const secondRes = await invokeGet(runId);
    const secondBody = (await secondRes.json()) as Record<string, unknown>;

    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(200);
    expect("diff" in firstBody).toBe(false);
    expect("diff" in secondBody).toBe(false);
    expect(secondBody.files).toEqual(firstBody.files);
    expect(secondBody.perFile).toEqual(firstBody.perFile);
    expect(diffRunWorkspace).toHaveBeenCalledTimes(1);
    expect(diffNameStatus).toHaveBeenCalledTimes(1);
    expect(prepareDiff).toHaveBeenCalledTimes(1);
  });

  it("returns raw diff on follow-up ?raw=1 while reusing the cached prepared bundle", async () => {
    const runId = seedFlowRun();

    const defaultRes = await invokeGet(runId);
    const defaultBody = (await defaultRes.json()) as Record<string, unknown>;

    expect(defaultRes.status).toBe(200);
    expect("diff" in defaultBody).toBe(false);

    const rawRes = await invokeGet(runId, "?raw=1");
    const rawBody = (await rawRes.json()) as {
      diff?: string;
      files?: unknown[];
      perFile?: unknown[];
    };

    expect(rawRes.status).toBe(200);
    expect(rawBody.diff).toContain("diff --git");
    expect(rawBody.files).toEqual(defaultBody.files);
    expect(rawBody.perFile).toEqual(defaultBody.perFile);
    expect(diffNameStatus).toHaveBeenCalledTimes(1);
    expect(prepareDiff).toHaveBeenCalledTimes(1);
  });

  it("handles prepare-failed by omitting diff by default, including diff on ?raw=1, and never caching the failed prep", async () => {
    const runId = seedFlowRun();

    vi.mocked(prepareDiff).mockRejectedValueOnce(new Error("shiki exploded"));

    const failedDefaultRes = await invokeGet(runId);
    const failedDefaultBody = (await failedDefaultRes.json()) as Record<
      string,
      unknown
    >;

    expect(failedDefaultRes.status).toBe(200);
    expect(failedDefaultBody.renderUnavailableReason).toBe("prepare-failed");
    expect("diff" in failedDefaultBody).toBe(false);
    expect(failedDefaultBody.perFile).toEqual([]);

    vi.mocked(prepareDiff).mockRejectedValueOnce(new Error("shiki exploded"));

    const failedRawRes = await invokeGet(runId, "?raw=1");
    const failedRawBody = (await failedRawRes.json()) as Record<
      string,
      unknown
    >;

    expect(failedRawRes.status).toBe(200);
    expect(failedRawBody.renderUnavailableReason).toBe("prepare-failed");
    expect(failedRawBody.diff).toContain("diff --git");
    expect(failedRawBody.perFile).toEqual([]);

    // Neither failed response was cached: next request runs prepareDiff and succeeds.
    const recoveredRes = await invokeGet(runId);
    const recoveredBody = (await recoveredRes.json()) as Record<
      string,
      unknown
    >;

    expect(recoveredRes.status).toBe(200);
    expect(recoveredBody.renderUnavailableReason).toBeNull();
    expect(prepareDiff).toHaveBeenCalledTimes(3);
  });

  it("enforces project authz and knowledge disclosure denial even on a warm cache hit", async () => {
    const runId = seedFlowRun();

    // Warm the cache.
    const warmRes = await invokeGet(runId);

    expect(warmRes.status).toBe(200);
    expect(prepareDiff).toHaveBeenCalledTimes(1);

    // Project authz denial on warm cache hit -> 403.
    vi.mocked(requireProjectAction).mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "revoked access"),
    );
    const deniedAuthRes = await invokeGet(runId);

    expect(deniedAuthRes.status).toBe(403);

    // Knowledge disclosure denial on warm cache hit -> 403.
    vi.mocked(assertRunKnowledgeDisclosure).mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "knowledge disclosure denied"),
    );
    const deniedDisclosureRes = await invokeGet(runId);

    expect(deniedDisclosureRes.status).toBe(403);
    expect(prepareDiff).toHaveBeenCalledTimes(1);
  });

  it("enforces readScratchRun before loading scratch workspace rows so unauthorized callers get 403 instead of 409", async () => {
    const runId = seedScratchRun({ removedAt: new Date() });

    vi.mocked(requireProjectAction).mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "not a project member"),
    );

    const res = await invokeGet(runId);

    expect(res.status).toBe(403);
    expect(diffWorkingTree).not.toHaveBeenCalled();
  });

  it("invalidates the SHA cache when headSha advances", async () => {
    const runId = seedFlowRun();

    vi.mocked(resolveRefSha).mockResolvedValueOnce(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    const firstRes = await invokeGet(runId);

    expect(firstRes.status).toBe(200);
    expect(prepareDiff).toHaveBeenCalledTimes(1);

    vi.mocked(resolveRefSha).mockResolvedValueOnce(
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    const secondRes = await invokeGet(runId);

    expect(secondRes.status).toBe(200);
    expect(diffRunWorkspace).toHaveBeenCalledTimes(2);
    expect(diffNameStatus).toHaveBeenCalledTimes(2);
    expect(prepareDiff).toHaveBeenCalledTimes(2);
    expect(diffRunWorkspace).toHaveBeenLastCalledWith({
      projectRepoPath: "/repos/demo/.maister/wt-1",
      baseCommit: "feedbeef",
      branch: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
    expect(diffNameStatus).toHaveBeenLastCalledWith({
      worktreePath: "/repos/demo/.maister/wt-1",
      baseRef: "feedbeef",
      branch: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
  });

  it("reuses review: and content: cache entries without re-running prepareDiff", async () => {
    const runId = seedFlowRun();

    const firstReview = await invokeGet(runId, "?scope=review");
    const secondReview = await invokeGet(runId, "?scope=review");

    expect(firstReview.status).toBe(200);
    expect(secondReview.status).toBe(200);
    expect(prepareDiff).toHaveBeenCalledTimes(1);

    const firstUncommitted = await invokeGet(runId, "?scope=uncommitted");
    const secondUncommitted = await invokeGet(runId, "?scope=uncommitted");

    expect(firstUncommitted.status).toBe(200);
    expect(secondUncommitted.status).toBe(200);
    // Uncommitted scope uses content:<sha256>:<truncated> — hits once prepared.
    expect(prepareDiff).toHaveBeenCalledTimes(2);
  });

  it("serves a sha: cache entry produced via buildPreparedDiffCacheEntry verbatim with zero prepareDiff calls", async () => {
    const runId = seedFlowRun();
    const rawDiff = [
      "diff --git a/src/app.ts b/src/app.ts",
      "index 1111111..2222222 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,2 +1,3 @@",
      "-export const a = 1;",
      "+export const a = 2;",
      "+export const b = 3;",
      " export const keep = true;",
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "index 0000000..3333333",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1,1 @@",
      "+export const created = true;",
    ].join("\n");
    const nameStatus = [
      { path: "src/app.ts", status: "M" },
      { path: "src/new.ts", status: "A" },
    ];
    const prepared = await prepareDiff(rawDiff, false);
    const entry = buildPreparedDiffCacheEntry({ nameStatus, prepared });
    const shaKey =
      "sha:/repos/demo/.maister/wt-1:feedbeef:refsha00000000000000000000000000000000000";

    setCachedPreparedDiff(shaKey, entry);
    vi.mocked(prepareDiff).mockClear();

    const res = await invokeGet(runId);
    const body = (await res.json()) as {
      files?: unknown[];
      perFile?: unknown[];
      truncated?: boolean;
    };

    expect(res.status).toBe(200);
    expect(body.files).toEqual([
      { path: "src/app.ts", status: "M", additions: 2, deletions: 1 },
      { path: "src/new.ts", status: "A", additions: 1, deletions: 0 },
    ]);
    expect(body.perFile).toEqual(prepared.perFile);
    expect(body.truncated).toBe(false);
    expect(prepareDiff).not.toHaveBeenCalled();
    expect(diffRunWorkspace).not.toHaveBeenCalled();
    expect(diffNameStatus).not.toHaveBeenCalled();
  });
});
