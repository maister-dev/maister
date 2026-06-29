import type { NextRequest } from "next/server";
import type { MaisterError as RuntimeMaisterError } from "@/lib/errors";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { getTableName } from "drizzle-orm";
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
      then: PromiseLike<Record<string, unknown>[]>["then"];
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
  runners: Record<string, unknown>[];
  runtimeSettings: Record<string, unknown>[];
} = {
  inserts: [],
  updates: [],
  selectCalls: 0,
  runtimeRoot: null,
  project: {},
  runners: [],
  runtimeSettings: [],
};

function rowsForTable(table: unknown): Record<string, unknown>[] {
  const tableName = getTableName(table as never);

  if (tableName === "projects") return [state.project];
  if (tableName === "platform_acp_runners") return state.runners;
  if (tableName === "platform_runtime_settings") return state.runtimeSettings;
  if (tableName === "scratch_runs") {
    return [{ runId: "run-1", dialogStatus: "Running" }];
  }

  return [];
}

const fakeDb: FakeDb = {
  select: () => ({
    from: (table: unknown) => {
      const nextRows = async () => {
        state.selectCalls += 1;

        return rowsForTable(table);
      };

      return {
        where: async () => nextRows(),
        then: <TResult1 = Record<string, unknown>[], TResult2 = never>(
          onfulfilled?:
            | ((
                value: Record<string, unknown>[],
              ) => TResult1 | PromiseLike<TResult1>)
            | null,
          onrejected?:
            | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
            | null,
        ) => nextRows().then(onfulfilled, onrejected),
      };
    },
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

// M42 (ADR-114): the scratch launch writes the resume handle on the run's
// active run_sessions row; the fake DB models only the legacy tables, so stub
// the helper (a fresh launch has a single default session).
vi.mock("@/lib/runs/active-run-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/runs/active-run-session")>()),
  loadActiveRunSession: vi.fn(async () => ({
    sessionName: "default",
    acpSessionId: null,
    runnerSnapshot: null,
    capabilityAgent: "claude",
    runnerId: null,
    runnerResolutionTier: null,
  })),
  persistRunSessionAcpSessionId: vi.fn(async () => {}),
}));
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
vi.mock("@/lib/capabilities/adapter-home", () => ({
  materializeAdapterCapabilityHome: vi.fn(async () => ({
    env: {},
    materializedRoots: [],
  })),
}));
vi.mock("@/lib/scratch-runs/events", () => ({
  sendScratchPromptAndProjectEvents: mocks.sendScratchPromptAndProjectEvents,
  normalizeScratchPrompt: (prompt: string) => prompt,
}));

let POST: (req: NextRequest) => Promise<Response>;

const projectId = "11111111-1111-4111-8111-111111111111";
const runnerId = "codex-openai";

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
    defaultRunnerId: null,
    archivedAt: null,
  };
  state.runners = [
    {
      id: runnerId,
      adapter: "codex",
      capabilityAgent: "codex",
      model: "gpt-5",
      provider: { kind: "openai" },
      permissionPolicy: "default",
      sidecarId: null,
      readinessStatus: "Ready",
      enabled: true,
    },
  ];
  state.runtimeSettings = [{ id: "singleton", defaultRunnerId: runnerId }];

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
    runnerId,
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

function cancelableLaunchRequest(controller: AbortController): NextRequest {
  return new Request("http://x/api/scratch-runs", {
    method: "POST",
    body: JSON.stringify(launchPayload()),
    signal: controller.signal,
  }) as NextRequest;
}

function parseSseFrames(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.startsWith("data:"))
    .map(
      (block) =>
        JSON.parse(block.slice(block.indexOf("data:") + 5).trim()) as Record<
          string,
          unknown
        >,
    );
}

