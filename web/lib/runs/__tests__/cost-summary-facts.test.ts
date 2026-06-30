import type { RunCostSummary } from "@/lib/queries/run";

import { describe, expect, it } from "vitest";

import {
  buildCostSummaryFacts,
  type CostSummaryFactLabels,
} from "@/lib/runs/cost-summary-facts";

const labels: CostSummaryFactLabels = {
  tokenTotal: "Token total",
  inputTokens: "Input tokens",
  outputTokens: "Output tokens",
  cacheReadTokens: "Cache-read tokens",
  cacheCreationTokens: "Cache-creation tokens",
  resumeTax: "Resume tax",
};

describe("buildCostSummaryFacts", () => {
  it("builds the full ordered token breakdown with formatted values", () => {
    const summary: RunCostSummary = {
      inputTokens: 1234,
      outputTokens: 5678,
      cacheReadTokens: 9012,
      cacheCreationTokens: 3456,
      resumeTokens: 7890,
      totalTokens: 19380,
      byModel: {},
    };

    expect(buildCostSummaryFacts(summary, labels, "en-US")).toEqual([
      {
        label: "Token total",
        value: "19,380",
      },
      {
        label: "Input tokens",
        value: "1,234",
      },
      {
        label: "Output tokens",
        value: "5,678",
      },
      {
        label: "Cache-read tokens",
        value: "9,012",
      },
      {
        label: "Cache-creation tokens",
        value: "3,456",
      },
      {
        label: "Resume tax",
        value: "7,890",
      },
    ]);
  });

  it("keeps zero token rows and omits zero resume tax", () => {
    const summary: RunCostSummary = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      resumeTokens: 0,
      totalTokens: 0,
      byModel: {},
    };

    expect(buildCostSummaryFacts(summary, labels, "en-US")).toEqual([
      {
        label: "Token total",
        value: "0",
      },
      {
        label: "Input tokens",
        value: "0",
      },
      {
        label: "Output tokens",
        value: "0",
      },
      {
        label: "Cache-read tokens",
        value: "0",
      },
      {
        label: "Cache-creation tokens",
        value: "0",
      },
    ]);
  });

  it("formats token values with the selected locale", () => {
    const summary: RunCostSummary = {
      inputTokens: 1_521_449,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      resumeTokens: 0,
      totalTokens: 1_521_449,
      byModel: {},
    };
    const facts = buildCostSummaryFacts(summary, labels, "ru-RU");

    expect(facts[0]?.value).toMatch(/1[\u00A0\u202F ]521[\u00A0\u202F ]449/);
    expect(facts[0]?.value).not.toBe("1521449");
  });
});
