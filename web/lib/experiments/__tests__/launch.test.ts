import { getTableName } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  launchRun: vi.fn(),
  assertBaseCommitReachable: vi.fn(),
}));

vi.mock("@/lib/services/runs", () => ({
  launchRun: mocks.launchRun,
}));

vi.mock("@/lib/worktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/worktree")>()),
  assertBaseCommitReachable: mocks.assertBaseCommitReachable,
}));

type Row = Record<string, any>;
type State = {
  projects: Row[];
  experiments: Row[];
  experimentRuns: Row[];
  capabilityRecords?: Row[];
  platformAcpRunners?: Row[];
  lockedTables?: string[];
  transactionCount?: number;
};

function rowsFor(table: unknown, state: State): Row[] {
  switch (getTableName(table as never)) {
    case "projects":
      return state.projects;
    case "experiments":
      return state.experiments;
    case "experiment_runs":
      return state.experimentRuns;
    case "capability_records":
      return state.capabilityRecords ?? [];
    case "platform_acp_runners":
      return state.platformAcpRunners ?? [];
    default:
      return [];
  }
}

function selectChain(
  rows: Row[],
  tableName: string,
  state: State,
): PromiseLike<Row[]> & {
  where: () => ReturnType<typeof selectChain>;
  orderBy: () => ReturnType<typeof selectChain>;
  limit: (n: number) => ReturnType<typeof selectChain>;
  for: (mode: "update") => Promise<Row[]>;
} {
  return {
    then: (onFulfilled) => Promise.resolve(rows).then(onFulfilled),
    where: () => selectChain(rows, tableName, state),
    orderBy: () => selectChain(rows, tableName, state),
    limit: (n: number) => selectChain(rows.slice(0, n), tableName, state),
    for: async () => {
      state.lockedTables?.push(tableName);

      return rows;
    },
  };
}

function fakeDb(state: State) {
  state.lockedTables ??= [];
  state.transactionCount ??= 0;

  const api = {
    select: () => ({
      from: (table: unknown) =>
        selectChain(rowsFor(table, state), getTableName(table as never), state),
    }),
    transaction: async (callback: (tx: unknown) => unknown) => {
      state.transactionCount = (state.transactionCount ?? 0) + 1;

      return await callback(api);
    },
  };

  return api;
}

function project(overrides: Row = {}): Row {
  return {
    id: "project-1",
    repoPath: "/repos/demo",
    archivedAt: null,
    ...overrides,
  };
}

function experiment(overrides: Row = {}): Row {
  return {
    id: "exp-1",
    projectId: "project-1",
    taskId: "task-1",
    title: "Compare runners",
    status: "draft",
    baseBranch: "main",
    baseCommit: "a".repeat(40),
    variants: [
      {
        key: "claude",
        label: "Claude",
        config: { runnerId: "runner-claude" },
      },
      {
        key: "codex",
        label: "Codex",
        config: {
          runnerId: "runner-codex",
          executionPolicy: { preset: "assisted" },
        },
      },
    ],
    ...overrides,
  };
}

let launch: typeof import("@/lib/experiments/launch");

