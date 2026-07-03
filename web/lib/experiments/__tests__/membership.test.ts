import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { deriveExperimentMembershipFromSource } from "@/lib/experiments/membership";

type Row = Record<string, unknown>;
type State = {
  runs: Row[];
  experiments: Row[];
  experimentRuns: Row[];
};

function fakeDb(state: State) {
  return {
    select: () => ({
      from: (table: unknown) => {
        const tableName = getTableName(table as never);
        const rows =
          tableName === "runs"
            ? state.runs
            : tableName === "experiments"
              ? state.experiments
              : tableName === "experiment_runs"
                ? state.experimentRuns
                : [];

        return {
          where: () => ({
            orderBy: () => Promise.resolve(rows),
            limit: () => Promise.resolve(rows),
          }),
        };
      },
    }),
  };
}

function state(overrides: Partial<State> = {}): State {
  return {
    runs: [{ id: "source-run-1", taskId: "task-1" }],
    experiments: [
      {
        id: "exp-1",
        status: "running",
        baseCommit: "9c4e1f0a8b7d6c5e4f3a2b1c0d9e8f7a6b5c4d3e",
      },
    ],
    experimentRuns: [
      {
        experimentId: "exp-1",
        runId: "source-run-1",
        variantKey: "claude",
        replicateOrdinal: 1,
      },
      {
        experimentId: "exp-1",
        runId: "older-replicate",
        variantKey: "claude",
        replicateOrdinal: 2,
      },
    ],
    ...overrides,
  };
}

describe("deriveExperimentMembershipFromSource", () => {
  it("allocates the next replicate ordinal for an active source member", async () => {
    await expect(
      deriveExperimentMembershipFromSource({
        db: fakeDb(state()),
        sourceRunId: "source-run-1",
        taskId: "task-1",
        launchReason: "manual_relaunch",
      }),
    ).resolves.toEqual({
      experimentId: "exp-1",
      variantKey: "claude",
      replicateOrdinal: 3,
      launchReason: "manual_relaunch",
      baseCommit: "9c4e1f0a8b7d6c5e4f3a2b1c0d9e8f7a6b5c4d3e",
    });
  });

  it("rejects a relaunch source from another task with CONFLICT", async () => {
    await expect(
      deriveExperimentMembershipFromSource({
        db: fakeDb(
          state({ runs: [{ id: "source-run-1", taskId: "other-task" }] }),
        ),
        sourceRunId: "source-run-1",
        taskId: "task-1",
        launchReason: "manual_relaunch",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("returns null when the source run is not an experiment member", async () => {
    await expect(
      deriveExperimentMembershipFromSource({
        db: fakeDb(state({ experimentRuns: [] })),
        sourceRunId: "source-run-1",
        taskId: "task-1",
        launchReason: "manual_relaunch",
      }),
    ).resolves.toBeNull();
  });

  it("returns null for a terminal experiment so restarts become plain runs", async () => {
    await expect(
      deriveExperimentMembershipFromSource({
        db: fakeDb(
          state({
            experiments: [
              {
                id: "exp-1",
                status: "concluded",
                baseCommit: "9c4e1f0a8b7d6c5e4f3a2b1c0d9e8f7a6b5c4d3e",
              },
            ],
          }),
        ),
        sourceRunId: "source-run-1",
        taskId: "task-1",
        launchReason: "budget_restart",
      }),
    ).resolves.toBeNull();
  });

  it("rejects a missing relaunch source with PRECONDITION", async () => {
    await expect(
      deriveExperimentMembershipFromSource({
        db: fakeDb(state({ runs: [] })),
        sourceRunId: "missing-run",
        taskId: "task-1",
        launchReason: "manual_relaunch",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });
});
