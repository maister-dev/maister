import { getTableName } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// T6 "wiring" — RED. Pins the launch-time capability-bundle materialization
// contract the Implementor must add to `launchRun`, right after `addWorktree`:
//
//  - Query `capabilityImports` for rows where projectId === project.id AND
//    packageStatus === "Installed".
//  - For EACH such row:
//      await copyBundleArtifactsToWorktree({ installedPath, worktreePath }).
//  - Then ONCE:
//      await writeAiFactoryConfigOverride({ worktreePath, baseBranch: base })
//    where base = input.baseBranch ?? project.mainBranch (runs.ts:523).
//  - A row whose packageStatus !== "Installed" (e.g. "Installing") is NEVER
//    copied.
//
// Today NO such wiring exists, so both utils are called ZERO times — every
// `toHaveBeenCalledWith` below is unmet. That is the intended RED state.

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
  copyBundleArtifactsToWorktree: vi.fn(),
  writeAiFactoryConfigOverride: vi.fn(),
}));

// `from()` is both awaitable (selects with no `.where()`, e.g.
// platformAcpRunners / platformRouterSidecars) AND chainable to `.where()`.
// Either terminal consumes exactly one positional `state.selectResults` slot.
// It is a lazy thenable (NOT an eager Promise) so chained `.where()` selects do
// not also consume a slot via an auto-scheduled `from()` microtask.
type FromResult = PromiseLike<Record<string, unknown>[]> & {
  where: (predicate: unknown) => Promise<Record<string, unknown>[]>;
};
type SelectChain = {
  from: (table: unknown) => FromResult;
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
  capabilityImports: Record<string, unknown>[];
} = {
  selectResults: [],
  selectCalls: 0,
  inserts: [],
  capabilityImports: [],
};

function nextSelectResult(): Record<string, unknown>[] {
  const result = state.selectResults[state.selectCalls] ?? [];

  state.selectCalls += 1;

  return result;
}

// The capabilityImports query resolves by TABLE IDENTITY, not by positional
// slot — making the test robust against select-index drift (the 11 precondition
// selects stay positional; the new query is the 12th and runs after addWorktree).
// The fake mirrors the intended SQL `where(eq(packageStatus,"Installed"))` by
// filtering the seeded array itself (a real `.where(...)` is ignored otherwise),
// so the test meaningfully asserts the production code iterates ONLY Installed
// rows.
function installedImports(): Record<string, unknown>[] {
  return state.capabilityImports.filter(
    (row) => row.packageStatus === "Installed",
  );
}

