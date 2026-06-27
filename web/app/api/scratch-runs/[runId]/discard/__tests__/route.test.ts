import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  runs as runsTable,
  scratchRuns as scratchRunsTable,
  workspaces as workspacesTable,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { worktreesRoot } from "@/lib/instance-config";
import { assertLocalPackageAssistantActor } from "@/lib/scratch-runs/service";
import { deleteSession } from "@/lib/supervisor-client";
import { removeOwnedWorktree } from "@/lib/worktree";

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
let transactionFailure: Error | null = null;

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
  transaction: async <T>(fn: (tx: FakeDb) => Promise<T>): Promise<T> => {
    if (transactionFailure) throw transactionFailure;

    return fn(fakeDb);
  },
};

vi.mock("@/lib/db/client", () => ({
  getDb: () => fakeDb,
}));

vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => ({
    id: "user-1",
    role: "member",
    mustChangePassword: false,
  })),
  requireProjectAction: vi.fn(async () => ({
    user: { id: "user-1", role: "member" },
    role: "member",
  })),
}));

vi.mock("@/lib/instance-config", () => ({
  worktreesRoot: vi.fn(() => "/tmp/maister-worktrees"),
}));

vi.mock("@/lib/supervisor-client", () => ({
  deleteSession: vi.fn(async () => undefined),
}));

vi.mock("@/lib/worktree", () => ({
  removeOwnedWorktree: vi.fn(async () => undefined),
}));

// Only assertLocalPackageAssistantActor is consumed from the (heavy) service —
// stub it so the route's project-less authz branch is exercised without pulling
// the full scratch-runs service dependency graph into this lightweight test.
vi.mock("@/lib/scratch-runs/service", () => ({
  assertLocalPackageAssistantActor: vi.fn(async () => undefined),
}));

function seedScratchRun(
  overrides: Partial<{
    runKind: "flow" | "scratch";
    runStatus: string;
    dialogStatus: string;
    supervisorSessionId: string | null;
    removedAt: Date | null;
    projectId: string | null;
    localPackageId: string | null;
    createdByUserId: string | null;
    workspace: boolean;
  }> = {},
): string {
  const runId = "run-discard";
  const projectId =
    overrides.projectId === undefined ? "project-1" : overrides.projectId;
  const hasWorkspace = overrides.workspace ?? true;

  dbState.tables.runs.push({
    id: runId,
    runKind: overrides.runKind ?? "scratch",
    projectId,
    localPackageId: overrides.localPackageId ?? null,
    createdByUserId: overrides.createdByUserId ?? null,
    status: overrides.runStatus ?? "Running",
    acpSessionId: "acp-1",
    currentStepId: "scratch-dialog",
    endedAt: null,
  });
  if ((overrides.runKind ?? "scratch") === "scratch") {
    dbState.tables.scratch_runs.push({
      runId,
      projectId,
      dialogStatus: overrides.dialogStatus ?? "Running",
      supervisorSessionId: overrides.supervisorSessionId ?? null,
      updatedAt: null,
    });
  }
  if (hasWorkspace) {
    dbState.tables.workspaces.push({
      id: "workspace-1",
      runId,
      projectId,
      parentRepoPath: "/repos/demo",
      worktreePath: "/tmp/maister-worktrees/demo/run-discard",
      removedAt: overrides.removedAt ?? null,
    });
  }

  return runId;
}

async function invokePost(runId: string) {
  const { POST } = await import("../route");
  const req = new NextRequest(
    new Request(`http://localhost/api/scratch-runs/${runId}/discard`, {
      method: "POST",
    }),
  );

  return POST(req, { params: Promise.resolve({ runId }) });
}

beforeEach(() => {
  dbState.tables = { runs: [], scratch_runs: [], workspaces: [] };
  transactionFailure = null;
  vi.mocked(deleteSession).mockClear();
  vi.mocked(removeOwnedWorktree).mockClear();
  vi.mocked(worktreesRoot).mockClear();
  vi.mocked(worktreesRoot).mockReturnValue("/tmp/maister-worktrees");
  vi.mocked(assertLocalPackageAssistantActor).mockClear();
  vi.mocked(assertLocalPackageAssistantActor).mockResolvedValue(undefined);
});

