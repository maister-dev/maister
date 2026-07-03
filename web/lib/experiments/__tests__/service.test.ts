import { getTableName } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as schemaModule from "@/lib/db/schema";
const { experiments, projects, runs, taskActivity, tasks } =
  schemaModule as unknown as Record<string, any>;

const mocks = vi.hoisted(() => ({
  resolveBaseCommit: vi.fn(),
  assertBaseCommitReachable: vi.fn(),
}));

vi.mock("@/lib/worktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/worktree")>()),
  resolveBaseCommit: mocks.resolveBaseCommit,
  assertBaseCommitReachable: mocks.assertBaseCommitReachable,
}));

type Row = Record<string, unknown>;

type State = {
  projects: Row[];
  tasks: Row[];
  experiments: Row[];
  experimentRuns?: Row[];
  runs?: Row[];
  activities?: Row[];
  inserts: Row[];
  updates?: Row[];
};

function rowsFor(table: unknown, state: State): Row[] {
  switch (getTableName(table as never)) {
    case "tasks":
      return state.tasks;
    case "projects":
      return state.projects;
    case "experiments":
      return state.experiments;
    case "experiment_runs":
      return state.experimentRuns ?? [];
    case "runs":
      return state.runs ?? [];
    default:
      return [];
  }
}

function selectChain(rows: Row[]): PromiseLike<Row[]> & {
  where: () => ReturnType<typeof selectChain>;
  orderBy: () => ReturnType<typeof selectChain>;
  limit: (n: number) => Promise<Row[]>;
  for: () => Promise<Row[]>;
} {
  return {
    then: (onFulfilled) => Promise.resolve(rows).then(onFulfilled),
    where: () => selectChain(rows),
    orderBy: () => selectChain(rows),
    limit: async (n: number) => rows.slice(0, n),
    for: async () => rows,
  };
}

