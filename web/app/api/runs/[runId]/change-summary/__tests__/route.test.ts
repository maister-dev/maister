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
  diffChangeStats,
  diffWorkingTreeChangeStats,
  headCommit,
  resolveBaseRef,
  resolveRefSha,
} from "@/lib/worktree";

type Row = Record<string, unknown>;
type Tables = {
  runs: Row[];
  scratch_runs: Row[];
  workspaces: Row[];
  projects: Row[];
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

function tableOf(table: unknown): keyof Tables {
  if (table === runsTable) return "runs";
  if (table === scratchRunsTable) return "scratch_runs";
  if (table === workspacesTable) return "workspaces";
  if (table === projectsTable) return "projects";
  if (table === hitlRequestsTable) return "hitl_requests";
  if (table === nodeAttemptsTable) return "node_attempts";
  throw new Error("unknown table");
}

function selectChain() {
  return {
    from: (table: unknown) => {
      const rows = dbState.tables[tableOf(table)];
      const chain: Record<string, unknown> = {
        then: (onFulfilled: (value: unknown) => unknown) =>
          Promise.resolve(rows).then(onFulfilled),
        where: () => chain,
        orderBy: () => chain,
        limit: () => chain,
      };

      return chain;
    },
  };
}

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

vi.mock("@/lib/worktree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/worktree")>();

  return {
    ...actual,
    diffChangeStats: vi.fn(async () => [
      {
        path: "src/app.ts",
        status: "M",
        additions: 2,
        deletions: 1,
        binary: false,
      },
    ]),
    diffWorkingTreeChangeStats: vi.fn(async () => [
      {
        path: "scratch.txt",
        status: "A",
        additions: 1,
        deletions: 0,
        binary: false,
      },
    ]),
    headCommit: vi.fn(async () => "head000000000000000000000000000000000000"),
    resolveBaseRef: vi.fn(
      async () => "base000000000000000000000000000000000000",
    ),
    resolveRefSha: vi.fn(
      async () => "checkpoint0000000000000000000000000000000",
    ),
  };
});

function resetTables(): void {
  dbState.tables = {
    runs: [],
    scratch_runs: [],
    workspaces: [],
    projects: [],
    hitl_requests: [],
    node_attempts: [],
  };
}

function seedFlowRun(
  overrides: Partial<{
    runKind: "flow" | "agent";
    baseCommit: string | null;
    removedAt: Date | null;
  }> = {},
): string {
  const runId = "run-change-summary";

  dbState.tables.runs.push({
    id: runId,
    runId,
    projectId: "project-1",
    runKind: overrides.runKind ?? "flow",
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
    baseBranch: "main",
    targetBranch: "release",
    removedAt: overrides.removedAt ?? null,
  });

  return runId;
}

function seedScratchRun(): string {
  const runId = "run-change-summary";

  dbState.tables.runs.push({
    id: runId,
    runId,
    projectId: "project-1",
    runKind: "scratch",
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
    branch: "scratch/demo",
    worktreePath: "/repos/demo/.maister/scratch-1",
    parentRepoPath: "/repos/demo",
    baseCommit: "abc1234",
    baseBranch: "main",
    targetBranch: null,
    removedAt: null,
  });
  dbState.tables.scratch_runs.push({
    runId,
    projectId: "project-1",
    baseBranch: "main",
    baseCommit: "abc1234",
    targetBranch: null,
  });

  return runId;
}

async function invokeGet(runId: string, scope?: string) {
  const { GET } = await import("../route");
  const req = new NextRequest(
    new Request(
      `http://localhost/api/runs/${runId}/change-summary${
        scope ? `?scope=${scope}` : ""
      }`,
      { method: "GET" },
    ),
  );

  return GET(req, { params: Promise.resolve({ runId }) });
}