const fakeDb: FakeDb = {
  select: () => ({
    from: (table: unknown): FromResult => {
      if (getTableName(table as never) === "capability_imports") {
        return {
          then: (onFulfilled) =>
            Promise.resolve(installedImports()).then(onFulfilled),
          where: async () => installedImports(),
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
vi.mock("@/lib/capabilities/materialize-bundle", () => ({
  copyBundleArtifactsToWorktree: mocks.copyBundleArtifactsToWorktree,
  writeAiFactoryConfigOverride: mocks.writeAiFactoryConfigOverride,
}));

type LaunchRunFn = typeof import("@/lib/services/runs").launchRun;

let launchRun: LaunchRunFn;

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: PROJECT_ID,
    slug: "demo",
    name: "Demo",
    repoPath: "/repos/demo",
    mainBranch: "main",
    branchPrefix: "maister/",
    archivedAt: null,
    defaultRunnerId: null,
    promotionMode: null,
    ...overrides,
  };
}

// The 11 sequential `_db.select()` calls launchRun performs, in order:
//   1 tasks, 2 projects, 3 flows, 4 flowRevisions, 5 platformRuntimeSettings,
//   6 platformAcpRunners (no .where), 7 platformRouterSidecars (no .where),
//   8 projectFlowRunnerDefaults, 9 flowRunnerRemaps, 10 projectFlowRoles,
//   11 capabilityRecords. Slots 8-11 are intentionally omitted: the fake DB
// returns `[]` past the array end (correct empty-result for those four). The
// 12th select (capabilityImports, after addWorktree) resolves by table
// identity, NOT positionally — see `state.capabilityImports`.
function seedSelects(opts: { project?: Record<string, unknown> } = {}): void {
  state.selectResults = [
    [
      {
        id: TASK_ID,
        projectId: PROJECT_ID,
        flowId: FLOW_ID,
        status: "Backlog",
        attemptNumber: 0,
      },
    ],
    [opts.project ?? project()],
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
    // 5 platformRuntimeSettings — platform default points at the seeded runner.
    [{ id: "singleton", defaultRunnerId: RUNNER_ID }],
    // 6 platformAcpRunners — the launch catalog (resolved via platformDefault).
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
    // 7 platformRouterSidecars — none needed for this runner.
    [],
  ];
}

beforeEach(async () => {
  state.selectResults = [];
  state.selectCalls = 0;
  state.inserts = [];
  state.capabilityImports = [];

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
  // A trivial compiled graph with no capability-bearing nodes — sidesteps the
  // M11c/M13/M14 enforcement gates so the test isolates the materialization.
  mocks.compileManifest.mockReturnValue({ nodes: new Map() });
  mocks.copyBundleArtifactsToWorktree.mockResolvedValue({
    skills: true,
    agents: true,
  });
  mocks.writeAiFactoryConfigOverride.mockResolvedValue(undefined);

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

function usedWorktreePath(): string {
  const wtArg = mocks.addWorktree.mock.calls[0][0] as { worktreePath: string };

  return wtArg.worktreePath;
}

describe("launchRun — capability-bundle materialization (T6 wiring)", () => {
  it("copies each Installed bundle into the new worktree", async () => {
    state.capabilityImports = [
      {
        installedPath: "/cache/aif@sha1",
        packageStatus: "Installed",
        projectId: PROJECT_ID,
      },
      {
        installedPath: "/cache/other@sha2",
        packageStatus: "Installed",
        projectId: PROJECT_ID,
      },
    ];

    await launchRun({ taskId: TASK_ID }, ctx(), fakeDb);

    const worktreePath = usedWorktreePath();

    expect(mocks.copyBundleArtifactsToWorktree).toHaveBeenCalledTimes(2);
    expect(mocks.copyBundleArtifactsToWorktree).toHaveBeenCalledWith({
      installedPath: "/cache/aif@sha1",
      worktreePath,
    });
    expect(mocks.copyBundleArtifactsToWorktree).toHaveBeenCalledWith({
      installedPath: "/cache/other@sha2",
      worktreePath,
    });
  });

  it("writes the AIF config override once with the run base branch (default main)", async () => {
    state.capabilityImports = [
      {
        installedPath: "/cache/aif@sha1",
        packageStatus: "Installed",
        projectId: PROJECT_ID,
      },
      {
        installedPath: "/cache/other@sha2",
        packageStatus: "Installed",
        projectId: PROJECT_ID,
      },
    ];

    await launchRun({ taskId: TASK_ID }, ctx(), fakeDb);

    const worktreePath = usedWorktreePath();

    expect(mocks.writeAiFactoryConfigOverride).toHaveBeenCalledTimes(1);
    expect(mocks.writeAiFactoryConfigOverride).toHaveBeenCalledWith({
      worktreePath,
      baseBranch: "main",
    });
  });

  it("writes the AIF config override with an explicit launch base branch", async () => {
    state.capabilityImports = [
      {
        installedPath: "/cache/aif@sha1",
        packageStatus: "Installed",
        projectId: PROJECT_ID,
      },
    ];

    await launchRun(
      { taskId: TASK_ID, baseBranch: "develop", targetBranch: "release" },
      ctx(),
      fakeDb,
    );

    const worktreePath = usedWorktreePath();

    expect(mocks.writeAiFactoryConfigOverride).toHaveBeenCalledWith({
      worktreePath,
      baseBranch: "develop",
    });
  });

  it("excludes non-Installed imports (e.g. Installing) from the copy", async () => {
    state.capabilityImports = [
      {
        installedPath: "/cache/aif@sha1",
        packageStatus: "Installed",
        projectId: PROJECT_ID,
      },
      {
        installedPath: "/cache/half@sha3",
        packageStatus: "Installing",
        projectId: PROJECT_ID,
      },
    ];

    await launchRun({ taskId: TASK_ID }, ctx(), fakeDb);

    const worktreePath = usedWorktreePath();

    expect(mocks.copyBundleArtifactsToWorktree).toHaveBeenCalledTimes(1);
    expect(mocks.copyBundleArtifactsToWorktree).toHaveBeenCalledWith({
      installedPath: "/cache/aif@sha1",
      worktreePath,
    });
    expect(mocks.copyBundleArtifactsToWorktree).not.toHaveBeenCalledWith({
      installedPath: "/cache/half@sha3",
      worktreePath,
    });
  });

  // Forward guard: pins that the WHOLE materialization block (bundle copy + AIF
  // config override) is gated on >=1 Installed import — a non-AIF project must
  // never get a stray `.ai-factory/config.yaml`. Stays green while the gate
  // holds; turns red if the config override is ever written UN-gated.
  it("skips materialization entirely when the project has no Installed imports", async () => {
    state.capabilityImports = [
      {
        installedPath: "/cache/half@sha3",
        packageStatus: "Installing",
        projectId: PROJECT_ID,
      },
    ];

    await launchRun({ taskId: TASK_ID }, ctx(), fakeDb);

    expect(mocks.copyBundleArtifactsToWorktree).not.toHaveBeenCalled();
    expect(mocks.writeAiFactoryConfigOverride).not.toHaveBeenCalled();
  });
});
