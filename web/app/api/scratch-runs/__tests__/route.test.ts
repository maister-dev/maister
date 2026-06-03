import type { NextRequest } from "next/server";
import type { MaisterError as RuntimeMaisterError } from "@/lib/errors";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addWorktree: vi.fn(),
  assertScratchCapacityAvailable: vi.fn(),
  assertScratchCapacityAvailableInTransaction: vi.fn(),
  branchExists: vi.fn(),
  checkSupervisorHealth: vi.fn(),
  createSession: vi.fn(),
  loadSelectableCapabilities: vi.fn(),
  materializeCapabilityProfile: vi.fn(),
  removeBranch: vi.fn(),
  removeWorktree: vi.fn(),
  requireActiveSession: vi.fn(),
  requireProjectAction: vi.fn(),
  resolveBaseCommit: vi.fn(),
  resolveCapabilityProfile: vi.fn(),
  runtimeRoot: vi.fn(),
  sendScratchPromptAndProjectEvents: vi.fn(),
  sendPrompt: vi.fn(),
  worktreesRoot: vi.fn(),
}));

type InsertCall = { table: unknown; values: unknown };
type UpdateCall = { table: unknown; values: unknown };
type FakeDb = {
  select: () => {
    from: (table: unknown) => {
      where: (predicate: unknown) => Promise<Record<string, unknown>[]>;
    };
  };
  insert: (table: unknown) => {
    values: (values: unknown) => Promise<void>;
  };
  update: (table: unknown) => {
    set: (values: unknown) => {
      where: (predicate: unknown) => Promise<void>;
    };
  };
  transaction: <T>(fn: (tx: FakeDb) => Promise<T>) => Promise<T>;
};

const state: {
  inserts: InsertCall[];
  updates: UpdateCall[];
  selectCalls: number;
  runtimeRoot: string | null;
  project: Record<string, unknown>;
  executor: Record<string, unknown>;
} = {
  inserts: [],
  updates: [],
  selectCalls: 0,
  runtimeRoot: null,
  project: {},
  executor: {},
};

const fakeDb: FakeDb = {
  select: () => ({
    from: () => ({
      where: async () => {
        state.selectCalls += 1;

        if (state.selectCalls === 1) return [state.project];
        if (state.selectCalls === 2) return [state.executor];
        if (state.selectCalls === 3) {
          return [{ runId: "run-1", dialogStatus: "Running" }];
        }

        return [];
      },
    }),
  }),
  insert: (table: unknown) => ({
    values: async (values: unknown) => {
      state.inserts.push({ table, values });
    },
  }),
  update: (table: unknown) => ({
    set: (values: unknown) => ({
      where: async () => {
        state.updates.push({ table, values });
      },
    }),
  }),
  transaction: async <T>(fn: (tx: typeof fakeDb) => Promise<T>) => fn(fakeDb),
};

vi.mock("@/lib/authz", () => ({
  requireActiveSession: mocks.requireActiveSession,
  requireProjectAction: mocks.requireProjectAction,
}));
vi.mock("@/lib/db/client", () => ({ getDb: () => fakeDb }));
vi.mock("@/lib/scheduler", () => ({
  assertScratchCapacityAvailable: mocks.assertScratchCapacityAvailable,
  assertScratchCapacityAvailableInTransaction:
    mocks.assertScratchCapacityAvailableInTransaction,
}));
vi.mock("@/lib/instance-config", () => ({
  runtimeRoot: mocks.runtimeRoot,
  worktreesRoot: mocks.worktreesRoot,
}));
vi.mock("@/lib/worktree", () => ({
  addWorktree: mocks.addWorktree,
  branchExists: mocks.branchExists,
  removeBranch: mocks.removeBranch,
  removeWorktree: mocks.removeWorktree,
  resolveBaseCommit: mocks.resolveBaseCommit,
}));
vi.mock("@/lib/supervisor-client", () => ({
  checkSupervisorHealth: mocks.checkSupervisorHealth,
  createSession: mocks.createSession,
  sendPrompt: mocks.sendPrompt,
}));
vi.mock("@/lib/capabilities/resolver", () => ({
  loadSelectableCapabilities: mocks.loadSelectableCapabilities,
  resolveCapabilityProfile: mocks.resolveCapabilityProfile,
}));
vi.mock("@/lib/capabilities/materialize", () => ({
  materializeCapabilityProfile: mocks.materializeCapabilityProfile,
}));
vi.mock("@/lib/scratch-runs/events", () => ({
  sendScratchPromptAndProjectEvents: mocks.sendScratchPromptAndProjectEvents,
}));

