import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  executors as executorsTable,
  projects as projectsTable,
  runs as runsTable,
  scratchCapabilityProfiles as scratchCapabilityProfilesTable,
  scratchRuns as scratchRunsTable,
  workspaces as workspacesTable,
} from "@/lib/db/schema";
import { sendScratchPromptAndProjectEvents } from "@/lib/scratch-runs/events";
import {
  checkSupervisorHealth,
  createSession,
  listSessions,
} from "@/lib/supervisor-client";

type Row = Record<string, unknown>;
type Tables = {
  runs: Row[];
  scratch_runs: Row[];
  workspaces: Row[];
  projects: Row[];
  executors: Row[];
  scratch_capability_profiles: Row[];
};
type FakeDb = {
  select: () => ReturnType<typeof selectChain>;
  update: (table: unknown) => ReturnType<typeof updateChain>;
  transaction: <T>(fn: (tx: FakeDb) => Promise<T>) => Promise<T>;
};

const dbState: { tables: Tables } = {
  tables: {
    runs: [],
    scratch_runs: [],
    workspaces: [],
    projects: [],
    executors: [],
    scratch_capability_profiles: [],
  },
};

function tableOf(t: unknown): keyof Tables {
  if (t === runsTable) return "runs";
  if (t === scratchRunsTable) return "scratch_runs";
  if (t === workspacesTable) return "workspaces";
  if (t === projectsTable) return "projects";
  if (t === executorsTable) return "executors";
  if (t === scratchCapabilityProfilesTable) {
    return "scratch_capability_profiles";
  }
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

vi.mock("@/lib/supervisor-client", () => ({
  checkSupervisorHealth: vi.fn(async () => ({
    kind: "ready",
    health: {
      status: "ready",
      version: "test",
      uptimeMs: 1,
      checkedAt: new Date().toISOString(),
      sessions: { live: 0, exited: 0, crashed: 0 },
    },
  })),
  createSession: vi.fn(async () => ({
    sessionId: "sup-new",
    pid: 123,
    acpSessionId: "acp-new",
  })),
  listSessions: vi.fn(async () => []),
}));

vi.mock("@/lib/scratch-runs/events", () => ({
  sendScratchPromptAndProjectEvents: vi.fn(async () => ({
    stopReason: "end_turn",
  })),
}));

function emptyTables(): Tables {
  return {
    runs: [],
    scratch_runs: [],
    workspaces: [],
    projects: [],
    executors: [],
    scratch_capability_profiles: [],
  };
}

function seedScratchRun(
  overrides: Partial<{
    runKind: "flow" | "scratch";
    acpSessionId: string | null;
    dialogStatus: string;
    supervisorSessionId: string | null;
    removedAt: Date | null;
  }> = {},
): string {
  const runId = "run-recover";
  const executorId = "executor-1";

  dbState.tables.runs.push({
    id: runId,
    runKind: overrides.runKind ?? "scratch",
    projectId: "project-1",
    executorId,
    status: "Crashed",
    acpSessionId: Object.hasOwn(overrides, "acpSessionId")
      ? overrides.acpSessionId
      : "acp-old",
    currentStepId: null,
  });
  if ((overrides.runKind ?? "scratch") === "scratch") {
    dbState.tables.scratch_runs.push({
      runId,
      projectId: "project-1",
      dialogStatus: overrides.dialogStatus ?? "Crashed",
      supervisorSessionId: Object.hasOwn(overrides, "supervisorSessionId")
        ? overrides.supervisorSessionId
        : "sup-old",
      updatedAt: null,
    });
  }
  dbState.tables.workspaces.push({
    id: "workspace-1",
    runId,
    projectId: "project-1",
    branch: "scratch/demo",
    parentRepoPath: "/repos/demo",
    worktreePath: "/worktrees/demo/run-recover",
    removedAt: overrides.removedAt ?? null,
  });
  dbState.tables.projects.push({
    id: "project-1",
    slug: "demo",
  });
  dbState.tables.executors.push({
    id: executorId,
    projectId: "project-1",
    agent: "claude",
    model: "claude-sonnet",
    env: { FOO: "bar" },
    router: null,
  });
  dbState.tables.scratch_capability_profiles.push({
    id: "profile-1",
    runId,
    materializedPath: "/worktrees/demo/run-recover/.maister/profile.json",
    adapterLaunch: { postArgs: ["--profile"] },
  });

  return runId;
}

async function invokePost(runId: string, body: unknown) {
  const { POST } = await import("../route");
  const req = new NextRequest(
    new Request(`http://localhost/api/scratch-runs/${runId}/recover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

  return POST(req, { params: Promise.resolve({ runId }) });
}

beforeEach(() => {
  dbState.tables = emptyTables();
  vi.mocked(checkSupervisorHealth).mockClear();
  vi.mocked(checkSupervisorHealth).mockResolvedValue({
    kind: "ready",
    health: {
      status: "ready",
      version: "test",
      uptimeMs: 1,
      checkedAt: new Date().toISOString(),
      sessions: { live: 0, exited: 0, crashed: 0 },
    },
  });
  vi.mocked(createSession).mockClear();
  vi.mocked(createSession).mockResolvedValue({
    sessionId: "sup-new",
    pid: 123,
    acpSessionId: "acp-new",
  });
  vi.mocked(listSessions).mockClear();
  vi.mocked(listSessions).mockResolvedValue([]);
  vi.mocked(sendScratchPromptAndProjectEvents).mockClear();
  vi.mocked(sendScratchPromptAndProjectEvents).mockResolvedValue({
    stopReason: "end_turn",
  });
});

describe("POST /api/scratch-runs/[runId]/recover", () => {
  it("returns open when the stored supervisor session is still live", async () => {
    const runId = seedScratchRun({ dialogStatus: "WaitingForUser" });

    vi.mocked(listSessions).mockResolvedValueOnce([
      {
        sessionId: "sup-old",
        runId,
        projectSlug: "demo",
        stepId: "scratch-dialog",
        status: "live",
        pid: 123,
        startedAt: new Date().toISOString(),
        logPath: "/tmp/log",
        monotonicId: 1,
        acpSessionId: "acp-old",
      },
    ]);

    const res = await invokePost(runId, {});
    const body = (await res.json()) as { action?: string };

    expect(res.status).toBe(200);
    expect(body.action).toBe("open");
    expect(createSession).not.toHaveBeenCalled();
    expect(sendScratchPromptAndProjectEvents).not.toHaveBeenCalled();
  });

  it("resumes a missing supervisor session from the stored ACP session id", async () => {
    const runId = seedScratchRun();

    const res = await invokePost(runId, { prompt: "continue from here" });
    const body = (await res.json()) as { action?: string };

    expect(res.status).toBe(202);
    expect(body.action).toBe("recover");
    expect(createSession).toHaveBeenCalledWith({
      runId,
      projectSlug: "demo",
      worktreePath: "/worktrees/demo/run-recover",
      stepId: "dialog",
      executor: {
        agent: "claude",
        model: "claude-sonnet",
        env: { FOO: "bar" },
        router: undefined,
      },
      resumeSessionId: "acp-old",
      capabilityProfilePath:
        "/worktrees/demo/run-recover/.maister/profile.json",
      adapterLaunch: { postArgs: ["--profile"] },
    });
    expect(sendScratchPromptAndProjectEvents).toHaveBeenCalledWith({
      runId,
      sessionId: "sup-new",
      stepId: "dialog",
      prompt: "continue from here",
    });
    expect(dbState.tables.runs[0]).toMatchObject({
      status: "Running",
      acpSessionId: "acp-new",
      currentStepId: "dialog",
    });
    expect(dbState.tables.scratch_runs[0]).toMatchObject({
      dialogStatus: "WaitingForUser",
      supervisorSessionId: "sup-new",
    });
  });

  it("requires a prompt for recovery", async () => {
    const runId = seedScratchRun();

    const res = await invokePost(runId, {});

    expect(res.status).toBe(400);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("classifies rows without ACP resume handles as discard-only", async () => {
    const runId = seedScratchRun({ acpSessionId: null });

    const res = await invokePost(runId, { prompt: "continue" });

    expect(res.status).toBe(409);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("rejects non-scratch runs", async () => {
    const runId = seedScratchRun({ runKind: "flow" });

    const res = await invokePost(runId, { prompt: "continue" });

    expect(res.status).toBe(409);
    expect(createSession).not.toHaveBeenCalled();
  });
});