beforeEach(() => {
  resetTables();
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
  vi.mocked(diffChangeStats).mockClear();
  vi.mocked(diffChangeStats).mockResolvedValue([
    {
      path: "src/app.ts",
      status: "M",
      additions: 2,
      deletions: 1,
      binary: false,
    },
  ]);
  vi.mocked(diffWorkingTreeChangeStats).mockClear();
  vi.mocked(diffWorkingTreeChangeStats).mockResolvedValue([
    {
      path: "scratch.txt",
      status: "A",
      additions: 1,
      deletions: 0,
      binary: false,
    },
  ]);
  vi.mocked(headCommit).mockClear();
  vi.mocked(headCommit).mockResolvedValue(
    "head000000000000000000000000000000000000",
  );
  vi.mocked(resolveBaseRef).mockClear();
  vi.mocked(resolveBaseRef).mockResolvedValue(
    "base000000000000000000000000000000000000",
  );
  vi.mocked(resolveRefSha).mockClear();
  vi.mocked(resolveRefSha).mockResolvedValue(
    "checkpoint0000000000000000000000000000000",
  );
});

describe("GET /api/runs/[runId]/change-summary", () => {
  it("authorizes flow runs with readBoard and returns a path-only summary", async () => {
    const runId = seedFlowRun();

    const res = await invokeGet(runId);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(requireProjectAction).toHaveBeenCalledWith("project-1", "readBoard");
    expect(body).toMatchObject({
      runId,
      scope: "run",
      fileCount: 1,
      additions: 2,
      deletions: 1,
      sourceBranch: "maister/feature-x",
      targetBranch: "release",
      scopes: {
        run: { available: true },
        uncommitted: { available: true },
      },
    });
    expect(body).not.toHaveProperty("totals");
    expect(JSON.stringify(body)).not.toContain("/repos/demo");
  });

  it("authorizes scratch runs with readScratchRun", async () => {
    const runId = seedScratchRun();

    const res = await invokeGet(runId);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(requireProjectAction).toHaveBeenCalledWith(
      "project-1",
      "readScratchRun",
    );
    expect(diffChangeStats).toHaveBeenCalledWith({
      worktreePath: "/repos/demo",
      baseRef: "abc1234",
      branch: "scratch/demo",
    });
    expect(JSON.stringify(body)).not.toContain("/repos/demo");
  });

  it("rejects unknown scopes with CONFIG", async () => {
    const runId = seedFlowRun();

    const res = await invokeGet(runId, "evil");
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.code).toBe("CONFIG");
  });

  it("reports unavailable scope reasons in the default availability map", async () => {
    const runId = seedFlowRun();

    const res = await invokeGet(runId);
    const body = (await res.json()) as Record<string, any>;

    expect(res.status).toBe(200);
    expect(body.scopes["since-last-review"].available).toBe(false);
    expect(typeof body.scopes["since-last-review"].reason).toBe("string");
  });

  it("returns PRECONDITION when a disabled scope is requested directly", async () => {
    const runId = seedFlowRun();

    const res = await invokeGet(runId, "since-last-review");
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe("PRECONDITION");
  });

  it("uses the working-tree summary for uncommitted scope", async () => {
    const runId = seedFlowRun();

    const res = await invokeGet(runId, "uncommitted");
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(diffWorkingTreeChangeStats).toHaveBeenCalledWith(
      "/repos/demo/.maister/wt-1",
    );
    expect(body).toMatchObject({
      scope: "uncommitted",
      dirty: true,
      baseCommit: "head000000000000000000000000000000000000",
    });
  });

  it("does not touch git when project auth is denied", async () => {
    const runId = seedFlowRun();

    vi.mocked(requireProjectAction).mockRejectedValue(
      new MaisterError("UNAUTHORIZED", "denied"),
    );

    const res = await invokeGet(runId);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.code).toBe("UNAUTHORIZED");
    expect(diffChangeStats).not.toHaveBeenCalled();
  });

  it("returns 404 for missing runs", async () => {
    const res = await invokeGet("missing");

    expect(res.status).toBe(404);
  });
});