beforeEach(async () => {
  mocks.launchRun.mockImplementation(
    async (input: { experimentMembership?: { variantKey: string } }) => ({
      runId: `run-${input.experimentMembership?.variantKey ?? "plain"}-${
        mocks.launchRun.mock.calls.length + 1
      }`,
      status: mocks.launchRun.mock.calls.length <= 2 ? "Running" : "Pending",
      queuePosition: mocks.launchRun.mock.calls.length <= 2 ? undefined : 1,
    }),
  );
  mocks.assertBaseCommitReachable.mockResolvedValue("a".repeat(40));

  launch = await import("@/lib/experiments/launch");
});

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("launchExperimentVariants", () => {
  it("fans out all variants and replicates through launchRun with pinned membership", async () => {
    const state: State = {
      projects: [project()],
      experiments: [experiment()],
      experimentRuns: [],
    };

    const result = await launch.launchExperimentVariants(
      {
        projectId: "project-1",
        experimentId: "exp-1",
        actorUserId: "user-1",
        input: { variants: "all", replicates: 2 },
      },
      fakeDb(state),
    );

    expect(mocks.assertBaseCommitReachable).toHaveBeenCalledWith({
      projectRepoPath: "/repos/demo",
      baseRef: "main",
      baseCommit: "a".repeat(40),
    });
    expect(state.transactionCount).toBe(1);
    expect(state.lockedTables).toEqual(["experiments", "experiment_runs"]);
    expect(mocks.launchRun).toHaveBeenCalledTimes(4);
    expect(mocks.launchRun.mock.calls[0][0]).toMatchObject({
      taskId: "task-1",
      runnerId: "runner-claude",
      baseBranch: "main",
      baseCommit: "a".repeat(40),
      experimentMembership: {
        experimentId: "exp-1",
        variantKey: "claude",
        replicateOrdinal: 1,
        launchReason: "initial",
        baseCommit: "a".repeat(40),
      },
    });
    expect(mocks.launchRun.mock.calls[2][0]).toMatchObject({
      runnerId: "runner-codex",
      executionPolicy: { preset: "assisted" },
      experimentMembership: {
        variantKey: "codex",
        replicateOrdinal: 1,
      },
    });
    expect(result).toMatchObject({
      experimentId: "exp-1",
      outcomes: [
        { variantKey: "claude", replicateOrdinal: 1, status: "Running" },
        { variantKey: "claude", replicateOrdinal: 2, status: "Running" },
        {
          variantKey: "codex",
          replicateOrdinal: 1,
          status: "Pending",
          queuePosition: 1,
        },
        {
          variantKey: "codex",
          replicateOrdinal: 2,
          status: "Pending",
          queuePosition: 1,
        },
      ],
    });
  });

  it("rejects an unknown requested variant before launching anything", async () => {
    const state: State = {
      projects: [project()],
      experiments: [experiment()],
      experimentRuns: [],
    };

    await expect(
      launch.launchExperimentVariants(
        {
          projectId: "project-1",
          experimentId: "exp-1",
          actorUserId: "user-1",
          input: { variants: ["ghost"], replicates: 1 },
        },
        fakeDb(state),
      ),
    ).rejects.toMatchObject({ code: "CONFIG" });

    expect(mocks.launchRun).not.toHaveBeenCalled();
  });

  it("rejects terminal experiments before launching anything", async () => {
    const state: State = {
      projects: [project()],
      experiments: [experiment({ status: "concluded" })],
      experimentRuns: [],
    };

    await expect(
      launch.launchExperimentVariants(
        {
          projectId: "project-1",
          experimentId: "exp-1",
          actorUserId: "user-1",
          input: { variants: "all", replicates: 1 },
        },
        fakeDb(state),
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION" });

    expect(mocks.launchRun).not.toHaveBeenCalled();
  });

  it("validates the pinned base commit before launching anything", async () => {
    const state: State = {
      projects: [project()],
      experiments: [experiment()],
      experimentRuns: [],
    };

    mocks.assertBaseCommitReachable.mockRejectedValueOnce(
      new Error("missing base"),
    );

    await expect(
      launch.launchExperimentVariants(
        {
          projectId: "project-1",
          experimentId: "exp-1",
          actorUserId: "user-1",
          input: { variants: "all", replicates: 1 },
        },
        fakeDb(state),
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION" });

    expect(mocks.launchRun).not.toHaveBeenCalled();
  });

  it("rejects a vanished overlay ref before launching anything", async () => {
    const state: State = {
      projects: [project()],
      experiments: [
        experiment({
          variants: [
            {
              key: "claude",
              label: "Claude",
              config: {
                runnerId: "runner-claude",
                capabilityOverlay: { skills: { add: ["missing-skill"] } },
              },
            },
          ],
        }),
      ],
      experimentRuns: [],
      capabilityRecords: [],
    };

    await expect(
      launch.launchExperimentVariants(
        {
          projectId: "project-1",
          experimentId: "exp-1",
          actorUserId: "user-1",
          input: { variants: "all", replicates: 1 },
        },
        fakeDb(state),
      ),
    ).rejects.toMatchObject({ code: "CONFIG" });

    expect(mocks.launchRun).not.toHaveBeenCalled();
  });

  it("rejects unsupported subagent overlays for non-Claude runners before launching anything", async () => {
    const state: State = {
      projects: [project()],
      experiments: [
        experiment({
          variants: [
            {
              key: "codex",
              label: "Codex",
              config: {
                runnerId: "runner-codex",
                capabilityOverlay: { subagents: { add: ["reviewer"] } },
              },
            },
          ],
        }),
      ],
      experimentRuns: [],
      capabilityRecords: [
        {
          projectId: "project-1",
          capabilityRefId: "reviewer",
          kind: "agent_definition",
          disabledAt: null,
        },
      ],
      platformAcpRunners: [
        {
          id: "runner-codex",
          capabilityAgent: "codex",
        },
      ],
    };

    await expect(
      launch.launchExperimentVariants(
        {
          projectId: "project-1",
          experimentId: "exp-1",
          actorUserId: "user-1",
          input: { variants: "all", replicates: 1 },
        },
        fakeDb(state),
      ),
    ).rejects.toMatchObject({ code: "CONFIG" });

    expect(mocks.launchRun).not.toHaveBeenCalled();
  });

  it("rejects unsupported overlays against the inherited project default runner before launching anything", async () => {
    const state: State = {
      projects: [project({ defaultRunnerId: "runner-codex" })],
      experiments: [
        experiment({
          variants: [
            {
              key: "inherited",
              label: "Inherited default",
              config: {
                capabilityOverlay: { subagents: { add: ["reviewer"] } },
              },
            },
          ],
        }),
      ],
      experimentRuns: [],
      capabilityRecords: [
        {
          projectId: "project-1",
          capabilityRefId: "reviewer",
          kind: "agent_definition",
          disabledAt: null,
        },
      ],
      platformAcpRunners: [
        {
          id: "runner-codex",
          capabilityAgent: "codex",
        },
      ],
    };

    await expect(
      launch.launchExperimentVariants(
        {
          projectId: "project-1",
          experimentId: "exp-1",
          actorUserId: "user-1",
          input: { variants: "all", replicates: 1 },
        },
        fakeDb(state),
      ),
    ).rejects.toMatchObject({ code: "CONFIG" });

    expect(mocks.launchRun).not.toHaveBeenCalled();
  });
});