describe("POST /api/scratch-runs/[runId]/discard", () => {
  it("removes the owned worktree and marks the scratch run Abandoned", async () => {
    const runId = seedScratchRun();

    const res = await invokePost(runId);
    const body = (await res.json()) as { workspaceRemoved?: boolean };

    expect(res.status).toBe(200);
    expect(deleteSession).not.toHaveBeenCalled();
    expect(removeOwnedWorktree).toHaveBeenCalledWith({
      projectRepoPath: "/repos/demo",
      worktreePath: "/tmp/maister-worktrees/demo/run-discard",
      allowedRoot: "/tmp/maister-worktrees",
      force: true,
    });
    expect(body.workspaceRemoved).toBe(true);
    expect(dbState.tables.workspaces[0].removedAt).toBeInstanceOf(Date);
    expect(dbState.tables.scratch_runs[0]).toMatchObject({
      dialogStatus: "Abandoned",
      supervisorSessionId: null,
    });
    expect(dbState.tables.runs[0]).toMatchObject({
      status: "Abandoned",
      currentStepId: null,
    });
  });

  it("terminates a live supervisor session before discard", async () => {
    const runId = seedScratchRun({ supervisorSessionId: "sup-live" });

    const res = await invokePost(runId);

    expect(res.status).toBe(200);
    expect(deleteSession).toHaveBeenCalledWith("sup-live");
    expect(removeOwnedWorktree).toHaveBeenCalledTimes(1);
  });

  it("treats a missing supervisor session as already stopped", async () => {
    const runId = seedScratchRun({ supervisorSessionId: "sup-gone" });

    vi.mocked(deleteSession).mockRejectedValueOnce(
      new MaisterError("PRECONDITION", "unknown session"),
    );

    const res = await invokePost(runId);
    const body = (await res.json()) as { supervisorStopped?: boolean };

    expect(res.status).toBe(200);
    expect(body.supervisorStopped).toBe(false);
    expect(dbState.tables.scratch_runs[0].dialogStatus).toBe("Abandoned");
  });

  it("is idempotent when the workspace was already removed", async () => {
    const removedAt = new Date("2026-05-31T00:00:00.000Z");
    const runId = seedScratchRun({
      runStatus: "Abandoned",
      dialogStatus: "Abandoned",
      removedAt,
    });

    const res = await invokePost(runId);
    const body = (await res.json()) as { workspaceRemoved?: boolean };

    expect(res.status).toBe(200);
    expect(removeOwnedWorktree).not.toHaveBeenCalled();
    expect(body.workspaceRemoved).toBe(false);
    expect(dbState.tables.workspaces[0].removedAt).toBe(removedAt);
  });

  it("does not abandon or remove completed scratch runs", async () => {
    const runId = seedScratchRun({
      runStatus: "Done",
      dialogStatus: "Done",
      supervisorSessionId: null,
    });

    const res = await invokePost(runId);
    const body = (await res.json()) as {
      dialogStatus?: string;
      runStatus?: string;
      workspaceRemoved?: boolean;
    };

    expect(res.status).toBe(200);
    expect(deleteSession).not.toHaveBeenCalled();
    expect(removeOwnedWorktree).not.toHaveBeenCalled();
    expect(body).toMatchObject({
      dialogStatus: "Done",
      runStatus: "Done",
      workspaceRemoved: false,
    });
    expect(dbState.tables.scratch_runs[0].dialogStatus).toBe("Done");
    expect(dbState.tables.runs[0].status).toBe("Done");
    expect(dbState.tables.workspaces[0].removedAt).toBeNull();
  });

  it("does not remove the worktree when the durable discard transaction fails", async () => {
    const runId = seedScratchRun();

    transactionFailure = new Error("db write failed");

    const res = await invokePost(runId);

    expect(res.status).toBe(500);
    expect(removeOwnedWorktree).not.toHaveBeenCalled();
    expect(dbState.tables.workspaces[0].removedAt).toBeNull();
    expect(dbState.tables.scratch_runs[0].dialogStatus).toBe("Running");
  });

  it("rejects non-scratch runs before worktree removal", async () => {
    const runId = seedScratchRun({ runKind: "flow" });

    const res = await invokePost(runId);

    expect(res.status).toBe(409);
    expect(deleteSession).not.toHaveBeenCalled();
    expect(removeOwnedWorktree).not.toHaveBeenCalled();
  });

  it("drops a project-less assistant run via the created-by gate (no worktree)", async () => {
    const runId = seedScratchRun({
      projectId: null,
      localPackageId: "lp-1",
      createdByUserId: "user-1",
      workspace: false,
      supervisorSessionId: "sup-live",
    });

    const res = await invokePost(runId);
    const body = (await res.json()) as {
      dialogStatus?: string;
      supervisorStopped?: boolean;
      workspaceRemoved?: boolean;
    };

    expect(res.status).toBe(200);
    // Authorized by the assistant created-by gate, not requireProjectAction.
    expect(assertLocalPackageAssistantActor).toHaveBeenCalledWith(
      expect.objectContaining({
        createdByUserId: "user-1",
        localPackageId: "lp-1",
        projectId: null,
      }),
      "user-1",
      { requireLock: false },
    );
    expect(deleteSession).toHaveBeenCalledWith("sup-live");
    // A project-less assistant run has no workspace — nothing to remove.
    expect(removeOwnedWorktree).not.toHaveBeenCalled();
    expect(body).toMatchObject({
      dialogStatus: "Abandoned",
      supervisorStopped: true,
      workspaceRemoved: false,
    });
    expect(dbState.tables.runs[0].status).toBe("Abandoned");
  });

  it("rejects a project-less assistant drop by a non-owner before any side-effect", async () => {
    const runId = seedScratchRun({
      projectId: null,
      localPackageId: "lp-1",
      createdByUserId: "someone-else",
      workspace: false,
      supervisorSessionId: "sup-live",
    });

    vi.mocked(assertLocalPackageAssistantActor).mockRejectedValueOnce(
      new MaisterError(
        "UNAUTHORIZED",
        "this assistant run belongs to another user",
      ),
    );

    const res = await invokePost(runId);

    expect(res.status).toBe(403);
    expect(deleteSession).not.toHaveBeenCalled();
    expect(dbState.tables.runs[0].status).toBe("Running");
  });
});
