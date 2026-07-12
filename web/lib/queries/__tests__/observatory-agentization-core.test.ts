import { describe, expect, it } from "vitest";

import {
  rollupAgentization,
  rollupObservatoryFunnel,
} from "@/lib/queries/observatory-agentization-core";

const at = (value: string): Date => new Date(value);

describe("agentization rollup", () => {
  it("uses the final rebase head once for totals but distributes trailered commits across their exact daily trend buckets", () => {
    const result = rollupAgentization({
      runKind: "scratch",
      runs: [
        {
          id: "scratch-root",
          runKind: "scratch",
          promotedHeadSha: "rebase-second",
          mergeCommitSha: null,
          diffStat: { files: 2, additions: 10, deletions: 2 },
          prNumber: null,
          active: false,
        },
      ],
      buckets: [
        {
          bucketStart: at("2026-07-01T00:00:00.000Z"),
          bucketEnd: at("2026-07-02T00:00:00.000Z"),
          commits: 3,
          mergePrUnits: 0,
          additions: 20,
          deletions: 5,
          deliveryRefs: [
            {
              sha: "rebase-first",
              parentCount: 1,
              runIds: ["scratch-root"],
              diffStat: { files: 1, additions: 4, deletions: 1 },
            },
            {
              sha: "human-first",
              parentCount: 1,
              runIds: [],
              diffStat: { files: 1, additions: 16, deletions: 4 },
            },
            { sha: "human-second", parentCount: 1, runIds: [] },
          ],
          providerComplete: true,
          fetchedAt: at("2026-07-02T01:00:00.000Z"),
        },
        {
          bucketStart: at("2026-07-02T00:00:00.000Z"),
          bucketEnd: at("2026-07-03T00:00:00.000Z"),
          commits: 4,
          mergePrUnits: 3,
          additions: 30,
          deletions: 5,
          deliveryRefs: [
            {
              sha: "rebase-second",
              parentCount: 1,
              runIds: ["scratch-root"],
              diffStat: { files: 1, additions: 6, deletions: 1 },
            },
            { sha: "human-merge", parentCount: 2, runIds: [] },
            { sha: "human-pr", parentCount: 1, runIds: [], prNumber: 99 },
            { sha: "human-merge-two", parentCount: 2, runIds: [] },
          ],
          providerComplete: true,
          fetchedAt: at("2026-07-03T01:00:00.000Z"),
        },
      ],
    });

    expect(result.lines).toMatchObject({
      numerator: 12,
      denominator: 60,
      value: 0.2,
    });
    expect(result.deliveryUnits).toMatchObject({
      numerator: 0,
      denominator: 3,
      value: 0,
    });
    expect(result.buckets).toEqual([
      expect.objectContaining({
        kind: "scratch",
        lines: 12,
        runs: 1,
        deliveryUnits: 0,
      }),
    ]);
    expect(result.trend).toEqual([
      expect.objectContaining({ aiAdditions: 4, aiDeletions: 1 }),
      expect.objectContaining({ aiAdditions: 6, aiDeletions: 1 }),
    ]);
  });

  it("counts only canonical merge or provider PR refs as delivery units", () => {
    const result = rollupAgentization({
      runKind: "all",
      runs: [
        {
          id: "merge-run",
          runKind: "flow",
          promotedHeadSha: "merge-sha",
          mergeCommitSha: "merge-sha",
          diffStat: { files: 1, additions: 2, deletions: 1 },
          prNumber: null,
          active: false,
        },
        {
          id: "pr-run",
          runKind: "agent",
          promotedHeadSha: "pr-sha",
          mergeCommitSha: "pr-sha",
          diffStat: { files: 1, additions: 3, deletions: 0 },
          prNumber: 42,
          active: false,
        },
      ],
      buckets: [
        {
          bucketStart: at("2026-07-03T00:00:00.000Z"),
          bucketEnd: at("2026-07-04T00:00:00.000Z"),
          commits: 4,
          mergePrUnits: 3,
          additions: 10,
          deletions: 2,
          deliveryRefs: [
            { sha: "merge-sha", parentCount: 2, runIds: ["merge-run"] },
            { sha: "pr-sha", parentCount: 1, runIds: [], prNumber: 42 },
            { sha: "human-sha", parentCount: 1, runIds: [] },
            { sha: "human-merge", parentCount: 2, runIds: [] },
          ],
          providerComplete: true,
          fetchedAt: at("2026-07-04T01:00:00.000Z"),
        },
      ],
    });

    expect(result.deliveryUnits).toMatchObject({
      numerator: 2,
      denominator: 3,
      value: 2 / 3,
    });
  });

  it("renders ambiguous equal-strength attribution insufficient instead of guessing", () => {
    const result = rollupAgentization({
      runKind: "flow",
      runs: [
        {
          id: "ambiguous-run",
          runKind: "flow",
          promotedHeadSha: null,
          mergeCommitSha: null,
          diffStat: { files: 1, additions: 5, deletions: 0 },
          prNumber: null,
          active: false,
        },
      ],
      buckets: [
        {
          bucketStart: at("2026-07-04T00:00:00.000Z"),
          bucketEnd: at("2026-07-05T00:00:00.000Z"),
          commits: 3,
          mergePrUnits: 1,
          additions: 20,
          deletions: 0,
          deliveryRefs: [
            { sha: "first", parentCount: 1, runIds: ["ambiguous-run"] },
            { sha: "second", parentCount: 1, runIds: ["ambiguous-run"] },
            { sha: "human", parentCount: 2, runIds: [] },
          ],
          providerComplete: true,
          fetchedAt: at("2026-07-05T01:00:00.000Z"),
        },
      ],
    });

    expect(result.availability).toBe("insufficient");
    expect(result.lines.value).toBeNull();
    expect(result.deliveryUnits.value).toBeNull();
  });

  it("refuses to attribute one target delivery to multiple delivery roots", () => {
    const result = rollupAgentization({
      runKind: "all",
      runs: [
        {
          id: "flow-root",
          runKind: "flow",
          promotedHeadSha: "shared-delivery",
          mergeCommitSha: "shared-delivery",
          diffStat: { files: 1, additions: 5, deletions: 0 },
          prNumber: null,
          active: false,
        },
        {
          id: "scratch-root",
          runKind: "scratch",
          promotedHeadSha: "shared-delivery",
          mergeCommitSha: "shared-delivery",
          diffStat: { files: 1, additions: 5, deletions: 0 },
          prNumber: null,
          active: false,
        },
      ],
      buckets: [
        {
          bucketStart: at("2026-07-05T00:00:00.000Z"),
          bucketEnd: at("2026-07-06T00:00:00.000Z"),
          commits: 3,
          mergePrUnits: 1,
          additions: 15,
          deletions: 0,
          deliveryRefs: [
            {
              sha: "shared-delivery",
              parentCount: 2,
              runIds: ["flow-root", "scratch-root"],
              diffStat: { files: 1, additions: 5, deletions: 0 },
            },
            { sha: "human-first", parentCount: 1, runIds: [] },
            { sha: "human-second", parentCount: 1, runIds: [] },
          ],
          providerComplete: true,
          fetchedAt: at("2026-07-06T01:00:00.000Z"),
        },
      ],
    });

    expect(result.availability).toBe("insufficient");
    expect(result.lines).toMatchObject({ numerator: 0, value: null });
    expect(result.deliveryUnits).toMatchObject({ numerator: 0, value: null });
    expect(result.buckets).toEqual([
      expect.objectContaining({ kind: "flow", lines: 0, runs: 0 }),
      expect.objectContaining({ kind: "scratch", lines: 0, runs: 0 }),
      expect.objectContaining({ kind: "agent", lines: 0, runs: 0 }),
    ]);
  });

  it("returns an insufficient result when cache evidence is missing or below honest N", () => {
    const result = rollupAgentization({
      runKind: "all",
      runs: [],
      buckets: [],
    });

    expect(result.availability).toBe("insufficient");
    expect(result.lines.value).toBeNull();
    expect(result.deliveryUnits.value).toBeNull();
  });
});

