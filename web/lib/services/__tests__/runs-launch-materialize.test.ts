import { getTableName } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// T6 "wiring" (migrated for M30/ADR-079 §4): launchRun delegates the
// launch-time capability-bundle materialization to the extracted
// `materializeProjectBundlesIntoWorktree` helper, right after `addWorktree`,
// passing the project id, the new worktree path, and
// base = input.baseBranch ?? project.mainBranch. The per-bundle copy,
// Installed-only filter, and the >=1-Installed gate now live INSIDE the
// helper — covered by
// lib/capabilities/__tests__/materialize-project-bundles.integration.test.ts.

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
  materializeProjectBundlesIntoWorktree: vi.fn(),
}));

// `from()` is both awaitable (selects with no `.where()`, e.g.
// platformAcpRunners / platformRouterSidecars) AND chainable to `.where()`.
// Either terminal consumes exactly one positional `state.selectResults` slot.
// It is a lazy thenable (NOT an eager Promise) so chained `.where()` selects do
// not also consume a slot via an auto-scheduled `from()` microtask.
type FromResult = PromiseLike<Record<string, unknown>[]> & {
  where: (predicate: unknown) => Promise<Record<string, unknown>[]>;
};
// The M28/T2.1 latest-flow-run gate query (`runs` table) also dispatches by
// TABLE IDENTITY — no prior runs here, so every task stays a fresh launchable
// Backlog task and the positional slots are unchanged.
type LatestRunChain = {
  where: (predicate: unknown) => {
    orderBy: (order: unknown) => {
      limit: (n: number) => Promise<Record<string, unknown>[]>;
    };
  };
};
type SelectChain = {
  from: (table: unknown) => FromResult | LatestRunChain | RelationJoinChain;
};
// ADR-078: getOpenRelationBlockers joins task_relations→tasks→projects; these
// tests model "no open blockers" with an empty result.
type RelationJoinChain = {
  innerJoin: (table: unknown, on: unknown) => RelationJoinChain;
  where: (predicate: unknown) => Promise<Record<string, unknown>[]>;
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
} = {
  selectResults: [],
  selectCalls: 0,
  inserts: [],
};

function nextSelectResult(): Record<string, unknown>[] {
  const result = state.selectResults[state.selectCalls] ?? [];

  state.selectCalls += 1;

  return result;
}

const relationJoinChain: RelationJoinChain = {
  innerJoin: () => relationJoinChain,
  where: async () => [],
};
const fakeDb: FakeDb = {
  select: () => ({
    from: (table: unknown): FromResult | LatestRunChain | RelationJoinChain => {
      if (getTableName(table as never) === "runs") {
        return {
          where: () => ({
            orderBy: () => ({ limit: async () => [] }),
          }),
        };
      }
      if (getTableName(table as never) === "task_relations") {
        return relationJoinChain;
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
  materializeProjectBundlesIntoWorktree:
    mocks.materializeProjectBundlesIntoWorktree,
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
// capabilityImports query now lives inside the mocked
// materializeProjectBundlesIntoWorktree helper — no positional slot here.
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
  mocks.materializeProjectBundlesIntoWorktree.mockResolvedValue({
    bundles: 1,
  });

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
  it("delegates to the helper once with the project, worktree, and default base branch", async () => {
    await launchRun({ taskId: TASK_ID }, ctx(), fakeDb);

    const worktreePath = usedWorktreePath();

    expect(mocks.materializeProjectBundlesIntoWorktree).toHaveBeenCalledTimes(
      1,
    );
    expect(mocks.materializeProjectBundlesIntoWorktree).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreePath,
      baseBranch: "main",
      db: fakeDb,
    });
  });

  it("passes an explicit launch base branch to the helper", async () => {
    await launchRun(
      { taskId: TASK_ID, baseBranch: "develop", targetBranch: "release" },
      ctx(),
      fakeDb,
    );

    const worktreePath = usedWorktreePath();

    expect(mocks.materializeProjectBundlesIntoWorktree).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreePath,
      baseBranch: "develop",
      db: fakeDb,
    });
  });

  it("runs the helper after addWorktree (materialization targets the fresh worktree)", async () => {
    const order: string[] = [];

    mocks.addWorktree.mockImplementation(async () => {
      order.push("addWorktree");
    });
    mocks.materializeProjectBundlesIntoWorktree.mockImplementation(async () => {
      order.push("materialize");

      return { bundles: 0 };
    });

    await launchRun({ taskId: TASK_ID }, ctx(), fakeDb);

    expect(order).toEqual(["addWorktree", "materialize"]);
  });
});
