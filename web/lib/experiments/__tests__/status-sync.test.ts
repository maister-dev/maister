import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { syncExperimentStatusForRun } from "@/lib/experiments/status-sync";

type Row = Record<string, unknown>;
type State = {
  experiments: Row[];
  experimentRuns: Row[];
  runs: Row[];
  updates: Array<{ tableName: string; values: Row }>;
};

function fakeDb(state: State) {
  return {
    select: () => ({
      from: (table: unknown) => {
        const tableName = getTableName(table as never);
        const rows =
          tableName === "experiments"
            ? state.experiments
            : tableName === "experiment_runs"
              ? state.experimentRuns
              : tableName === "runs"
                ? state.runs
                : [];

        return {
          where: () => ({
            for: () => Promise.resolve(rows),
            then: (
              resolve: (rows: Row[]) => unknown,
              reject?: (error: unknown) => unknown,
            ) => Promise.resolve(rows).then(resolve, reject),
          }),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (values: Row) => ({
        where: () => {
          state.updates.push({
            tableName: getTableName(table as never),
            values,
          });

          return Promise.resolve();
        },
      }),
    }),
  };
}

function state(overrides: Partial<State> = {}): State {
  return {
    experiments: [{ id: "exp-1", status: "running" }],
    experimentRuns: [
      { experimentId: "exp-1", runId: "run-a", variantKey: "a" },
      { experimentId: "exp-1", runId: "run-b", variantKey: "b" },
    ],
    runs: [
      { id: "run-a", status: "Review" },
      { id: "run-b", status: "Review" },
    ],
    updates: [],
    ...overrides,
  };
}

describe("syncExperimentStatusForRun", () => {
  it("returns null for non-member runs", async () => {
    const dbState = state({ experimentRuns: [] });

    await expect(
      syncExperimentStatusForRun({ db: fakeDb(dbState), runId: "plain-run" }),
    ).resolves.toBeNull();
    expect(dbState.updates).toEqual([]);
  });

  it("moves a draft experiment with a first member to running", async () => {
    const dbState = state({
      experiments: [{ id: "exp-1", status: "draft" }],
      experimentRuns: [
        { experimentId: "exp-1", runId: "run-a", variantKey: "a" },
      ],
      runs: [{ id: "run-a", status: "Running" }],
    });

    await expect(
      syncExperimentStatusForRun({ db: fakeDb(dbState), runId: "run-a" }),
    ).resolves.toMatchObject({
      changed: true,
      fromStatus: "draft",
      toStatus: "running",
    });
    expect(dbState.updates[0]).toMatchObject({
      tableName: "experiments",
      values: expect.objectContaining({ status: "running" }),
    });
  });

  it("moves running to comparable after all member runs settle across variants", async () => {
    const dbState = state();

    await expect(
      syncExperimentStatusForRun({ db: fakeDb(dbState), runId: "run-b" }),
    ).resolves.toMatchObject({
      changed: true,
      fromStatus: "running",
      toStatus: "comparable",
    });
  });

  it("keeps a parked member run from becoming comparable", async () => {
    const dbState = state({
      runs: [
        { id: "run-a", status: "Review" },
        { id: "run-b", status: "NeedsInput" },
      ],
    });

    await expect(
      syncExperimentStatusForRun({ db: fakeDb(dbState), runId: "run-b" }),
    ).resolves.toMatchObject({
      changed: false,
      fromStatus: "running",
      toStatus: "running",
    });
    expect(dbState.updates).toEqual([]);
  });

  it("does not overwrite terminal experiment statuses", async () => {
    const dbState = state({
      experiments: [{ id: "exp-1", status: "concluded" }],
    });

    await expect(
      syncExperimentStatusForRun({ db: fakeDb(dbState), runId: "run-a" }),
    ).resolves.toMatchObject({
      changed: false,
      fromStatus: "concluded",
      toStatus: "concluded",
    });
    expect(dbState.updates).toEqual([]);
  });
});
