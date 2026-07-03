import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import * as schemaModule from "@/lib/db/schema";
import { getExperimentComparison } from "@/lib/experiments/comparison";

const {
  experimentRuns,
  experiments,
  gateResults,
  runCostRollups,
  runs,
  runSessions,
} = schemaModule as unknown as Record<string, any>;

type Row = Record<string, any>;

type State = {
  experiments: Row[];
  experimentRuns: Row[];
  runs: Row[];
  runSessions: Row[];
  gateResults: Row[];
  runCostRollups: Row[];
  updates: Row[];
};

function rowsFor(table: unknown, state: State): Row[] {
  switch (getTableName(table as never)) {
    case "experiments":
      return state.experiments;
    case "experiment_runs":
      return state.experimentRuns;
    case "runs":
      return state.runs;
    case "run_sessions":
      return state.runSessions;
    case "gate_results":
      return state.gateResults;
    case "run_cost_rollups":
      return state.runCostRollups;
    default:
      return [];
  }
}

function selectChain(rows: Row[]): PromiseLike<Row[]> & {
  where: () => ReturnType<typeof selectChain>;
  limit: (n: number) => Promise<Row[]>;
} {
  return {
    then: (onFulfilled) => Promise.resolve(rows).then(onFulfilled),
    where: () => selectChain(rows),
    limit: async (n: number) => rows.slice(0, n),
  };
}

function fakeDb(state: State): any {
  return {
    select: () => ({
      from: (table: unknown) => selectChain(rowsFor(table, state)),
    }),
    update: (table: unknown) => ({
      set: (patch: Row) => ({
        where: () => {
          state.updates.push(patch);
          if (getTableName(table as never) === "experiments") {
            state.experiments = state.experiments.map((row) => ({
              ...row,
              ...patch,
            }));
          }

          return Promise.resolve();
        },
      }),
    }),
  };
}

function experimentRow(overrides: Row = {}): Row {
  return {
    id: "exp-1",
    projectId: "project-1",
    taskId: "task-1",
    title: "Compare",
    description: null,
    status: "running",
    baseBranch: "main",
    baseCommit: "a".repeat(40),
    variants: [
      { key: "claude", label: "Claude", config: {} },
      { key: "codex", label: "Codex", config: {} },
    ],
    rubric: { criteria: [] },
    verdict: null,
    createdAt: new Date("2026-07-03T10:00:00.000Z"),
    launchedAt: new Date("2026-07-03T10:01:00.000Z"),
    comparableAt: null,
    concludedAt: null,
    abandonedAt: null,
    ...overrides,
  };
}

function state(overrides: Partial<State> = {}): State {
  return {
    experiments: [experimentRow()],
    experimentRuns: [
      {
        experimentId: "exp-1",
        runId: "run-a",
        variantKey: "claude",
        replicateOrdinal: 1,
        launchReason: "initial",
        diffSnapshot: "diff --git a/a.ts b/a.ts",
        diffSnapshotTruncated: false,
        diffSnapshotBytes: 120,
        diffSnapshotCapturedAt: new Date("2026-07-03T10:04:00.000Z"),
        diffFilesSummary: [
          {
            path: "a.ts",
            status: "modified",
            additions: 1,
            deletions: 0,
            patchHash: "hash-a",
          },
        ],
        materializationDelta: null,
      },
      {
        experimentId: "exp-1",
        runId: "run-b",
        variantKey: "codex",
        replicateOrdinal: 1,
        launchReason: "initial",
        diffSnapshot: null,
        diffSnapshotTruncated: false,
        diffSnapshotBytes: null,
        diffSnapshotCapturedAt: null,
        diffFilesSummary: null,
        materializationDelta: null,
      },
    ],
    runs: [
      {
        id: "run-a",
        status: "Review",
        attemptNumber: 1,
        startedAt: new Date("2026-07-03T10:01:00.000Z"),
        endedAt: new Date("2026-07-03T10:03:00.000Z"),
        worktreePath: "/secret/path",
        acpSessionId: "secret-session",
      },
      {
        id: "run-b",
        status: "Review",
        attemptNumber: 2,
        startedAt: new Date("2026-07-03T10:01:30.000Z"),
        endedAt: null,
      },
    ],
    runSessions: [
      {
        runId: "run-a",
        sessionName: "default",
        runnerId: "runner-1",
        runnerSnapshot: { label: "Claude Sonnet", model: "sonnet" },
        acpSessionId: "secret-session",
      },
    ],
    gateResults: [
      {
        runId: "run-a",
        gateId: "judge",
        kind: "ai_judgment",
        mode: "advisory",
        status: "passed",
        verdict: { verdict: "pass", confidence: 0.83, reasons: ["ok"] },
      },
    ],
    runCostRollups: [
      {
        runId: "run-a",
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 3,
        cacheCreationTokens: 4,
        resumeInputTokens: 5,
        resumeOutputTokens: 6,
        resumeCacheReadTokens: 7,
        resumeCacheCreationTokens: 8,
        byModel: { sonnet: { input: 10 } },
        byRunner: { "claude/sonnet": { output: 20 } },
        sourceEventCount: 2,
      },
    ],
    updates: [],
    ...overrides,
  };
}

describe("experiment comparison DTO", () => {
  it("heals drifted status on read and returns a redacted explicit DTO", async () => {
    const s = state();

    const dto = await getExperimentComparison(
      {
        projectId: "project-1",
        experimentId: "exp-1",
        viewerType: "session",
      },
      fakeDb(s),
    );

    expect(dto.experiment.status).toBe("comparable");
    expect(s.updates).toHaveLength(1);
    expect(s.updates[0]).toMatchObject({ status: "comparable" });
    expect(Object.keys(dto).sort()).toEqual([
      "experiment",
      "generatedAt",
      "runs",
      "variants",
      "verdict",
    ]);
    expect(Object.keys(dto.runs[0]).sort()).toEqual([
      "cost",
      "diff",
      "durationMs",
      "files",
      "gates",
      "launchReason",
      "materializationDelta",
      "queuePosition",
      "replicateOrdinal",
      "runId",
      "runnerLabels",
      "status",
      "statusTone",
      "variantKey",
    ]);
    expect(JSON.stringify(dto)).not.toContain("/secret/path");
    expect(JSON.stringify(dto)).not.toContain("secret-session");
  });

  it("represents absent cost rollups as no-data instead of fabricated zeros", async () => {
    const s = state({ runCostRollups: [] });

    const dto = await getExperimentComparison(
      {
        projectId: "project-1",
        experimentId: "exp-1",
        viewerType: "external",
      },
      fakeDb(s),
    );

    expect(dto.runs.find((run) => run.runId === "run-a")?.cost).toEqual({
      hasData: false,
    });
    expect(dto.runs.find((run) => run.runId === "run-a")?.gates).toEqual([
      {
        gateId: "judge",
        kind: "ai_judgment",
        mode: "advisory",
        status: "passed",
        verdict: { verdict: "pass", confidence: 0.83, reasons: ["ok"] },
      },
    ]);
  });
});
