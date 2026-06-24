import { describe, expect, it } from "vitest";

import {
  aggregateCostJsonlLines,
  resolveRunCostSourceSlug,
} from "@/lib/runs/cost-rollups";

describe("aggregateCostJsonlLines", () => {
  it("rolls tokens up by run, model, and node attempt", () => {
    const result = aggregateCostJsonlLines(
      [
        JSON.stringify({
          model: "claude-sonnet-4-6",
          nodeAttemptId: "attempt-1",
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 2,
        }),
        JSON.stringify({
          model: "claude-sonnet-4-6",
          nodeAttemptId: "attempt-1",
          input_tokens: 7,
          output_tokens: 4,
          resumed: true,
        }),
        JSON.stringify({
          model: "codex-gpt-5",
          nodeAttemptId: "attempt-2",
          input_tokens: 11,
          cache_creation_input_tokens: 6,
          resumed: true,
        }),
      ],
      new Map([
        ["attempt-1", "implement"],
        ["attempt-2", "review"],
      ]),
    );

    expect(result.run).toMatchObject({
      inputTokens: 28,
      outputTokens: 9,
      cacheReadTokens: 3,
      cacheCreationTokens: 8,
      resumeInputTokens: 18,
      resumeOutputTokens: 4,
      resumeCacheReadTokens: 0,
      resumeCacheCreationTokens: 6,
      sourceEventCount: 3,
    });
    expect(result.run.byModel).toEqual({
      "claude-sonnet-4-6": {
        inputTokens: 17,
        outputTokens: 9,
        cacheReadTokens: 3,
        cacheCreationTokens: 2,
      },
      "codex-gpt-5": {
        inputTokens: 11,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 6,
      },
    });
    expect(result.nodeAttempts).toHaveLength(2);
    expect(result.nodeAttempts[0]).toMatchObject({
      nodeAttemptId: "attempt-1",
      nodeId: "implement",
      model: "claude-sonnet-4-6",
      inputTokens: 17,
      outputTokens: 9,
      cacheReadTokens: 3,
      cacheCreationTokens: 2,
      resumeInputTokens: 7,
      resumeOutputTokens: 4,
      sourceEventCount: 2,
    });
  });

  it("keeps run totals when a cost event cannot be mapped to a node attempt", () => {
    const result = aggregateCostJsonlLines(
      [
        "{not-json",
        JSON.stringify({
          model: "",
          nodeAttemptId: "missing",
          input_tokens: 4,
        }),
        JSON.stringify({
          output_tokens: 9,
        }),
      ],
      new Map(),
    );

    expect(result.run).toMatchObject({
      inputTokens: 4,
      outputTokens: 9,
      sourceEventCount: 2,
    });
    expect(result.run.byModel).toEqual({
      unknown: {
        inputTokens: 4,
        outputTokens: 9,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    });
    expect(result.nodeAttempts).toEqual([]);
    expect(result.malformedLineCount).toBe(1);
    expect(result.unattributedNodeEventCount).toBe(2);
  });
});

describe("resolveRunCostSourceSlug", () => {
  it("uses the project slug for project-owned runs", () => {
    expect(
      resolveRunCostSourceSlug({
        id: "run-1",
        projectSlug: "demo-project",
        localPackageSlug: "local-package",
      }),
    ).toBe("demo-project");
  });

  it("uses the local package slug for project-less assistant scratch runs", () => {
    expect(
      resolveRunCostSourceSlug({
        id: "run-1",
        projectSlug: null,
        localPackageSlug: "local-package",
      }),
    ).toBe("local-package");
  });

  it("fails when neither owner slug is available", () => {
    expect(() =>
      resolveRunCostSourceSlug({
        id: "run-1",
        projectSlug: null,
        localPackageSlug: null,
      }),
    ).toThrow("cost rollup owner slug missing for run: run-1");
  });
});
