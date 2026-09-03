import type { MaisterError as RuntimeMaisterError } from "@/lib/errors";

import { getTableName } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ADR-132 §a — ephemeral per-run package pin. The launch resolves the task
// flow's revision from an explicitly named `package_installs` row instead of
// the project attachment's enabled revision; the validation matrix below is
// the allow-list the code gates (every row refuses BEFORE any worktree side
// effect, hoisted above the adopt/revert compensation window). Fake-db idiom
// shared with runs-launch-gate.test.ts: `runs`/`task_relations`/
// `package_installs`/`flow_revisions` dispatch by TABLE IDENTITY, everything
// else positionally.

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
type RelationJoinChain = {
  innerJoin: (table: unknown, on: unknown) => RelationJoinChain;
  where: (predicate: unknown) => Promise<Record<string, unknown>[]>;
};
type SelectChain = {
  from: (table: unknown) => FromResult | LatestRunChain | RelationJoinChain;
};
type InsertCall = { table: unknown; values: Record<string, unknown> };
type InsertResult = Promise<void> & {
  onConflictDoNothing: () => {
    returning: (cols?: unknown) => Promise<Array<{ id: string }>>;
  };
};

type FakeDb = {
  select: (fields?: unknown) => SelectChain;
  insert: (table: unknown) => { values: (values: unknown) => InsertResult };
  update: (table: unknown) => {
    set: (values: unknown) => { where: (predicate: unknown) => Promise<void> };
  };
  transaction: <T>(fn: (tx: FakeDb) => Promise<T>) => Promise<T>;
  execute: (query?: unknown) => Promise<{ rows: unknown[] }>;
};

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const RUNNER_ID = "22222222-2222-4222-8222-222222222222";
const TASK_ID = "33333333-3333-4333-8333-333333333333";
const FLOW_ID = "44444444-4444-4444-8444-444444444444";
const ENABLED_REVISION_ID = "55555555-5555-4555-8555-555555555555";
const PIN_INSTALL_ID = "77777777-7777-4777-8777-777777777777";
const PIN_REVISION_ID = "88888888-8888-4888-8888-888888888888";

const state: {
  selectResults: Record<string, unknown>[][];
  selectCalls: number;
  inserts: InsertCall[];
  latestFlowRuns: Record<string, unknown>[];
  packageInstallRows: Record<string, unknown>[];
  // Awaited-where results: the UN-pinned enabled-revision site select.
  flowRevisionRows: Record<string, unknown>[];
  // .where().limit(1) results: the ADR-132 pin revision lookup — a DIFFERENT
  // chain shape, so the predicate-blind fake can discriminate the two sites.
  pinRevisionLookupRows: Record<string, unknown>[];
} = {
  selectResults: [],
  selectCalls: 0,
  inserts: [],
  latestFlowRuns: [],
  packageInstallRows: [],
  flowRevisionRows: [],
  pinRevisionLookupRows: [],
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
      const name = getTableName(table as never);

      if (name === "runs") {
        return {
          where: () => ({
            orderBy: () => ({
              limit: async () => state.latestFlowRuns,
            }),
          }),
        };
      }
      if (name === "task_relations") return relationJoinChain;
      if (name === "package_installs") {
        return {
          then: (onFulfilled) =>
            Promise.resolve(state.packageInstallRows).then(onFulfilled),
          where: async () => state.packageInstallRows,
        };
      }
      if (name === "flow_revisions") {
        const whereChain = {
          then: (onFulfilled: (rows: Record<string, unknown>[]) => unknown) =>
            Promise.resolve(state.flowRevisionRows).then(onFulfilled),
          limit: async () => state.pinRevisionLookupRows,
        };

        return {
          then: (onFulfilled: (rows: Record<string, unknown>[]) => unknown) =>
            Promise.resolve(state.flowRevisionRows).then(onFulfilled),
          where: () => whereChain,
        } as unknown as FromResult;
      }

      return {
        then: (onFulfilled) =>
          Promise.resolve(nextSelectResult()).then(onFulfilled),
        where: async () => nextSelectResult(),
      };
    },
  }),
  insert: (table: unknown) => ({
    values: (values: unknown): InsertResult => {
      state.inserts.push({ table, values: values as Record<string, unknown> });
      const result = Promise.resolve() as InsertResult;

      result.onConflictDoNothing = () => ({
        returning: async () => [{ id: (values as { id?: string }).id ?? "" }],
      });

      return result;
    },
  }),
  update: () => ({
    set: () => ({
      where: () => {
        const result = Promise.resolve(undefined) as Promise<undefined> & {
          returning: () => Promise<Array<{ attemptNumber: number }>>;
        };

        result.returning = async () => [{ attemptNumber: 1 }];

        return result;
      },
    }),
  }),
  transaction: async <T>(fn: (tx: FakeDb) => Promise<T>) => fn(fakeDb),
  execute: async () => ({ rows: [] }),
};

