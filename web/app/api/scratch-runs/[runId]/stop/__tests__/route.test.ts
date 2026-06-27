import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireProjectAction } from "@/lib/authz";
import {
  runs as runsTable,
  scratchRuns as scratchRunsTable,
  workspaces as workspacesTable,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { deleteSession } from "@/lib/supervisor-client";

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
    mustChangePassword: false,
  })),
  requireProjectAction: vi.fn(async () => ({
    user: { id: "user-1", role: "member" },
    role: "member",
  })),
}));

vi.mock("@/lib/supervisor-client", () => ({
  checkSupervisorHealth: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(async () => undefined),
  sendPrompt: vi.fn(),
}));

// The route now delegates to stopScratchWorkbench (scratch-runs/service), which
// statically pulls a wide module graph; stub the modules it imports at eval so
// the unit env can load the real primitive under test (mirrors the scratch
// launch route test).
vi.mock("@/lib/scheduler", () => ({
  assertScratchCapacityAvailable: vi.fn(),
  assertScratchCapacityAvailableInTransaction: vi.fn(),
}));
vi.mock("@/lib/instance-config", () => ({
  runtimeRoot: vi.fn(),
  worktreesRoot: vi.fn(),
}));
vi.mock("@/lib/worktree", () => ({
  addWorktree: vi.fn(),
  branchExists: vi.fn(),
  removeBranch: vi.fn(),
  removeWorktree: vi.fn(),
  resolveBaseCommit: vi.fn(),
}));
vi.mock("@/lib/capabilities/resolver", () => ({
  loadSelectableCapabilities: vi.fn(),
  resolveCapabilityProfile: vi.fn(),
}));
vi.mock("@/lib/capabilities/materialize", () => ({
  materializeCapabilityProfile: vi.fn(),
}));
vi.mock("@/lib/scratch-runs/events", () => ({
  sendScratchPromptAndProjectEvents: vi.fn(),
}));

function seedScratchRun(
  overrides: Partial<{
    runKind: "flow" | "scratch";
    runStatus: string;
    dialogStatus: string;
    supervisorSessionId: string | null;
    removedAt: Date | null;
  }> = {},
): string {
  const runId = "run-stop";

  dbState.tables.runs.push({
    id: runId,
    runKind: overrides.runKind ?? "scratch",
    projectId: "project-1",
    status: overrides.runStatus ?? "Running",
    acpSessionId: "acp-1",
    currentStepId: "scratch-dialog",
    endedAt: null,
  });
  if ((overrides.runKind ?? "scratch") === "scratch") {
    dbState.tables.scratch_runs.push({
      runId,
      projectId: "project-1",
      dialogStatus: overrides.dialogStatus ?? "Running",
      supervisorSessionId: Object.hasOwn(overrides, "supervisorSessionId")
        ? overrides.supervisorSessionId
        : "sup-1",
      updatedAt: null,
    });
  }
  dbState.tables.workspaces.push({
    id: "workspace-1",
    runId,
    projectId: "project-1",
    removedAt: overrides.removedAt ?? null,
  });

  return runId;
}

async function invokePost(runId: string) {
  const { POST } = await import("../route");
  const req = new NextRequest(
    new Request(`http://localhost/api/scratch-runs/${runId}/stop`, {
      method: "POST",
    }),
  );

  return POST(req, { params: Promise.resolve({ runId }) });
}

beforeEach(() => {
  dbState.tables = { runs: [], scratch_runs: [], workspaces: [] };
  vi.mocked(deleteSession).mockClear();
  vi.mocked(requireProjectAction).mockClear();
  vi.mocked(requireProjectAction).mockResolvedValue({
    user: {
      id: "user-1",
      role: "member",
      accountStatus: "active",
      mustChangePassword: false,
    },
    role: "member",
  });
});

describe("POST /api/scratch-runs/[runId]/stop", () => {
  it("stops a live supervisor session and moves the scratch run to Review", async () => {
    const runId = seedScratchRun();

    const res = await invokePost(runId);
    const body = (await res.json()) as { supervisorStopped?: boolean };

    expect(res.status).toBe(200);
    expect(deleteSession).toHaveBeenCalledWith("sup-1");
    expect(body.supervisorStopped).toBe(true);
    expect(dbState.tables.scratch_runs[0]).toMatchObject({
      dialogStatus: "Review",
      supervisorSessionId: null,
    });
    expect(dbState.tables.runs[0]).toMatchObject({
      status: "Review",
      currentStepId: null,
    });
    expect(dbState.tables.runs[0].endedAt).toBeInstanceOf(Date);
  });

  it("is idempotent for an already stopped scratch run", async () => {
    const runId = seedScratchRun({
      runStatus: "Review",
      dialogStatus: "Review",
      supervisorSessionId: null,
    });

    const res = await invokePost(runId);
    const body = (await res.json()) as { supervisorStopped?: boolean };

    expect(res.status).toBe(200);
    expect(deleteSession).not.toHaveBeenCalled();
    expect(body.supervisorStopped).toBe(false);
    expect(dbState.tables.scratch_runs[0].dialogStatus).toBe("Review");
  });

  it("does not resurrect completed scratch runs", async () => {
    const runId = seedScratchRun({
      runStatus: "Done",
      dialogStatus: "Done",
      supervisorSessionId: null,
    });

    const res = await invokePost(runId);
    const body = (await res.json()) as {
      dialogStatus?: string;
      runStatus?: string;
      supervisorStopped?: boolean;
    };

    expect(res.status).toBe(200);
    expect(deleteSession).not.toHaveBeenCalled();
    expect(body).toMatchObject({
      dialogStatus: "Done",
      runStatus: "Done",
      supervisorStopped: false,
    });
    expect(dbState.tables.scratch_runs[0].dialogStatus).toBe("Done");
    expect(dbState.tables.runs[0].status).toBe("Done");
    expect(dbState.tables.runs[0].endedAt).toBeNull();
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
    expect(dbState.tables.scratch_runs[0]).toMatchObject({
      dialogStatus: "Review",
      supervisorSessionId: null,
    });
    expect(dbState.tables.runs[0]).toMatchObject({
      status: "Review",
      currentStepId: null,
    });
  });

  it("rejects non-scratch runs", async () => {
    const runId = seedScratchRun({ runKind: "flow" });

    const res = await invokePost(runId);

    expect(res.status).toBe(409);
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("enforces project authorization before supervisor side effects", async () => {
    const runId = seedScratchRun();

    vi.mocked(requireProjectAction).mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "not a project member"),
    );

    const res = await invokePost(runId);

    expect(res.status).toBe(403);
    expect(deleteSession).not.toHaveBeenCalled();
  });
});