describe("POST /api/scratch-runs", () => {
  it("launches a scratch supervisor session with persisted run rows", async () => {
    const res = await POST(launchRequest());
    const frames = parseSseFrames(await res.text());
    const body = (frames.find((f) => f.type === "scratch.launch_result")
      ?.result ?? {}) as {
      runId?: string;
      status?: { dialogStatus?: string };
    };

    expect(res.headers.get("content-type")).toContain("text/event-stream");
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
    const createArg = mocks.createSession.mock.calls[0]?.[0] as
      | { readOnlySession?: boolean }
      | undefined;

    expect(createArg?.readOnlySession).not.toBe(true);
    expect(mocks.sendScratchPromptAndProjectEvents).toHaveBeenCalledWith({
      runId: body.runId,
      sessionId: "supervisor-session-1",
      stepId: "dialog",
      prompt: "Investigate the thing",
    });
    expect(state.inserts.length).toBeGreaterThanOrEqual(4);
    // M42 (ADR-114): the runner identity lands on the run's `default`
    // run_sessions row (via defaultRunSessionValues), not the runs insert.
    expect(
      state.inserts.find((call) =>
        Object.prototype.hasOwnProperty.call(
          call.values as object,
          "sessionName",
        ),
      )?.values,
    ).toMatchObject({
      runnerId,
      runnerResolutionTier: "launchOverride",
      capabilityAgent: "codex",
      runnerSnapshot: {
        id: runnerId,
        capabilityAgent: "codex",
        model: "gpt-5",
        providerKind: "openai",
      },
    });
  });

  it("prepares a scratch supervisor session without sending an empty initial prompt", async () => {
    const res = await POST(launchRequest({ prompt: "" }));
    const frames = parseSseFrames(await res.text());
    const body = (frames.find((f) => f.type === "scratch.launch_result")
      ?.result ?? {}) as {
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

    expect(res.headers.get("content-type")).toContain("text/event-stream");
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
    const frames = parseSseFrames(await res.text());
    const body = (frames.find((f) => f.type === "scratch.launch_result")
      ?.result ?? {}) as { runId?: string };
    const addArgs = mocks.addWorktree.mock.calls[0]?.[0] as
      | { branch?: string }
      | undefined;

    expect(res.headers.get("content-type")).toContain("text/event-stream");
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
    const frames = parseSseFrames(await res.text());
    const body = (frames.find((f) => f.type === "scratch.launch_result")
      ?.result ?? {}) as { runId?: string };
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

    expect(res.headers.get("content-type")).toContain("text/event-stream");
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

  it("removes the worktree when the transactional capacity recheck loses the race", async () => {
    const { MaisterError } = (await import("@/lib/errors")) as {
      MaisterError: typeof RuntimeMaisterError;
    };

    mocks.assertScratchCapacityAvailableInTransaction.mockRejectedValueOnce(
      new MaisterError("CONFLICT", "scratch run capacity is full"),
    );

    // The in-transaction recheck fires AFTER worktree_created → it is an
    // in-stream error frame + compensation, not a pre-stream JSON 409.
    const res = await POST(launchRequest());
    const frames = parseSseFrames(await res.text());

    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(frames.find((f) => f.type === "error")).toMatchObject({
      type: "error",
      code: "CONFLICT",
    });
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

  // ── Phase 6 (FR-F1/F2): streaming-POST launch progress ──────────────────
  it("streams ordered launch-progress SSE frames then a result frame", async () => {
    const res = await POST(launchRequest());

    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const frames = parseSseFrames(await res.text());
    const stages = frames
      .filter((f) => f.type === "scratch.launch_progress")
      .map((f) => f.stage);

    expect(stages).toEqual([
      "precondition",
      "worktree_created",
      "materializing",
      "spawning",
      "session_ready",
    ]);
    expect(frames.find((f) => f.stage === "materializing")?.adapter).toBe(
      "codex",
    );

    const ready = frames.find((f) => f.stage === "session_ready");
    const result = frames.find((f) => f.type === "scratch.launch_result");
    const runId = (result?.result as { runId?: string } | undefined)?.runId;

    expect(runId).toBeTruthy();
    expect(ready).toMatchObject({
      runId,
      dialogUrl: `/scratch-runs/${runId}`,
    });
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
  });

  it("leaves the scratch dialog retryable when the initial prompt hits transient runner auth", async () => {
    const { MaisterError } = (await import("@/lib/errors")) as {
      MaisterError: typeof RuntimeMaisterError;
    };

    mocks.sendScratchPromptAndProjectEvents.mockRejectedValueOnce(
      new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        "ACP prompt failed because adapter authentication is unavailable: API key not valid",
      ),
    );

    const res = await POST(launchRequest());
    const frames = parseSseFrames(await res.text());

    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(frames.find((f) => f.stage === "session_ready")).toBeTruthy();
    expect(frames.find((f) => f.type === "error")).toMatchObject({
      type: "error",
      code: "EXECUTOR_UNAVAILABLE",
    });
    expect(state.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          values: expect.objectContaining({
            dialogStatus: "WaitingForUser",
            errorCode: "EXECUTOR_UNAVAILABLE",
            errorMessage: expect.stringContaining("API key not valid"),
          }),
        }),
        expect.objectContaining({
          values: expect.objectContaining({
            status: "Running",
            currentStepId: "dialog",
          }),
        }),
      ]),
    );
    expect(state.updates).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          values: expect.objectContaining({ status: "Crashed" }),
        }),
        expect.objectContaining({
          values: expect.objectContaining({ dialogStatus: "Crashed" }),
        }),
      ]),
    );
  });

  it("surfaces a typed in-stream error frame and compensates when materialization fails after worktree", async () => {
    mocks.materializeCapabilityProfile.mockRejectedValueOnce(
      new Error("materialize failed"),
    );

    const res = await POST(launchRequest());

    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const frames = parseSseFrames(await res.text());

    expect(frames.map((f) => f.stage)).toContain("worktree_created");
    expect(frames.find((f) => f.type === "error")).toMatchObject({
      type: "error",
      code: "CRASH",
    });
    expect(mocks.removeWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ projectRepoPath: "/repo/demo", force: true }),
    );
    expect(mocks.removeBranch).toHaveBeenCalledWith({
      projectRepoPath: "/repo/demo",
      branch: "maister/demo/scratch/test",
    });
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("compensates worktree + branch on client cancel after worktree creation, before spawn", async () => {
    const controller = new AbortController();

    // Abort the launch the instant the worktree is created — the execute path
    // must detect the abort at the next stage boundary and GC, not spawn.
    mocks.addWorktree.mockImplementationOnce(async () => {
      controller.abort();
    });

    // Drain the stream so the background start() loop (and its server-side
    // compensation) completes before we assert.
    const res = await POST(cancelableLaunchRequest(controller));

    await res.text();

    expect(mocks.addWorktree).toHaveBeenCalledTimes(1);
    expect(mocks.materializeCapabilityProfile).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.removeWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ projectRepoPath: "/repo/demo", force: true }),
    );
    expect(mocks.removeBranch).toHaveBeenCalledWith({
      projectRepoPath: "/repo/demo",
      branch: "maister/demo/scratch/test",
    });
  });

  it("keeps pre-stream precondition rejections as JSON with an HTTP status", async () => {
    mocks.checkSupervisorHealth.mockResolvedValue({
      kind: "unavailable",
      reason: "down",
      message: "no daemon",
    });

    const res = await POST(launchRequest());
    const body = (await res.json()) as { code?: string };

    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.status).toBe(503);
    expect(body.code).toBe("EXECUTOR_UNAVAILABLE");
    expect(mocks.addWorktree).not.toHaveBeenCalled();
  });
});
