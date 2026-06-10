import type { MaisterError as RuntimeMaisterError } from "@/lib/errors";

import { getTableName } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// M28/T2.1 — pins the launchRun relaunch gate on the shared classifier
// (`classifyTaskLaunchability` over the latest flow run) instead of the old
// `task.status !== "Backlog"` check. `tasks.status` is a one-way latch, so a
// latched InFlight task whose latest run is Failed/Abandoned MUST relaunch
// (attempt N+1), while busy/crashed/terminal classifications refuse with
// PRECONDITION.

const mocks = vi.hoisted(() => ({
  addWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  listBranches: vi.fn(),
  resolveBaseCommit: vi.fn(),
  checkSupervisorHealth: vi.fn(),
  tryStartRun: vi.fn(),
  runFlow: vi.fn(),
  worktreesRoot: vi.fn(),
  compileManifest: vi.fn(),
}));

// `from()` is both awaitable (selects with no `.where()`) AND chainable to
// `.where()` — same lazy-thenable fake as runs-launch-branch.test.ts. The
// `runs` table dispatches by TABLE IDENTITY (not positionally, robust against
// select-index drift) to the `.where().orderBy().limit()` latest-flow-run
// chain fed from `state.latestFlowRuns`.
type FromResult = PromiseLike<Record<string, unknown>[]> & {
  where: (predicate: unknown) => Promise<Record<string, unknown>[]>;
};
type LatestRunChain = {
  where: (predicate: unknown) => {
    orderBy: (order: unknown) => {
      limit: (n: number) => Promise<Record<string, unknown>[]>;
    };
  };
};
type SelectChain = {
  from: (table: unknown) => FromResult | LatestRunChain;
};
type InsertCall = { table: unknown; values: Record<string, unknown> };

type FakeDb = {
  select: (fields?: unknown) => SelectChain;
  insert: (table: unknown) => { values: (values: unknown) => Promise<void> };
  update: (table: unknown) => {
    set: (values: unknown) => { where: (predicate: unknown) => Promise<void> };
  };
  transaction: <T>(fn: (tx: FakeDb) => Promise<T>) => Promise<T>;
};

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const RUNNER_ID = "22222222-2222-4222-8222-222222222222";
const TASK_ID = "33333333-3333-4333-8333-333333333333";
const FLOW_ID = "44444444-4444-4444-8444-444444444444";
const REVISION_ID = "55555555-5555-4555-8555-555555555555";

const state: {
  selectResults: Record<string, unknown>[][];
  selectCalls: number;
  inserts: InsertCall[];
  latestFlowRuns: Record<string, unknown>[];
} = {
  selectResults: [],
  selectCalls: 0,
  inserts: [],
  latestFlowRuns: [],
};

function nextSelectResult(): Record<string, unknown>[] {
  const result = state.selectResults[state.selectCalls] ?? [];

  state.selectCalls += 1;

  return result;
}

const fakeDb: FakeDb = {
  select: () => ({
    from: (table: unknown): FromResult | LatestRunChain => {
      if (getTableName(table as never) === "runs") {
        return {
          where: () => ({
            orderBy: () => ({
              limit: async () => state.latestFlowRuns,
            }),
          }),
        };
      }

      return {
        then: (onFulfilled) =>
          Promise.resolve(nextSelectResult()).then(onFulfilled),
        where: async () => nextSelectResult(),
      };
    },
  }),
  insert: (table: unknown) => ({
    values: async (values: unknown) => {
      state.inserts.push({ table, values: values as Record<string, unknown> });
    },
  }),
  update: () => ({
    set: () => ({ where: async () => undefined }),
  }),
  transaction: async <T>(fn: (tx: FakeDb) => Promise<T>) => fn(fakeDb),
};