vi.mock("@/lib/db/client", () => ({ getDb: () => fakeDb }));
vi.mock("@/lib/worktree", () => ({
  addWorktree: mocks.addWorktree,
  removeWorktree: mocks.removeWorktree,
  listBranches: mocks.listBranches,
  resolveBaseCommit: mocks.resolveBaseCommit,
  listRemoteUrls: vi.fn(async () => []),
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

function taskRow(): Record<string, unknown> {
  return {
    id: TASK_ID,
    projectId: PROJECT_ID,
    flowId: FLOW_ID,
    status: "Backlog",
    attemptNumber: 0,
  };
}

function pinInstallRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: PIN_INSTALL_ID,
    sourceUrl: "https://example.com/plugins",
    name: "bugfix-pkg",
    versionLabel: "bugfix-pkg/v2.0.0",
    resolvedRevision: "b".repeat(40),
    packageStatus: "Installed",
    trustStatus: "trusted",
    sourceLocalPackageId: null,
    ...overrides,
  };
}

function pinRevisionRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: PIN_REVISION_ID,
    flowRefId: "bugfix",
    versionLabel: "bugfix-pkg/v2.0.0",
    resolvedRevision: "b".repeat(40),
    packageStatus: "Installed",
    setupStatus: "not_required",
    schemaVersion: 1,
    engineMin: null,
    engineMax: null,
    defaultRunnerId: null,
    manifest: {
      schemaVersion: 1,
      name: "Bugfix",
      nodes: [
        {
          id: "run",
          type: "cli",
          action: { command: "true" },
          transitions: { success: "done" },
        },
      ],
    },
    ...overrides,
  };
}

function enabledRevisionRow(): Record<string, unknown> {
  return {
    id: ENABLED_REVISION_ID,
    flowRefId: "bugfix",
    versionLabel: "bugfix-pkg/v1.0.0",
    resolvedRevision: "a".repeat(40),
    packageStatus: "Installed",
    setupStatus: "not_required",
    schemaVersion: 1,
    engineMin: null,
    engineMax: null,
    defaultRunnerId: null,
    manifest: {
      schemaVersion: 1,
      name: "Bugfix",
      nodes: [
        {
          id: "run",
          type: "cli",
          action: { command: "true" },
          transitions: { success: "done" },
        },
      ],
    },
  };
}

