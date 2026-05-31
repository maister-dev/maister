import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  runs as runsTable,
  scratchRuns as scratchRunsTable,
  workspaces as workspacesTable,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { branchExists, promoteLocalMerge } from "@/lib/worktree";

type Row = Record<string, unknown>;
type Tables = {
  runs: Row[];
  scratch_runs: Row[];
  workspaces: Row[];
};
type FakeDb = {
  select: () => ReturnType<typeof selectChain>;
  update: (table: unknown) => ReturnType<typeof updateChain>;
  transaction: <T>(fn: (tx: FakeDb) => Promise<T>) => Promise<T>;
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

const updateChain = (table: unknown) => ({
  set: (vals: Row) => ({
    where: async () => {
      for (const row of dbState.tables[tableOf(table)]) {
        Object.assign(row, vals);
      }
    },
  }),
});

const fakeDb: FakeDb = {
  select: selectChain,
  update: updateChain,
  transaction: async <T>(fn: (tx: FakeDb) => Promise<T>): Promise<T> =>
    fn(fakeDb),
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
      role: "member",
      accountStatus: "active",
      mustChangePassword: false,
    },
    role: "member",
  })),
}));

vi.mock("@/lib/worktree", () => ({
  branchExists: vi.fn(async () => true),
  promoteLocalMerge: vi.fn(async () => "def5678"),
}));

function seedScratchRun(
  overrides: Partial<{
    runKind: "flow" | "scratch";
    dialogStatus: string;
    removedAt: Date | null;
    targetBranch: string | null;
  }> = {},
): string {
  const runId = "run-promote";

  dbState.tables.runs.push({
    id: runId,
    runKind: overrides.runKind ?? "scratch",
    projectId: "project-1",
    status: "Review",
    acpSessionId: "acp-1",
    currentStepId: "scratch-dialog",
    endedAt: null,
  });
  if ((overrides.runKind ?? "scratch") === "scratch") {
    dbState.tables.scratch_runs.push({
      runId,
      projectId: "project-1",
      baseBranch: "main",
      baseCommit: "abc1234",
      targetBranch: overrides.targetBranch ?? null,
      dialogStatus: overrides.dialogStatus ?? "Review",
      supervisorSessionId: null,
      updatedAt: null,
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

async function invokePost(runId: string, body: unknown) {
  const { POST } = await import("../route");
  const req = new NextRequest(
    new Request(`http://localhost/api/runs/${runId}/promote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

  return POST(req, { params: Promise.resolve({ runId }) });
}

beforeEach(() => {
  dbState.tables = { runs: [], scratch_runs: [], workspaces: [] };
  vi.mocked(branchExists).mockClear();
  vi.mocked(branchExists).mockResolvedValue(true);
  vi.mocked(promoteLocalMerge).mockClear();
  vi.mocked(promoteLocalMerge).mockResolvedValue("def5678");
});

describe("POST /api/runs/[runId]/promote", () => {
  it("local-merges the scratch branch and marks the scratch run Done", async () => {
    const runId = seedScratchRun();

    const res = await invokePost(runId, {
      mode: "local_merge",
      targetBranch: "main",
    });
    const body = (await res.json()) as { commit?: string };

    expect(res.status).toBe(200);
    expect(branchExists).toHaveBeenCalledWith({
      projectRepoPath: "/repos/demo",
      branch: "main",
    });
    expect(promoteLocalMerge).toHaveBeenCalledWith({
      projectRepoPath: "/repos/demo",
      sourceBranch: "scratch/demo",
      targetBranch: "main",
    });
    expect(body.commit).toBe("def5678");
    expect(dbState.tables.scratch_runs[0]).toMatchObject({
      dialogStatus: "Done",
      targetBranch: "main",
      supervisorSessionId: null,
    });
    expect(dbState.tables.runs[0]).toMatchObject({
      status: "Done",
      acpSessionId: null,
      currentStepId: null,
    });
    expect(dbState.tables.runs[0].endedAt).toBeInstanceOf(Date);
  });

  it("rejects a missing target branch before merge", async () => {
    const runId = seedScratchRun();

    vi.mocked(branchExists).mockResolvedValueOnce(false);

    const res = await invokePost(runId, {
      mode: "local_merge",
      targetBranch: "missing",
    });

    expect(res.status).toBe(409);
    expect(promoteLocalMerge).not.toHaveBeenCalled();
    expect(dbState.tables.scratch_runs[0].dialogStatus).toBe("Review");
  });

  it("rejects an existing target branch outside the scratch base policy", async () => {
    const runId = seedScratchRun();

    vi.mocked(branchExists).mockResolvedValueOnce(true);

    const res = await invokePost(runId, {
      mode: "local_merge",
      targetBranch: "production",
    });

    expect(res.status).toBe(409);
    expect(branchExists).not.toHaveBeenCalled();
    expect(promoteLocalMerge).not.toHaveBeenCalled();
    expect(dbState.tables.scratch_runs[0].dialogStatus).toBe("Review");
  });

  it("leaves the scratch run in Review when the merge conflicts", async () => {
    const runId = seedScratchRun();

    vi.mocked(promoteLocalMerge).mockRejectedValueOnce(
      new MaisterError("CONFLICT", "merge conflict"),
    );

    const res = await invokePost(runId, {
      mode: "local_merge",
      targetBranch: "main",
    });

    expect(res.status).toBe(409);
    expect(dbState.tables.scratch_runs[0].dialogStatus).toBe("Review");
    expect(dbState.tables.runs[0].status).toBe("Review");
  });

  it("rejects non-scratch runs", async () => {
    const runId = seedScratchRun({ runKind: "flow" });

    const res = await invokePost(runId, {
      mode: "local_merge",
      targetBranch: "main",
    });

    expect(res.status).toBe(409);
    expect(promoteLocalMerge).not.toHaveBeenCalled();
  });

  it("rejects promotion before the scratch run reaches Review", async () => {
    const runId = seedScratchRun({ dialogStatus: "Running" });

    const res = await invokePost(runId, {
      mode: "local_merge",
      targetBranch: "main",
    });

    expect(res.status).toBe(409);
    expect(promoteLocalMerge).not.toHaveBeenCalled();
  });

  it("reports pull_request mode as not implemented", async () => {
    const runId = seedScratchRun();

    const res = await invokePost(runId, {
      mode: "pull_request",
      targetBranch: "main",
    });

    expect(res.status).toBe(400);
    expect(branchExists).not.toHaveBeenCalled();
    expect(promoteLocalMerge).not.toHaveBeenCalled();
  });
});