vi.mock("@/lib/db/client", () => ({ getDb: () => fakeDb }));
vi.mock("@/lib/worktree", () => ({
  addWorktree: mocks.addWorktree,
  removeWorktree: mocks.removeWorktree,
  listBranches: mocks.listBranches,
  resolveBaseCommit: mocks.resolveBaseCommit,
}));
vi.mock("@/lib/supervisor-client", () => ({
  checkSupervisorHealth: mocks.checkSupervisorHealth,
}));
vi.mock("@/lib/scheduler", () => ({ tryStartRun: mocks.tryStartRun }));
vi.mock("@/lib/flows/runner", () => ({ runFlow: mocks.runFlow }));
vi.mock("@/lib/instance-config", () => ({
  worktreesRoot: mocks.worktreesRoot,
}));
vi.mock("@/lib/flows/graph/compile", () => ({
  compileManifest: mocks.compileManifest,
}));

type LaunchRunFn = typeof import("@/lib/services/runs").launchRun;

let launchRun: LaunchRunFn;
let MaisterError: typeof RuntimeMaisterError;

function taskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    projectId: PROJECT_ID,
    flowId: FLOW_ID,
    status: "Backlog",
    attemptNumber: 0,
    ...overrides,
  };
}

// Same 11 positional select slots as runs-launch-branch.test.ts (the latest-
// flow-run `runs` select resolves by table identity, NOT positionally, so the
// slots below are unchanged). Slots 8-11 omitted → `[]` past the array end.
function seedSelects(opts: { task?: Record<string, unknown> } = {}): void {
  state.selectResults = [
    [opts.task ?? taskRow()],
    [
      {
        id: PROJECT_ID,
        slug: "demo",
        name: "Demo",
        repoPath: "/repos/demo",
        mainBranch: "main",
        branchPrefix: "maister/",
        archivedAt: null,
        defaultRunnerId: null,
        promotionMode: null,
      },
    ],
    [
      {
        id: FLOW_ID,
        flowRefId: "bugfix",
        enabledRevisionId: REVISION_ID,
        enablementState: "Enabled",
        trustStatus: "trusted_by_policy",
      },
    ],
    [
      {
        id: REVISION_ID,
        versionLabel: "v1.0.0",
        resolvedRevision: "a".repeat(40),
        packageStatus: "Installed",
        setupStatus: "not_required",
        schemaVersion: 1,
        engineMin: null,
        engineMax: null,
        defaultRunnerId: null,
        manifest: { schemaVersion: 1, name: "Bugfix", nodes: [] },
      },
    ],
    [{ id: "singleton", defaultRunnerId: RUNNER_ID }],
    [
      {
        id: RUNNER_ID,
        adapter: "claude",
        capabilityAgent: "claude",
        model: "claude-sonnet-4-6",
        provider: { kind: "anthropic" },
        permissionPolicy: "default",
        sidecarId: null,
        readinessStatus: "Ready",
        enabled: true,
      },
    ],
    [],
  ];
}

beforeEach(async () => {
  state.selectResults = [];
  state.selectCalls = 0;
  state.inserts = [];
  state.latestFlowRuns = [];

  ({ MaisterError } = await import("@/lib/errors"));

  mocks.worktreesRoot.mockReturnValue("/tmp/maister-worktrees");
  mocks.addWorktree.mockResolvedValue(undefined);
  mocks.removeWorktree.mockResolvedValue(undefined);
  mocks.listBranches.mockResolvedValue(["main", "develop", "release"]);
  mocks.resolveBaseCommit.mockResolvedValue("deadbeefdeadbeefdeadbeef");
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
  mocks.tryStartRun.mockResolvedValue({ started: false, queuePosition: 1 });
  mocks.runFlow.mockResolvedValue(undefined);
  mocks.compileManifest.mockReturnValue({ nodes: new Map() });

  seedSelects();

  ({ launchRun } = await import("@/lib/services/runs"));
});

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

function ctx() {
  return { actorUserId: "user-1", authorize: async () => undefined };
}

function flowRun(status: string): Record<string, unknown> {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    taskId: TASK_ID,
    runKind: "flow",
    status,
    startedAt: new Date("2026-06-01T00:00:00Z"),
  };
}

