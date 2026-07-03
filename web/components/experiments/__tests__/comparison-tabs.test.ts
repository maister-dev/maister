import type { ExperimentComparisonDTO } from "@/lib/experiments/comparison";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CostTab,
  DiffOfDiffsTab,
  DiffTab,
  FilesTab,
  GatesTab,
  type ComparisonTabLabels,
} from "@/components/experiments/comparison-tabs";

const labels: ComparisonTabLabels = {
  pair: "Pair",
  snapshot: "Stored snapshot",
  refsGone: "Refs gone — serving stored snapshot",
  truncated: "Truncated",
  missingSnapshot: "No diff snapshot",
  identical: "No differences",
  partial: "Partial comparison",
  filesAll: "All",
  filesDifferent: "Different",
  filesSame: "Same",
  contentUnavailable: "Content unavailable",
  noGates: "No gates",
  confidence: "Confidence",
  noCost: "No cost data",
  tokensCaption: "Tokens, not dollars",
  duration: "Duration",
  inputTokens: "Input",
  outputTokens: "Output",
  cacheReadTokens: "Cache read",
  cacheCreationTokens: "Cache create",
  resumeTokens: "Resume",
  byModel: "By model",
  byRunner: "By runner",
};

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
      { key: "a", label: "Control", config: {} },
      { key: "b", label: "Candidate", config: {} },
      { key: "c", label: "Third", config: {} },
    ],
    rubric: { criteria: [] },
    verdict: null,
    createdAt: "2026-07-03T08:00:00.000Z",
    launchedAt: null,
    comparableAt: null,
    concludedAt: null,
    abandonedAt: null,
  },
  variants: [
    { key: "a", label: "Control", config: {} },
    { key: "b", label: "Candidate", config: {} },
    { key: "c", label: "Third", config: {} },
  ],
  runs: [
    {
      runId: "run-a",
      variantKey: "a",
      replicateOrdinal: 1,
      launchReason: "initial",
      status: "Review",
      statusTone: "review",
      durationMs: 45_000,
      queuePosition: null,
      runnerLabels: ["claude"],
      gates: [
        {
          gateId: "judge",
          kind: "ai_judgment",
          mode: "advisory",
          status: "passed",
          verdict: { verdict: "pass", confidence: 0.82 },
        },
      ],
      cost: {
        hasData: true,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 7,
        cacheCreationTokens: 9,
        resumeInputTokens: 3,
        resumeOutputTokens: 2,
        resumeCacheReadTokens: 1,
        resumeCacheCreationTokens: 4,
        byModel: { "claude-sonnet": { input: 100, output: 50 } },
        byRunner: { claude: { input: 100, output: 50 } },
        sourceEventCount: 5,
      },
      diff: {
        snapshot: "diff --git a/src/a.ts b/src/a.ts\n+one",
        truncated: false,
        bytes: 120,
        capturedAt: "2026-07-03T09:00:00.000Z",
      },
      files: [
        {
          path: "src/a.ts",
          status: "M",
          additions: 10,
          deletions: 2,
          patchHash: "hash-a",
        },
      ],
      materializationDelta: null,
    },
    {
      runId: "run-b",
      variantKey: "b",
      replicateOrdinal: 1,
      launchReason: "initial",
      status: "Review",
      statusTone: "review",
      durationMs: null,
      queuePosition: null,
      runnerLabels: ["codex"],
      gates: [],
      cost: { hasData: false },
      diff: {
        snapshot: "diff --git a/src/a.ts b/src/a.ts\n+two",
        truncated: true,
        bytes: 600_000,
        capturedAt: "2026-07-03T09:02:00.000Z",
      },
      files: [
        {
          path: "src/a.ts",
          status: "M",
          additions: 12,
          deletions: 2,
          patchHash: "hash-b",
        },
        {
          path: "src/b.ts",
          status: "A",
          additions: 3,
          deletions: 0,
          patchHash: "hash-new",
        },
      ],
      materializationDelta: null,
    },
    {
      runId: "run-c",
      variantKey: "c",
      replicateOrdinal: 1,
      launchReason: "initial",
      status: "Review",
      statusTone: "review",
      durationMs: null,
      queuePosition: null,
      runnerLabels: ["gemini"],
      gates: [],
      cost: { hasData: false },
      diff: {
        snapshot: null,
        truncated: false,
        bytes: null,
        capturedAt: null,
      },
      files: [],
      materializationDelta: null,
    },
  ],
  verdict: null,
  generatedAt: "2026-07-03T09:03:00.000Z",
};

describe("comparison tabs", () => {
  it("renders diff pair selector for three variants plus snapshot and truncation states", () => {
    const html = renderToStaticMarkup(
      createElement(DiffTab, { comparison, labels }),
    );

    expect(html).toContain("Pair");
    expect(html).toContain("Control ↔ Candidate");
    expect(html).toContain("Control ↔ Third");
    expect(html).toContain("Stored snapshot");
    expect(html).toContain("Truncated");
    expect(html).toContain("No diff snapshot");
  });

  it("renders diff-of-diffs and files matrix classifications", () => {
    const diffs = renderToStaticMarkup(
      createElement(DiffOfDiffsTab, { comparison, labels }),
    );
    const files = renderToStaticMarkup(
      createElement(FilesTab, { comparison, labels }),
    );

    expect(diffs).toContain("Partial comparison");
    expect(diffs).toContain("src/a.ts");
    expect(files).toContain("Different");
    expect(files).toContain("src/b.ts");
    expect(files).toContain("Content unavailable");
  });

  it("renders gates and cost without fabricating zeros for missing rollups", () => {
    const gates = renderToStaticMarkup(
      createElement(GatesTab, { comparison, labels }),
    );
    const cost = renderToStaticMarkup(
      createElement(CostTab, { comparison, labels }),
    );

    expect(gates).toContain("ai_judgment");
    expect(gates).toContain("Confidence");
    expect(gates).toContain("0.82");
    expect(cost).toContain("Tokens, not dollars");
    expect(cost).toContain("Input");
    expect(cost).toContain("100");
    expect(cost).toContain("No cost data");
  });
});
