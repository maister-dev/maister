import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireProjectAction } from "@/lib/authz";
import {
  hitlRequests as hitlRequestsTable,
  nodeAttempts as nodeAttemptsTable,
  projects as projectsTable,
  runs as runsTable,
  scratchRuns as scratchRunsTable,
  workspaces as workspacesTable,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  diffNameStatus,
  diffRunWorkspace,
  diffWorkingTree,
  resolveBaseRef,
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

async function invokeGet(runId: string) {
  const { GET } = await import("../route");
  const req = new NextRequest(
    new Request(`http://localhost/api/runs/${runId}/diff`, {
      method: "GET",
    }),
  );

  return GET(req, { params: Promise.resolve({ runId }) });
}

beforeEach(() => {
  dbState.tables = {
    runs: [],
    scratch_runs: [],
    workspaces: [],
    projects: [],
    hitl_requests: [],
    node_attempts: [],
  };
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

    const res = await invokeGet(runId);
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

    const res = await invokeGet(runId);
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
    // The raw diff string is preserved for backward compatibility.
    expect(body.diff).toContain("diff --git");
  });

  it("returns an empty files list for an empty scratch diff", async () => {
    const runId = seedScratchRun();

    vi.mocked(diffWorkingTree).mockResolvedValueOnce({
      text: "",
      truncated: false,
      nameStatus: [],
    });

    const res = await invokeGet(runId);
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

    const res = await invokeGet(runId);
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

    const res = await invokeGet(runId);
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

    const res = await invokeGet(runId);
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

    const res = await invokeGet(runId);
    const body = (await res.json()) as { truncated?: boolean; diff?: string };

    expect(res.status).toBe(200);
    // The structured flag rides the response so the workbench/review surface can
    // block on it instead of treating the partial prefix as the whole change.
    expect(body.truncated).toBe(true);
    expect(body.diff).toContain("diff --git");
  });

  it("computes the flow diff over workspace.worktreePath, not parentRepoPath", async () => {
    const runId = seedFlowRun();

    await invokeGet(runId);

    expect(diffRunWorkspace).toHaveBeenCalledWith({
      projectRepoPath: "/repos/demo/.maister/wt-1",
      baseCommit: "feedbeef",
      branch: "maister/feature-x",
    });
    expect(diffNameStatus).toHaveBeenCalledWith({
      worktreePath: "/repos/demo/.maister/wt-1",
      baseRef: "feedbeef",
      branch: "maister/feature-x",
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
      branch: "maister/feature-x",
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