describe("launchRun — classifier gate ACCEPTS retry-eligible tasks (M28/T2.1)", () => {
  it("accepts a latched InFlight task whose latest flow run is Failed (attempt N+1)", async () => {
    seedSelects({ task: taskRow({ status: "InFlight", attemptNumber: 1 }) });
    state.latestFlowRuns = [flowRun("Failed")];

    const result = await launchRun({ taskId: TASK_ID }, ctx(), fakeDb);

    expect(result.runId).toBeDefined();
    expect(mocks.addWorktree).toHaveBeenCalledTimes(1);
    expect(mocks.addWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: expect.stringContaining("attempt-2"),
      }),
    );
  });

  it("accepts a Backlog task whose latest flow run is Abandoned", async () => {
    seedSelects({ task: taskRow({ status: "Backlog", attemptNumber: 2 }) });
    state.latestFlowRuns = [flowRun("Abandoned")];

    const result = await launchRun({ taskId: TASK_ID }, ctx(), fakeDb);

    expect(result.runId).toBeDefined();
    expect(mocks.addWorktree).toHaveBeenCalledTimes(1);
  });
});

describe("launchRun — classifier gate REFUSES non-launchable tasks (M28/T2.1)", () => {
  it("refuses a task with an active latest run (busy) and never touches the worktree", async () => {
    seedSelects({ task: taskRow({ status: "InFlight" }) });
    state.latestFlowRuns = [flowRun("Running")];

    await expect(
      launchRun({ taskId: TASK_ID }, ctx(), fakeDb),
    ).rejects.toMatchObject({
      code: "PRECONDITION",
      message: expect.stringContaining("classification: busy"),
    });

    expect(mocks.addWorktree).not.toHaveBeenCalled();
  });

  it("refuses a task whose latest run is Crashed (owes recover/discard)", async () => {
    seedSelects({ task: taskRow({ status: "InFlight" }) });
    state.latestFlowRuns = [flowRun("Crashed")];

    await expect(
      launchRun({ taskId: TASK_ID }, ctx(), fakeDb),
    ).rejects.toMatchObject({
      code: "PRECONDITION",
      message: expect.stringContaining("classification: crashed"),
    });

    expect(mocks.addWorktree).not.toHaveBeenCalled();
  });

  it("refuses a Done task (target_terminal)", async () => {
    seedSelects({ task: taskRow({ status: "Done" }) });

    await expect(
      launchRun({ taskId: TASK_ID }, ctx(), fakeDb),
    ).rejects.toMatchObject({
      code: "PRECONDITION",
      message: expect.stringContaining("classification: target_terminal"),
    });

    expect(mocks.addWorktree).not.toHaveBeenCalled();
  });

  it("refuses an Abandoned task even with a retryable latest run (terminal precedence)", async () => {
    seedSelects({ task: taskRow({ status: "Abandoned" }) });
    state.latestFlowRuns = [flowRun("Failed")];

    await expect(
      launchRun({ taskId: TASK_ID }, ctx(), fakeDb),
    ).rejects.toMatchObject({
      code: "PRECONDITION",
      message: expect.stringContaining("classification: target_terminal"),
    });

    expect(mocks.addWorktree).not.toHaveBeenCalled();
  });

  it("refuses an InFlight task with no flow run at all (anomalous remnant → busy)", async () => {
    seedSelects({ task: taskRow({ status: "InFlight" }) });
    state.latestFlowRuns = [];

    await expect(
      launchRun({ taskId: TASK_ID }, ctx(), fakeDb),
    ).rejects.toMatchObject({
      code: "PRECONDITION",
      message: expect.stringContaining("classification: busy"),
    });

    expect(mocks.addWorktree).not.toHaveBeenCalled();
  });

  it("throws a MaisterError (not a plain Error) on refusal", async () => {
    seedSelects({ task: taskRow({ status: "Done" }) });

    await expect(
      launchRun({ taskId: TASK_ID }, ctx(), fakeDb),
    ).rejects.toBeInstanceOf(MaisterError);
  });
});
