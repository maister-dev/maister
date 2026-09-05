import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireProjectAction } from "@/lib/authz";
import {
  runSessions as runSessionsTable,
  runs as runsTable,
  scratchRuns as scratchRunsTable,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

type Row = Record<string, unknown>;
type Tables = { run_sessions: Row[]; runs: Row[]; scratch_runs: Row[] };

const dbState: { tables: Tables } = {
  tables: { run_sessions: [], runs: [], scratch_runs: [] },
};

function tableOf(t: unknown): keyof Tables {
  if (t === runSessionsTable) return "run_sessions";
  if (t === runsTable) return "runs";
  if (t === scratchRunsTable) return "scratch_runs";
  throw new Error("unknown table");
}

function selectedRows(table: unknown): Row[] {
  return dbState.tables[tableOf(table)];
}

const selectChain = () => ({
  from: (table: unknown) => {
    const query = {
      then: <TResult1 = Row[], TResult2 = never>(
        onFulfilled?:
          | ((value: Row[]) => TResult1 | PromiseLike<TResult1>)
          | null,
        onRejected?:
          | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
          | null,
      ): Promise<TResult1 | TResult2> =>
        Promise.resolve(selectedRows(table)).then(onFulfilled, onRejected),
      orderBy: () => query,
      limit: async (count: number) => selectedRows(table).slice(0, count),
    };

    return { where: () => query };
  },
});

const fakeDb = { select: selectChain };

vi.mock("@/lib/db/client", () => ({ getDb: () => fakeDb }));

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

// ADR-166 (strict): the wire client no longer exports a bare `cancelPrompt`;
// the execution-host module mock routes the bound client's `session.cancel` to
// this spy so the wire-level assertions keep their shape.
const { cancelPrompt } = vi.hoisted(() => ({
  cancelPrompt: vi.fn(async (_sessionId: string) => ({ cancelled: true })),
}));

vi.mock("@/lib/supervisor-client", () => ({
  checkSupervisorHealth: vi.fn(),
}));

vi.mock("@/lib/execution-host", async () => {
  const { executionHostModuleMock } = await import(
    "@/test-support/execution-host-module-mock"
  );

  return executionHostModuleMock({ cancelPrompt });
});

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
    dialogStatus: string;
    hostSessionId: string | null;
  }> = {},
): string {
  const runId = "run-interrupt";

  dbState.tables.runs.push({
    id: runId,
    runKind: overrides.runKind ?? "scratch",
    projectId: "project-1",
    status: "Running",
  });
  if ((overrides.runKind ?? "scratch") === "scratch") {
    dbState.tables.scratch_runs.push({
      runId,
      projectId: "project-1",
      dialogStatus: overrides.dialogStatus ?? "Running",
    });
    dbState.tables.run_sessions.push({
      id: "run-session-1",
      runId,
      sessionName: "scratch-dialog",
      acpSessionId: "acp-1",
      hostSessionId: Object.hasOwn(overrides, "hostSessionId")
        ? overrides.hostSessionId
        : "sup-1",
      updatedAt: new Date(),
    });
  }

  return runId;
}

async function invokePost(runId: string) {
  const { POST } = await import("../route");
  const req = new NextRequest(
    new Request(`http://localhost/api/scratch-runs/${runId}/interrupt`, {
      method: "POST",
    }),
  );

  return POST(req, { params: Promise.resolve({ runId }) });
}

beforeEach(() => {
  dbState.tables = { run_sessions: [], runs: [], scratch_runs: [] };
  vi.mocked(cancelPrompt).mockClear();
  vi.mocked(cancelPrompt).mockResolvedValue({ cancelled: true });
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

describe("POST /api/scratch-runs/[runId]/interrupt", () => {
  it("cancels the live turn without mutating the dialog status", async () => {
    const runId = seedScratchRun();

    const res = await invokePost(runId);
    const body = (await res.json()) as {
      cancelled?: boolean;
      dialogStatus?: string;
    };

    expect(res.status).toBe(200);
    expect(cancelPrompt).toHaveBeenCalledWith("sup-1");
    expect(body).toMatchObject({ cancelled: true, dialogStatus: "Running" });
  });

  it("is a no-op for a terminal run", async () => {
    const runId = seedScratchRun({
      dialogStatus: "Done",
      hostSessionId: null,
    });

    const res = await invokePost(runId);
    const body = (await res.json()) as { cancelled?: boolean };

    expect(res.status).toBe(200);
    expect(cancelPrompt).not.toHaveBeenCalled();
    expect(body.cancelled).toBe(false);
  });

  it("rejects non-scratch runs", async () => {
    const runId = seedScratchRun({ runKind: "flow" });

    const res = await invokePost(runId);

    expect(res.status).toBe(409);
    expect(cancelPrompt).not.toHaveBeenCalled();
  });

  it("enforces project authorization before any supervisor call", async () => {
    const runId = seedScratchRun();

    vi.mocked(requireProjectAction).mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "not a project member"),
    );

    const res = await invokePost(runId);

    expect(res.status).toBe(403);
    expect(cancelPrompt).not.toHaveBeenCalled();
  });
});