// Positional slots: task, project, flow, runtime settings, runner catalog,
// platform configuration. `flow_revisions` dispatches by identity (state.flowRevisionRows
// feeds BOTH the pin lookup and the un-pinned enabled-revision site), so the
// gate test's positional revision slot does not exist here.
function seedSelects(opts: { flow?: Record<string, unknown> } = {}): void {
  state.latestFlowRuns = [];
  state.packageInstallRows = [pinInstallRow()];
  state.flowRevisionRows = [enabledRevisionRow()];
  state.pinRevisionLookupRows = [pinRevisionRow()];
  state.selectResults = [
    [taskRow()],
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
      opts.flow ?? {
        id: FLOW_ID,
        projectId: PROJECT_ID,
        flowRefId: "bugfix",
        enabledRevisionId: ENABLED_REVISION_ID,
        enablementState: "Enabled",
        trustStatus: "trusted_by_policy",
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
  state.packageInstallRows = [];
  state.flowRevisionRows = [];
  state.pinRevisionLookupRows = [];

  ({ MaisterError } = await import("@/lib/errors"));

  mocks.worktreesRoot.mockReturnValue("/tmp/maister-worktrees");
  mocks.addWorktree.mockResolvedValue(undefined);
  mocks.removeWorktree.mockResolvedValue(undefined);
  mocks.listBranches.mockResolvedValue(["main", "develop"]);
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
  mocks.compileManifest.mockReturnValue({
    nodes: new Map(),
    sessions: new Map([["default", { name: "default" }]]),
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

function pinInput() {
  return {
    taskId: TASK_ID,
    packagePin: { packageInstallId: PIN_INSTALL_ID },
  };
}

function runInsert(): Record<string, unknown> | undefined {
  return state.inserts.find(
    (call) => getTableName(call.table as never) === "runs",
  )?.values;
}

describe("launchRun packagePin — refusal matrix (ADR-132 §a, allow-list)", () => {
  it("refuses an unknown packageInstallId with CONFIG before any worktree", async () => {
    state.packageInstallRows = [];

    await expect(launchRun(pinInput(), ctx(), fakeDb)).rejects.toMatchObject({
      code: "CONFIG",
    });
    expect(mocks.addWorktree).not.toHaveBeenCalled();
  });

  it("refuses an install that is not Installed with PRECONDITION", async () => {
    state.packageInstallRows = [pinInstallRow({ packageStatus: "Removed" })];

    await expect(launchRun(pinInput(), ctx(), fakeDb)).rejects.toMatchObject({
      code: "PRECONDITION",
    });
    expect(mocks.addWorktree).not.toHaveBeenCalled();
  });

  it("refuses an untrusted install with PRECONDITION", async () => {
    state.packageInstallRows = [pinInstallRow({ trustStatus: "untrusted" })];

    await expect(launchRun(pinInput(), ctx(), fakeDb)).rejects.toMatchObject({
      code: "PRECONDITION",
    });
    expect(mocks.addWorktree).not.toHaveBeenCalled();
  });

  it("refuses an install lacking a revision with the task's flowRefId — CONFIG naming both ids", async () => {
    state.pinRevisionLookupRows = [];

    let thrown: unknown;

    try {
      await launchRun(pinInput(), ctx(), fakeDb);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ code: "CONFIG" });
    expect(String((thrown as Error).message)).toContain(PIN_INSTALL_ID);
    expect(String((thrown as Error).message)).toContain("bugfix");
    expect(mocks.addWorktree).not.toHaveBeenCalled();
  });

  it("refuses an unsupported manifest schemaVersion on the pinned revision with CONFIG", async () => {
    state.pinRevisionLookupRows = [pinRevisionRow({ schemaVersion: 999 })];

    await expect(launchRun(pinInput(), ctx(), fakeDb)).rejects.toMatchObject({
      code: "CONFIG",
    });
    expect(mocks.addWorktree).not.toHaveBeenCalled();
  });

  it("refuses an engine-incompatible pinned revision with CONFIG", async () => {
    state.pinRevisionLookupRows = [pinRevisionRow({ engineMin: "99.0.0" })];

    await expect(launchRun(pinInput(), ctx(), fakeDb)).rejects.toMatchObject({
      code: "CONFIG",
    });
    expect(mocks.addWorktree).not.toHaveBeenCalled();
  });

  it("refuses a pinned revision whose setup is pending/failed with PRECONDITION", async () => {
    state.pinRevisionLookupRows = [pinRevisionRow({ setupStatus: "pending" })];

    await expect(launchRun(pinInput(), ctx(), fakeDb)).rejects.toMatchObject({
      code: "PRECONDITION",
    });
    expect(mocks.addWorktree).not.toHaveBeenCalled();
  });

  it("throws MaisterError instances (typed codes, never plain Error)", async () => {
    state.packageInstallRows = [];

    await expect(launchRun(pinInput(), ctx(), fakeDb)).rejects.toBeInstanceOf(
      MaisterError,
    );
  });
});

describe("launchRun packagePin — happy paths snapshot the PINNED revision", () => {
  it("launches on an upstream install's revision (attachment not required, D1)", async () => {
    const result = await launchRun(pinInput(), ctx(), fakeDb);

    expect(result.runId).toBeDefined();
    expect(runInsert()).toMatchObject({
      flowRevisionId: PIN_REVISION_ID,
      flowRevision: "b".repeat(40),
      flowVersion: "bugfix-pkg/v2.0.0",
    });
  });

  it("launches on a local-cut install's revision (sourceLocalPackageId set)", async () => {
    state.packageInstallRows = [
      pinInstallRow({
        sourceLocalPackageId: "99999999-9999-4999-8999-999999999999",
        versionLabel: "local-abcdef123456",
        trustStatus: "trusted_by_policy",
      }),
    ];
    state.pinRevisionLookupRows = [
      pinRevisionRow({ versionLabel: "local-abcdef123456" }),
    ];

    const result = await launchRun(pinInput(), ctx(), fakeDb);

    expect(result.runId).toBeDefined();
    expect(runInsert()).toMatchObject({
      flowRevisionId: PIN_REVISION_ID,
      flowVersion: "local-abcdef123456",
    });
  });
});

describe("launchRun packagePin — project-flow gates still apply unchanged", () => {
  it("refuses a disabled project flow with PRECONDITION even with a valid pin", async () => {
    seedSelects({
      flow: {
        id: FLOW_ID,
        projectId: PROJECT_ID,
        flowRefId: "bugfix",
        enabledRevisionId: ENABLED_REVISION_ID,
        enablementState: "Disabled",
        trustStatus: "trusted_by_policy",
      },
    });

    await expect(launchRun(pinInput(), ctx(), fakeDb)).rejects.toMatchObject({
      code: "PRECONDITION",
    });
    expect(mocks.addWorktree).not.toHaveBeenCalled();
  });
});