let POST: (req: NextRequest) => Promise<Response>;

const projectId = "11111111-1111-4111-8111-111111111111";
const executorId = "22222222-2222-4222-8222-222222222222";

beforeEach(async () => {
  state.inserts = [];
  state.updates = [];
  state.selectCalls = 0;
  state.runtimeRoot = await mkdtemp(
    path.join(tmpdir(), "maister-scratch-route-"),
  );
  state.project = {
    id: projectId,
    slug: "demo",
    name: "Demo",
    repoPath: "/repo/demo",
    branchPrefix: "maister/",
    archivedAt: null,
  };
  state.executor = {
    id: executorId,
    projectId,
    agent: "codex",
    model: "gpt-5",
    env: null,
    router: null,
  };

  mocks.requireActiveSession.mockResolvedValue({ id: "user-1" });
  mocks.requireProjectAction.mockResolvedValue({ role: "member" });
  mocks.loadSelectableCapabilities.mockResolvedValue([]);
  mocks.resolveCapabilityProfile.mockReturnValue({
    projectId,
    executorAgent: "codex",
    planMode: "off",
    selectedMcpIds: ["filesystem"],
    selectedSkillIds: [],
    selectedRuleIds: [],
    selectedRestrictionIds: [],
    enforced: [],
    instructed: [],
    supported: [],
    unsupported: [],
    refused: [],
    downgraded: [],
    profileDigest: "digest",
  });
  mocks.checkSupervisorHealth.mockResolvedValue({
    kind: "ready",
    health: {
      status: "ready",
      version: "test",
      uptimeMs: 1,
      checkedAt: new Date().toISOString(),
      sessions: { live: 0, exited: 0, crashed: 0 },
    },
  });
  mocks.assertScratchCapacityAvailable.mockResolvedValue({
    allowed: true,
    cap: 3,
    liveCount: 0,
  });
  mocks.assertScratchCapacityAvailableInTransaction.mockResolvedValue({
    allowed: true,
    cap: 3,
    liveCount: 0,
  });
  mocks.resolveBaseCommit.mockResolvedValue("abcdef1");
  mocks.branchExists.mockResolvedValue(false);
  mocks.removeBranch.mockResolvedValue(undefined);
  mocks.runtimeRoot.mockReturnValue(state.runtimeRoot);
  mocks.worktreesRoot.mockReturnValue("/tmp/maister-worktrees");
  mocks.addWorktree.mockResolvedValue(undefined);
  mocks.removeWorktree.mockResolvedValue(undefined);
  mocks.materializeCapabilityProfile.mockResolvedValue({
    rootPath: "/tmp/maister-worktrees/demo/run/.maister/capabilities/run",
    profilePath:
      "/tmp/maister-worktrees/demo/run/.maister/capabilities/run/profile.json",
    instructionsPath:
      "/tmp/maister-worktrees/demo/run/.maister/capabilities/run/instructions.md",
    settingsLocalPath: null,
    mcpServers: [],
    materializedFiles: [],
    adapterLaunch: {
      env: { MAISTER_CAPABILITY_PROFILE_PATH: "/profile.json" },
    },
  });
  mocks.createSession.mockResolvedValue({
    sessionId: "supervisor-session-1",
    pid: 123,
    acpSessionId: "acp-session-1",
  });
  mocks.sendPrompt.mockResolvedValue({ stopReason: "end_turn" });
  mocks.sendScratchPromptAndProjectEvents.mockResolvedValue({
    stopReason: "end_turn",
  });

  ({ POST } = await import("../route"));
});

afterEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  if (state.runtimeRoot) {
    await rm(state.runtimeRoot, { recursive: true, force: true });
    state.runtimeRoot = null;
  }
});

function launchPayload(overrides: Record<string, unknown> = {}) {
  return {
    projectId,
    baseBranch: "main",
    branchName: "maister/demo/scratch/test",
    executorId,
    planMode: "off",
    prompt: "Investigate the thing",
    attachments: [],
    ...overrides,
  };
}

function launchRequest(overrides: Record<string, unknown> = {}): NextRequest {
  return new Request("http://x/api/scratch-runs", {
    method: "POST",
    body: JSON.stringify(launchPayload(overrides)),
  }) as NextRequest;
}

function multipartLaunchRequest(args: {
  overrides?: Record<string, unknown>;
  files?: File[];
}): NextRequest {
  const formData = new FormData();

  formData.set("payload", JSON.stringify(launchPayload(args.overrides)));
  for (const file of args.files ?? []) formData.append("files", file);

  return new Request("http://x/api/scratch-runs", {
    method: "POST",
    body: formData,
  }) as NextRequest;
}

describe("POST /api/scratch-runs", () => {
  it("launches a scratch supervisor session with persisted run rows", async () => {
    const res = await POST(launchRequest());
    const body = (await res.json()) as {
      runId?: string;
      status?: { dialogStatus?: string };
    };

    expect(res.status).toBe(201);
    expect(body.runId).toBeTruthy();
    expect(body.status?.dialogStatus).toBe("WaitingForUser");
    expect(mocks.addWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: "maister/demo/scratch/test",
        startPoint: "main",
      }),
    );
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: body.runId,
        projectSlug: "demo",
        stepId: "dialog",
        capabilityProfilePath:
          "/tmp/maister-worktrees/demo/run/.maister/capabilities/run/profile.json",
      }),
    );
    expect(mocks.sendScratchPromptAndProjectEvents).toHaveBeenCalledWith({
      runId: body.runId,
      sessionId: "supervisor-session-1",
      stepId: "dialog",
      prompt: "Investigate the thing",
    });
    expect(state.inserts.length).toBeGreaterThanOrEqual(4);
  });

  it("prepares a scratch supervisor session without sending an empty initial prompt", async () => {
    const res = await POST(launchRequest({ prompt: "" }));
    const body = (await res.json()) as {
      runId?: string;
      status?: { dialogStatus?: string };
    };
    const insertedRows = state.inserts.flatMap((call) =>
      Array.isArray(call.values) ? call.values : [call.values],
    ) as Array<Record<string, unknown>>;
    const scratchRunRow = insertedRows.find(
      (row) => row.initialPrompt === "" && row.dialogStatus === "Starting",
    );
    const userMessageRow = insertedRows.find((row) => row.role === "user");

    expect(res.status).toBe(201);
    expect(body.runId).toBeTruthy();
    expect(body.status?.dialogStatus).toBe("WaitingForUser");
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: body.runId,
        projectSlug: "demo",
      }),
    );
    expect(mocks.sendScratchPromptAndProjectEvents).not.toHaveBeenCalled();
    expect(scratchRunRow).toMatchObject({
      initialPrompt: "",
      lastUserMessageAt: null,
    });
    expect(userMessageRow).toBeUndefined();
    expect(state.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          values: expect.objectContaining({
            dialogStatus: "WaitingForUser",
          }),
        }),
      ]),
    );
  });

  it("treats an empty branch name as the generated scratch branch fallback", async () => {
    const res = await POST(launchRequest({ branchName: "" }));
    const body = (await res.json()) as { runId?: string };
    const addArgs = mocks.addWorktree.mock.calls[0]?.[0] as
      | { branch?: string }
      | undefined;

    expect(res.status).toBe(201);
    expect(body.runId).toBeTruthy();
    expect(addArgs?.branch).toMatch(/^maister\/demo\/scratch\/[0-9a-f-]+$/);
    expect(addArgs?.branch).not.toBe("maister/demo/scratch/test");
  });

  it("accepts multipart launch with mixed metadata and uploaded files", async () => {
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    const res = await POST(
      multipartLaunchRequest({
        overrides: {
          branchName: "",
          attachments: [{ kind: "text_note", value: "remember this" }],
        },
        files: [file],
      }),
    );
    const body = (await res.json()) as { runId?: string };
    const attachmentInsert = state.inserts.find((call) => {
      if (!Array.isArray(call.values)) return false;

      return call.values.some(
        (row: Record<string, unknown>) => row.kind === "uploaded_file",
      );
    });
    const rows = Array.isArray(attachmentInsert?.values)
      ? (attachmentInsert.values as Array<Record<string, unknown>>)
      : [];
    const uploaded = rows.find((row) => row.kind === "uploaded_file");

    expect(res.status).toBe(201);
    expect(body.runId).toBeTruthy();
    expect(uploaded).toMatchObject({
      kind: "uploaded_file",
      fileName: "notes.txt",
      mimeType: "text/plain",
      byteSize: 5,
    });
    expect(uploaded?.value).toMatch(
      /^\.maister\/demo\/runs\/.+\/uploads\/launch\/notes\.txt$/,
    );
    expect(uploaded?.storagePath).toEqual(
      expect.stringContaining(state.runtimeRoot ?? ""),
    );
  });

  it("rejects multipart upload count limits before worktree side effects", async () => {
    const files = Array.from(
      { length: 11 },
      (_, index) => new File(["x"], `notes-${index}.txt`),
    );
    const res = await POST(multipartLaunchRequest({ files }));
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("PRECONDITION");
    expect(mocks.addWorktree).not.toHaveBeenCalled();
    expect(state.inserts).toHaveLength(0);
  });

  it("rejects at capacity before worktree, DB, or supervisor side effects", async () => {
    const { MaisterError } = (await import("@/lib/errors")) as {
      MaisterError: typeof RuntimeMaisterError;
    };

    mocks.assertScratchCapacityAvailable.mockRejectedValue(
      new MaisterError("CONFLICT", "scratch run capacity is full"),
    );

    const res = await POST(launchRequest());
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("CONFLICT");
    expect(mocks.addWorktree).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.sendScratchPromptAndProjectEvents).not.toHaveBeenCalled();
    expect(state.inserts).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
  });

  it("rejects invalid file attachments before worktree side effects", async () => {
    const res = await POST(
      launchRequest({
        attachments: [
          {
            kind: "file_path",
            value: "../../../../etc/passwd",
          },
        ],
      }),
    );
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("PRECONDITION");
    expect(mocks.addWorktree).not.toHaveBeenCalled();
    expect(mocks.materializeCapabilityProfile).not.toHaveBeenCalled();
    expect(state.inserts).toHaveLength(0);
  });

  it("removes the worktree when capability materialization fails", async () => {
    mocks.materializeCapabilityProfile.mockRejectedValueOnce(
      new Error("materialize failed"),
    );

    const res = await POST(launchRequest());
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(500);
    expect(body.code).toBe("CRASH");
    expect(mocks.addWorktree).toHaveBeenCalledTimes(1);
    expect(mocks.removeWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRepoPath: "/repo/demo",
        force: true,
      }),
    );
    expect(mocks.removeBranch).toHaveBeenCalledWith({
      projectRepoPath: "/repo/demo",
      branch: "maister/demo/scratch/test",
    });
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("removes the worktree when the transactional capacity recheck loses the race", async () => {
    const { MaisterError } = (await import("@/lib/errors")) as {
      MaisterError: typeof RuntimeMaisterError;
    };

    mocks.assertScratchCapacityAvailableInTransaction.mockRejectedValueOnce(
      new MaisterError("CONFLICT", "scratch run capacity is full"),
    );

    const res = await POST(launchRequest());
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("CONFLICT");
    expect(mocks.addWorktree).toHaveBeenCalledTimes(1);
    expect(mocks.removeWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRepoPath: "/repo/demo",
        force: true,
      }),
    );
    expect(mocks.removeBranch).toHaveBeenCalledWith({
      projectRepoPath: "/repo/demo",
      branch: "maister/demo/scratch/test",
    });
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(state.inserts).toHaveLength(0);
  });
});
