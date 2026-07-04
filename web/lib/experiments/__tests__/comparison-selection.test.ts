import type {
  ExperimentComparisonDTO,
  ExperimentComparisonRunDTO,
} from "@/lib/experiments/comparison";

import { describe, expect, it } from "vitest";

import { selectComparisonDiffRunsForPreparation } from "@/lib/experiments/comparison-selection";

function run(
  runId: string,
  variantKey: string,
  replicateOrdinal: number,
): ExperimentComparisonRunDTO {
  return {
    runId,
    variantKey,
    replicateOrdinal,
    launchReason: "initial",
    status: "Review",
    statusTone: "review",
    durationMs: null,
    queuePosition: null,
    runnerLabels: [],
    gates: [],
    cost: { hasData: false },
    diff: {
      snapshot: `diff --git a/${runId}.ts b/${runId}.ts`,
      truncated: false,
      bytes: 32,
      capturedAt: "2026-07-04T00:00:00.000Z",
    },
    files: [],
    materializationDelta: null,
  };
}

const comparison: ExperimentComparisonDTO = {
  experiment: {
    id: "exp-1",
    projectId: "project-1",
    taskId: "task-1",
    title: "Compare",
    description: null,
    status: "comparable",
    baseBranch: "main",
    baseCommit: "abcdef1234567890",
    variants: [
      { key: "a", label: "A", config: {} },
      { key: "b", label: "B", config: {} },
      { key: "c", label: "C", config: {} },
    ],
    rubric: { criteria: [] },
    verdict: null,
    createdAt: "2026-07-04T00:00:00.000Z",
    launchedAt: null,
    comparableAt: null,
    concludedAt: null,
    abandonedAt: null,
  },
  variants: [
    { key: "a", label: "A", config: {} },
    { key: "b", label: "B", config: {} },
    { key: "c", label: "C", config: {} },
  ],
  runs: [
    run("run-a-1", "a", 1),
    run("run-b-1", "b", 1),
    run("run-c-1", "c", 1),
    run("run-a-2", "a", 2),
    run("run-b-2", "b", 2),
  ],
  verdict: null,
  generatedAt: "2026-07-04T00:00:00.000Z",
};

describe("comparison diff run selection", () => {
  it("returns only the selected pair for the selected replicate", () => {
    const selected = selectComparisonDiffRunsForPreparation(comparison, {
      pairKey: "b:c",
      replicateOrdinal: 1,
    });

    expect(selected.map((item) => item.runId)).toEqual(["run-b-1", "run-c-1"]);
  });

  it("defaults to the latest replicate's first comparable pair", () => {
    const selected = selectComparisonDiffRunsForPreparation(comparison, {});

    expect(selected.map((item) => item.runId)).toEqual(["run-a-2", "run-b-2"]);
  });
});
