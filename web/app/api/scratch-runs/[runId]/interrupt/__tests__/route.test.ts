import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireProjectAction } from "@/lib/authz";
import {
  runs as runsTable,
  scratchRuns as scratchRunsTable,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { cancelPrompt } from "@/lib/supervisor-client";

type Row = Record<string, unknown>;
type Tables = { runs: Row[]; scratch_runs: Row[] };

const dbState: { tables: Tables } = {
  tables: { runs: [], scratch_runs: [] },
};

function tableOf(t: unknown): keyof Tables {
  if (t === runsTable) return "runs";
  if (t === scratchRunsTable) return "scratch_runs";
  throw new Error("unknown table");
}

const selectChain = () => ({
  from: (table: unknown) => ({
    where: async () => dbState.tables[tableOf(table)],
  }),
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

vi.mock("@/lib/supervisor-client", () => ({
  checkSupervisorHealth: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(async () => undefined),
  sendPrompt: vi.fn(),
  cancelPrompt: vi.fn(async () => ({ cancelled: true })),
}));

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
    supervisorSessionId: string | null;
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
      supervisorSessionId: Object.hasOwn(overrides, "supervisorSessionId")
        ? overrides.supervisorSessionId
        : "sup-1",
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
  dbState.tables = { runs: [], scratch_runs: [] };
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
      supervisorSessionId: null,
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