function fakeDb(state: State): any {
  return {
    select: () => ({
      from: (table: unknown) => selectChain(rowsFor(table, state)),
    }),
    insert: (table: unknown) => ({
      values: (row: Row) => {
        if (getTableName(table as never) === "experiments") {
          state.experiments.push(row);
          state.inserts.push(row);
        }
        if (getTableName(table as never) === "task_activity") {
          (state.activities ??= []).push(row);
          state.inserts.push(row);
        }

        return {
          returning: async () => [row],
          then: (onFulfilled: (value: Row) => unknown) =>
            Promise.resolve(row).then(onFulfilled),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Row) => ({
        where: () => ({
          returning: async () => {
            state.updates ??= [];
            state.updates.push(patch);

            if (getTableName(table as never) !== "experiments") {
              return [];
            }

            state.experiments = state.experiments.map((row) => ({
              ...row,
              ...patch,
            }));

            return state.experiments.slice(0, 1);
          },
        }),
      }),
    }),
    transaction: async <T>(fn: (tx: ReturnType<typeof fakeDb>) => Promise<T>) =>
      fn(fakeDb(state)),
  };
}

function variant(key: string, label = key) {
  return { key, label, config: { runnerId: `runner-${key}` } };
}

function projectTask(overrides: Row = {}): Row {
  return {
    id: "task-1",
    projectId: "project-1",
    number: 7,
    title: "Task",
    ...overrides,
  };
}

function projectRow(overrides: Row = {}): Row {
  return {
    id: "project-1",
    slug: "demo",
    repoPath: "/repos/demo",
    mainBranch: "main",
    archivedAt: null,
    ...overrides,
  };
}

function experimentRow(overrides: Row = {}): Row {
  return {
    id: "exp-1",
    projectId: "project-1",
    taskId: "task-1",
    title: "Compare runners",
    description: null,
    baseBranch: "main",
    baseCommit: "a".repeat(40),
    status: "draft",
    variants: [variant("claude"), variant("codex")],
    rubric: { criteria: [] },
    verdict: null,
    createdByUserId: "user-1",
    updatedAt: new Date("2026-07-03T10:01:00.000Z"),
    createdAt: new Date("2026-07-03T10:00:00.000Z"),
    launchedAt: null,
    comparableAt: null,
    concludedAt: null,
    abandonedAt: null,
    ...overrides,
  };
}

let service: typeof import("@/lib/experiments/service");

beforeEach(async () => {
  mocks.resolveBaseCommit.mockImplementation(
    async ({ baseRef }: { baseRef: string }) =>
      baseRef === "feature-tip" ? "b".repeat(40) : "a".repeat(40),
  );
  mocks.assertBaseCommitReachable.mockImplementation(
    async ({ baseCommit }: { baseCommit: string }) => baseCommit.toLowerCase(),
  );

  service = await import("@/lib/experiments/service");
});

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("experiment service create", () => {
  it("rejects duplicate variant keys with CONFIG before insert", async () => {
    const state: State = {
      projects: [projectRow()],
      tasks: [projectTask()],
      experiments: [],
      inserts: [],
    };

    await expect(
      service.createExperiment(
        {
          projectId: "project-1",
          slug: "demo",
          actorUserId: "user-1",
          input: {
            taskId: "task-1",
            title: "Compare runners",
            baseBranch: "main",
            variants: [variant("same"), variant("same", "Same again")],
          },
        },
        fakeDb(state),
      ),
    ).rejects.toMatchObject({ code: "CONFIG" });

    expect(state.inserts).toHaveLength(0);
    expect(mocks.resolveBaseCommit).not.toHaveBeenCalled();
  });

  it("rejects a task from another project with PRECONDITION", async () => {
    const state: State = {
      projects: [projectRow()],
      tasks: [projectTask({ projectId: "other-project" })],
      experiments: [],
      inserts: [],
    };

    await expect(
      service.createExperiment(
        {
          projectId: "project-1",
          slug: "demo",
          actorUserId: "user-1",
          input: {
            taskId: "task-1",
            title: "Compare runners",
            baseBranch: "main",
            variants: [variant("claude"), variant("codex")],
          },
        },
        fakeDb(state),
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION" });

    expect(state.inserts).toHaveLength(0);
  });

  it("pins an explicit baseRef after reachability validation and returns an exact detail DTO", async () => {
    const state: State = {
      projects: [projectRow()],
      tasks: [projectTask()],
      experiments: [],
      inserts: [],
    };

    const dto = await service.createExperiment(
      {
        projectId: "project-1",
        slug: "demo",
        actorUserId: "user-1",
        input: {
          taskId: "task-1",
          title: "Compare runners",
          description: "Two agent paths",
          baseBranch: "main",
          baseRef: "feature-tip",
          variants: [variant("claude"), variant("codex")],
        },
      },
      fakeDb(state),
    );

    expect(mocks.resolveBaseCommit).toHaveBeenCalledWith({
      projectRepoPath: "/repos/demo",
      baseRef: "feature-tip",
    });
    expect(mocks.assertBaseCommitReachable).toHaveBeenCalledWith({
      projectRepoPath: "/repos/demo",
      baseRef: "main",
      baseCommit: "b".repeat(40),
    });
    expect(state.inserts[0]).toMatchObject({
      projectId: "project-1",
      taskId: "task-1",
      title: "Compare runners",
      description: "Two agent paths",
      baseBranch: "main",
      baseCommit: "b".repeat(40),
      status: "draft",
      createdByUserId: "user-1",
    });
    expect(Object.keys(dto).sort()).toEqual([
      "abandonedAt",
      "baseBranch",
      "baseCommit",
      "comparableAt",
      "concludedAt",
      "createdAt",
      "description",
      "id",
      "launchedAt",
      "projectId",
      "rubric",
      "status",
      "taskId",
      "title",
      "variants",
      "verdict",
    ]);
    expect(dto).not.toHaveProperty("createdByUserId");
    expect(dto.baseCommit).toBe("b".repeat(40));
  });

  it("maps an unreachable explicit baseRef to CONFIG without inserting", async () => {
    const state: State = {
      projects: [projectRow()],
      tasks: [projectTask()],
      experiments: [],
      inserts: [],
    };

    mocks.assertBaseCommitReachable.mockRejectedValueOnce(
      new Error("not an ancestor"),
    );

    await expect(
      service.createExperiment(
        {
          projectId: "project-1",
          slug: "demo",
          actorUserId: "user-1",
          input: {
            taskId: "task-1",
            title: "Compare runners",
            baseBranch: "main",
            baseRef: "feature-tip",
            variants: [variant("claude"), variant("codex")],
          },
        },
        fakeDb(state),
      ),
    ).rejects.toMatchObject({ code: "CONFIG" });

    expect(state.inserts).toHaveLength(0);
  });
});

describe("experiment service reads", () => {
  it("lists only project experiments newest first as list DTOs", async () => {
    const oldRow = experimentRow({
      id: "old",
      createdAt: new Date("2026-07-03T09:00:00.000Z"),
    });
    const newRow = experimentRow({
      id: "new",
      createdAt: new Date("2026-07-03T11:00:00.000Z"),
      verdict: { human: { outcome: "winner", winnerVariantKey: "codex" } },
    });
    const foreignRow = experimentRow({ id: "foreign", projectId: "other" });
    const state: State = {
      projects: [projectRow()],
      tasks: [projectTask()],
      experiments: [oldRow, foreignRow, newRow],
      inserts: [],
    };

    const list = await service.listProjectExperiments(
      "project-1",
      fakeDb(state),
    );

    expect(list.map((item) => item.id)).toEqual(["new", "old"]);
    expect(Object.keys(list[0]).sort()).toEqual([
      "baseBranch",
      "baseCommit",
      "createdAt",
      "id",
      "status",
      "taskId",
      "taskNumber",
      "title",
      "variantsCount",
      "verdictOutcome",
      "winnerVariantKey",
    ]);
    expect(list[0]).toMatchObject({
      taskNumber: 7,
      variantsCount: 2,
      winnerVariantKey: "codex",
      verdictOutcome: "winner",
    });
  });

  it("returns null for a detail row outside the slug-derived project", async () => {
    const state: State = {
      projects: [projectRow()],
      tasks: [projectTask()],
      experiments: [experimentRow({ id: "exp-foreign", projectId: "other" })],
      inserts: [],
    };

    await expect(
      service.getExperimentDetail(
        "project-1",
        "exp-foreign",
        fakeDb(state),
      ),
    ).resolves.toBeNull();
  });
});

describe("experiment service lifecycle", () => {
  it("rejects machine actors before conclusion side effects", async () => {
    const state: State = {
      projects: [projectRow()],
      tasks: [projectTask()],
      experiments: [experimentRow({ status: "comparable" })],
      inserts: [],
    };

    await expect(
      service.concludeExperiment(
        {
          projectId: "project-1",
          experimentId: "exp-1",
          actor: { type: "agent", id: "agent-1" },
          input: {
            outcome: "winner",
            winnerVariantKey: "claude",
            abandonLosers: false,
          },
        },
        fakeDb(state),
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    expect(state.inserts).toHaveLength(0);
    expect(state.updates ?? []).toHaveLength(0);
  });

  it("rejects conclusion while running and after terminal conclusion", async () => {
    const stopRun = vi.fn(async () => ({ ok: true }));

    for (const status of ["running", "concluded"] as const) {
      const state: State = {
        projects: [projectRow()],
        tasks: [projectTask()],
        experiments: [experimentRow({ status })],
        inserts: [],
      };

      await expect(
        service.concludeExperiment(
          {
            projectId: "project-1",
            experimentId: "exp-1",
            actor: { type: "user", id: "user-1" },
            input: {
              outcome: "winner",
              winnerVariantKey: "claude",
              abandonLosers: false,
            },
            stopRun,
          },
          fakeDb(state),
        ),
      ).rejects.toMatchObject({ code: "PRECONDITION" });

      expect(state.inserts).toHaveLength(0);
      expect(state.updates ?? []).toHaveLength(0);
    }

    expect(stopRun).not.toHaveBeenCalled();
  });

  it("concludes comparable experiments, records activity, and stops loser live runs after commit", async () => {
    const stopRun = vi.fn(async () => ({ ok: true }));
    const state: State = {
      projects: [projectRow()],
      tasks: [projectTask()],
      experiments: [
        experimentRow({
          status: "comparable",
          rubric: {
            criteria: [
              {
                id: "correctness",
                label: "Correctness",
                guidance: "Works",
                scale: { min: 1, max: 5 },
                weight: 1,
              },
            ],
          },
        }),
      ],
      experimentRuns: [
        { experimentId: "exp-1", runId: "run-winner", variantKey: "claude" },
        { experimentId: "exp-1", runId: "run-loser-live", variantKey: "codex" },
        { experimentId: "exp-1", runId: "run-loser-settled", variantKey: "codex" },
      ],
      runs: [
        { id: "run-winner", status: "Running" },
        { id: "run-loser-live", status: "NeedsInput" },
        { id: "run-loser-settled", status: "Review" },
      ],
      inserts: [],
    };

    const dto = await service.concludeExperiment(
      {
        projectId: "project-1",
        experimentId: "exp-1",
        actor: { type: "user", id: "user-1" },
        input: {
          outcome: "winner",
          winnerVariantKey: "claude",
          scores: { correctness: { claude: 5, codex: 3 } },
          abandonLosers: true,
        },
        stopRun,
      },
      fakeDb(state),
    );

    expect(dto.status).toBe("concluded");
    expect(dto.verdict?.human).toMatchObject({
      outcome: "winner",
      winnerVariantKey: "claude",
    });
    expect(state.activities).toHaveLength(1);
    expect(state.activities?.[0]).toMatchObject({
      taskId: "task-1",
      projectId: "project-1",
      actorType: "user",
      actorId: "user-1",
      eventKind: "experiment_concluded",
    });
    expect(stopRun).toHaveBeenCalledTimes(1);
    expect(stopRun).toHaveBeenCalledWith("run-loser-live");
  });

  it.each(["draft", "running", "comparable"] as const)(
    "abandons %s experiments and stops live member runs",
    async (status) => {
      const stopRun = vi.fn(async () => ({ ok: true }));
      const state: State = {
        projects: [projectRow()],
        tasks: [projectTask()],
        experiments: [experimentRow({ status })],
        experimentRuns: [
          { experimentId: "exp-1", runId: "run-live", variantKey: "claude" },
          { experimentId: "exp-1", runId: "run-settled", variantKey: "codex" },
        ],
        runs: [
          { id: "run-live", status: "Running" },
          { id: "run-settled", status: "Done" },
        ],
        inserts: [],
      };

      const dto = await service.abandonExperiment(
        {
          projectId: "project-1",
          experimentId: "exp-1",
          actorUserId: "user-1",
          input: { stopLiveRuns: true },
          stopRun,
        },
        fakeDb(state),
      );

      expect(dto.status).toBe("abandoned");
      expect(stopRun).toHaveBeenCalledTimes(1);
      expect(stopRun).toHaveBeenCalledWith("run-live");
    },
  );

  it("rejects double abandonment without stopping runs", async () => {
    const stopRun = vi.fn(async () => ({ ok: true }));
    const state: State = {
      projects: [projectRow()],
      tasks: [projectTask()],
      experiments: [experimentRow({ status: "abandoned" })],
      experimentRuns: [
        { experimentId: "exp-1", runId: "run-live", variantKey: "claude" },
      ],
      runs: [{ id: "run-live", status: "Running" }],
      inserts: [],
    };

    await expect(
      service.abandonExperiment(
        {
          projectId: "project-1",
          experimentId: "exp-1",
          actorUserId: "user-1",
          input: { stopLiveRuns: true },
          stopRun,
        },
        fakeDb(state),
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION" });

    expect(stopRun).not.toHaveBeenCalled();
  });
});