describe("Observatory funnel", () => {
  it("uses human-takeover precedence and preserves unrecorded launch dimensions", () => {
    const result = rollupObservatoryFunnel({
      runKind: "all",
      runs: [
        {
          id: "takeover",
          runKind: "flow",
          startedAt: at("2026-07-01T00:00:00.000Z"),
          status: "Done",
          launchMode: null,
          triggerSource: null,
          promotionLane: "auto",
          platformPromoted: true,
          hasHitl: true,
          hasHumanReview: true,
          hasHumanTakeover: true,
        },
        {
          id: "correction",
          runKind: "scratch",
          startedAt: at("2026-07-01T00:00:00.000Z"),
          status: "Failed",
          launchMode: "manual",
          triggerSource: "manual",
          promotionLane: null,
          platformPromoted: false,
          hasHitl: true,
          hasHumanReview: false,
          hasHumanTakeover: false,
        },
      ],
    });

    expect(result.humanTouch).toEqual([
      { key: "pure_autonomous", count: 0 },
      { key: "ai_with_correction", count: 1 },
      { key: "human_takeover", count: 1 },
    ]);
    expect(result.launchModes).toContainEqual({ key: "unrecorded", count: 1 });
    expect(result.throughput).toContainEqual({
      key: "platform_promoted",
      count: 1,
    });
    expect(result.throughput).toContainEqual({ key: "failed", count: 1 });
  });
});
