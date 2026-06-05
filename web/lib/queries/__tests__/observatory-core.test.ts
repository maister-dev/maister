import { describe, expect, it } from "vitest";

import {
  groupArtifactContributions,
  latestAttemptsByNode,
  rankSignalClusters,
  rollupAutonomyMetrics,
  rollupCorrectionMetrics,
} from "@/lib/queries/observatory-core";

const NOW = new Date("2026-06-05T12:00:00.000Z");

describe("observatory core formulas", () => {
  it("computes correction pressure from rework and node retries", () => {
    const result = rollupCorrectionMetrics({
      runs: [{ id: "run-1", active: false }],
      nodeAttempts: [
        {
          id: "impl-1",
          runId: "run-1",
          nodeId: "implement",
          nodeType: "ai_coding",
          attempt: 1,
          status: "Succeeded",
        },
        {
          id: "impl-2",
          runId: "run-1",
          nodeId: "implement",
          nodeType: "ai_coding",
          attempt: 2,
          status: "Succeeded",
        },
        {
          id: "review-1",
          runId: "run-1",
          nodeId: "review",
          nodeType: "human",
          attempt: 1,
          status: "Reworked",
        },
      ],
    });

    expect(result.runCount).toBe(1);
    expect(result.retryCount).toBe(1);
    expect(result.reworkCount).toBe(1);
    expect(result.correctionRate).toBe(2);
    expect(result.displayKind).toBe("pressure-ratio");
  });

  it("excludes legacy runs without node attempts from correction denominator", () => {
    const result = rollupCorrectionMetrics({
      runs: [
        { id: "legacy", active: false },
        { id: "current", active: false },
      ],
      nodeAttempts: [
        {
          id: "current-impl",
          runId: "current",
          nodeId: "implement",
          nodeType: "ai_coding",
          attempt: 1,
          status: "Succeeded",
        },
      ],
    });

    expect(result.runCount).toBe(1);
    expect(result.correctionRate).toBe(0);
  });

  it("marks active correction metrics volatile", () => {
    const result = rollupCorrectionMetrics({
      runs: [{ id: "run-active", active: true }],
      nodeAttempts: [
        {
          id: "active-impl",
          runId: "run-active",
          nodeId: "implement",
          nodeType: "ai_coding",
          attempt: 1,
          status: "Running",
        },
      ],
    });

    expect(result.volatile).toBe(true);
  });

  it("computes latest attempts by run-scoped node", () => {
    const latest = latestAttemptsByNode([
      {
        id: "run-a-1",
        runId: "run-a",
        nodeId: "shared",
        nodeType: "check",
        attempt: 1,
        status: "Succeeded",
      },
      {
        id: "run-a-2",
        runId: "run-a",
        nodeId: "shared",
        nodeType: "check",
        attempt: 2,
        status: "Failed",
      },
      {
        id: "run-b-1",
        runId: "run-b",
        nodeId: "shared",
        nodeType: "check",
        attempt: 1,
        status: "Succeeded",
      },
    ]);

    expect(latest.get("run-a::shared")?.id).toBe("run-a-2");
    expect(latest.get("run-b::shared")?.id).toBe("run-b-1");
  });

  it("groups artifacts by definition id and falls back to kind", () => {
    const grouped = groupArtifactContributions([
      {
        id: "artifact-1",
        runId: "run-1",
        nodeAttemptId: "attempt-1",
        artifactDefId: "impl-diff",
        kind: "diff",
      },
      {
        id: "artifact-2",
        runId: "run-1",
        nodeAttemptId: "attempt-1",
        artifactDefId: null,
        kind: "log",
      },
    ]);

    expect(grouped.map((row) => row.key)).toEqual(["def:impl-diff", "kind:log"]);
  });

  it("merges overlapping HITL wait intervals for Autonomy Score", () => {
    const result = rollupAutonomyMetrics({
      now: NOW,
      runs: [
        {
          id: "run-1",
          startedAt: new Date("2026-06-05T10:00:00.000Z"),
          endedAt: new Date("2026-06-05T11:00:00.000Z"),
          active: false,
        },
      ],
      hitlRequests: [
        {
          id: "hitl-1",
          runId: "run-1",
          createdAt: new Date("2026-06-05T10:10:00.000Z"),
          respondedAt: new Date("2026-06-05T10:30:00.000Z"),
        },
        {
          id: "hitl-2",
          runId: "run-1",
          createdAt: new Date("2026-06-05T10:20:00.000Z"),
          respondedAt: new Date("2026-06-05T10:40:00.000Z"),
        },
      ],
    });

    expect(result.totalSeconds).toBe(3600);
    expect(result.waitSeconds).toBe(1800);
    expect(result.autonomyScore).toBe(0.5);
    expect(result.reviewDwellExcluded).toBe(true);
  });

  it("uses explicit now for active runs and open HITL waits", () => {
    const result = rollupAutonomyMetrics({
      now: NOW,
      runs: [
        {
          id: "run-open",
          startedAt: new Date("2026-06-05T11:00:00.000Z"),
          endedAt: null,
          active: true,
        },
      ],
      hitlRequests: [
        {
          id: "hitl-open",
          runId: "run-open",
          createdAt: new Date("2026-06-05T11:30:00.000Z"),
          respondedAt: null,
        },
      ],
    });

    expect(result.totalSeconds).toBe(3600);
    expect(result.waitSeconds).toBe(1800);
    expect(result.openWaitCount).toBe(1);
    expect(result.autonomyScore).toBe(0.5);
    expect(result.volatile).toBe(true);
  });

  it("excludes review dwell without HITL rows", () => {
    const result = rollupAutonomyMetrics({
      now: NOW,
      runs: [
        {
          id: "review-run",
          startedAt: new Date("2026-06-05T10:00:00.000Z"),
          endedAt: new Date("2026-06-05T11:00:00.000Z"),
          active: false,
        },
      ],
      hitlRequests: [],
    });

    expect(result.waitSeconds).toBe(0);
    expect(result.autonomyScore).toBe(1);
    expect(result.reviewDwellExcluded).toBe(true);
  });

  it("keeps child run counts distinct from additive correction events", () => {
    const runs = [
      { id: "run-1", active: false },
      { id: "run-2", active: false },
    ];
    const attempts = [
      {
        id: "run-1-impl",
        runId: "run-1",
        nodeId: "implement",
        nodeType: "ai_coding",
        attempt: 1,
        status: "Succeeded",
      },
      {
        id: "run-1-check-1",
        runId: "run-1",
        nodeId: "checks",
        nodeType: "check",
        attempt: 1,
        status: "Failed",
      },
      {
        id: "run-1-check-2",
        runId: "run-1",
        nodeId: "checks",
        nodeType: "check",
        attempt: 2,
        status: "Succeeded",
      },
      {
        id: "run-2-check",
        runId: "run-2",
        nodeId: "checks",
        nodeType: "check",
        attempt: 1,
        status: "Reworked",
      },
    ] as const;

    const total = rollupCorrectionMetrics({ runs, nodeAttempts: attempts });
    const implement = rollupCorrectionMetrics({
      runs,
      nodeAttempts: attempts.filter((attempt) => attempt.nodeId === "implement"),
    });
    const checks = rollupCorrectionMetrics({
      runs,
      nodeAttempts: attempts.filter((attempt) => attempt.nodeId === "checks"),
    });

    expect(total.runCount).toBe(2);
    expect(implement.runCount + checks.runCount).toBe(3);
    expect(total.retryCount).toBe(1);
    expect(total.reworkCount).toBe(1);
  });

  it("ranks signal clusters by repeatability priority", () => {
    const ranked = rankSignalClusters([
      {
        key: "retry:lint",
        source: "retry",
        label: "lint retries",
        occurrenceCount: 3,
        runIds: ["run-2", "run-1"],
        priority: 6,
      },
      {
        key: "gate:blocked",
        source: "gate",
        label: "blocked gates",
        occurrenceCount: 2,
        runIds: ["run-3"],
        priority: 8,
      },
    ]);

    expect(ranked.map((cluster) => cluster.key)).toEqual([
      "gate:blocked",
      "retry:lint",
    ]);
    expect(ranked[1]?.runIds).toEqual(["run-1", "run-2"]);
  });
});
