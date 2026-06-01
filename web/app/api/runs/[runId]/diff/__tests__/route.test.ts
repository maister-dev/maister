import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireProjectAction } from "@/lib/authz";
import {
  runs as runsTable,
  scratchRuns as scratchRunsTable,
  workspaces as workspacesTable,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { diffRunWorkspace } from "@/lib/worktree";

type Row = Record<string, unknown>;
type Tables = {
  runs: Row[];
  scratch_runs: Row[];
  workspaces: Row[];
};

const dbState: { tables: Tables } = {
  tables: { runs: [], scratch_runs: [], workspaces: [] },
};

function tableOf(t: unknown): keyof Tables {
  if (t === runsTable) return "runs";
  if (t === scratchRunsTable) return "scratch_runs";
  if (t === workspacesTable) return "workspaces";
  throw new Error("unknown table");
}

const selectChain = () => ({
  from: (table: unknown) => ({
    where: async () => dbState.tables[tableOf(table)],
  }),
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
  diffRunWorkspace: vi.fn(async () => "diff --git a/file.txt b/file.txt\n"),
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
    parentRepoPath: "/repos/demo",
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
  dbState.tables = { runs: [], scratch_runs: [], workspaces: [] };
  vi.mocked(diffRunWorkspace).mockClear();
  vi.mocked(diffRunWorkspace).mockResolvedValue(
    "diff --git a/file.txt b/file.txt\n",
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

describe("GET /api/runs/[runId]/diff", () => {
  it("returns the server-derived scratch branch diff", async () => {
    const runId = seedScratchRun({ targetBranch: "release" });

    const res = await invokeGet(runId);
    const body = (await res.json()) as {
      diff?: string;
      sourceBranch?: string;
      targetBranch?: string;
    };

    expect(res.status).toBe(200);
    expect(diffRunWorkspace).toHaveBeenCalledWith({
      projectRepoPath: "/repos/demo",
      baseCommit: "abc1234",
      branch: "scratch/demo",
    });
    expect(body.diff).toContain("diff --git");
    expect(body.sourceBranch).toBe("scratch/demo");
    expect(body.targetBranch).toBe("release");
  });

  it("does not include upload artifact storage paths in scratch diff responses", async () => {
    const runId = seedScratchRun();

    vi.mocked(diffRunWorkspace).mockResolvedValueOnce("");

    const res = await invokeGet(runId);
    const body = (await res.json()) as { diff?: string };

    expect(res.status).toBe(200);
    expect(body.diff).toBe("");
    expect(JSON.stringify(body)).not.toContain(".maister/");
    expect(JSON.stringify(body)).not.toContain("uploads/");
  });

  it("rejects removed workspaces", async () => {
    const runId = seedScratchRun({ removedAt: new Date() });

    const res = await invokeGet(runId);

    expect(res.status).toBe(409);
    expect(diffRunWorkspace).not.toHaveBeenCalled();
  });

  it("rejects non-scratch runs", async () => {
    const runId = seedScratchRun({ runKind: "flow" });

    const res = await invokeGet(runId);

    expect(res.status).toBe(409);
    expect(diffRunWorkspace).not.toHaveBeenCalled();
  });

  it("enforces project visibility before reading git diff", async () => {
    const runId = seedScratchRun();

    vi.mocked(requireProjectAction).mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "not a project member"),
    );

    const res = await invokeGet(runId);

    expect(res.status).toBe(403);
    expect(diffRunWorkspace).not.toHaveBeenCalled();
  });
});
