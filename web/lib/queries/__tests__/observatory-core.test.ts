import { describe, expect, it } from "vitest";

import {
  MIN_GROUP_EXECUTIONS,
  buildCoverageMap,
  declaredGatesFromManifests,
  detectNeverFired,
  groupArtifactContributions,
  rollupAutonomyMetrics,
  rollupCapabilityEffectiveness,
  rollupControlEffectiveness,
  rollupCorrectionMetrics,
  rollupGateFiringStats,
  type FlowManifestInput,
  type HarnessGateInput,
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

  it("counts human review re-entry as a retry under the frozen pressure ratio", () => {
    const result = rollupCorrectionMetrics({
      runs: [{ id: "run-1", active: false }],
      nodeAttempts: [
        {
          id: "review-1",
          runId: "run-1",
          nodeId: "review",
          nodeType: "human",
          attempt: 1,
          status: "Reworked",
        },
        {
          id: "review-2",
          runId: "run-1",
          nodeId: "review",
          nodeType: "human",
          attempt: 2,
          status: "Succeeded",
        },
      ],
    });

    expect(result.reworkCount).toBe(1);
    expect(result.retryCount).toBe(1);
    expect(result.correctionRate).toBe(2);
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

    expect(grouped.map((row) => row.key)).toEqual([
      "def:impl-diff",
      "kind:log",
    ]);
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
      nodeAttempts: attempts.filter(
        (attempt) => attempt.nodeId === "implement",
      ),
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
});

function gateRow(over: Partial<HarnessGateInput> = {}): HarnessGateInput {
  return {
    projectId: "project-1",
    flowId: "flow-1",
    flowRefId: "aif",
    nodeId: "checks",
    nodeAttemptId: "attempt-1",
    gateId: "unit",
    kind: "command_check",
    mode: "blocking",
    status: "passed",
    ...over,
  };
}

function manifest(over: Partial<FlowManifestInput> = {}): FlowManifestInput {
  return {
    flowId: "flow-1",
    flowRefId: "aif",
    revisionId: "rev-1",
    nodes: [],
    ...over,
  };
}

describe("harness adequacy rollups (ADR-072)", () => {
  it("exports the honest-N display threshold", () => {
    expect(MIN_GROUP_EXECUTIONS).toBe(3);
  });

  it("returns empty rollups for an empty window", () => {
    expect(rollupGateFiringStats([])).toEqual({ groups: [], byKind: [] });
    expect(
      detectNeverFired({
        declaredGates: [],
        firingStats: [],
        minExecutions: 10,
      }),
    ).toEqual([]);
    expect(rollupControlEffectiveness({ gates: [], attempts: [] })).toEqual([]);
    expect(rollupCapabilityEffectiveness({ runs: [], attempts: [] })).toEqual(
      [],
    );
    expect(
      buildCoverageMap({ manifests: [], nodeAttemptCounts: new Map() }),
    ).toEqual([]);
  });

  it("counts only terminal statuses into executions and keeps stale out of fail-rate", () => {
    const { groups, byKind } = rollupGateFiringStats([
      gateRow({ status: "passed" }),
      gateRow({ status: "passed" }),
      gateRow({ status: "failed" }),
      gateRow({ status: "stale" }),
      gateRow({ status: "skipped" }),
      gateRow({ status: "overridden" }),
      gateRow({ status: "pending" }),
      gateRow({ status: "running" }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      projectId: "project-1",
      flowId: "flow-1",
      flowRefId: "aif",
      nodeId: "checks",
      gateId: "unit",
      kind: "command_check",
      mode: "blocking",
      executions: 6,
      passed: 2,
      failed: 1,
      stale: 1,
      skipped: 1,
      overridden: 1,
      failRate: 1 / 6,
    });
    expect(byKind).toEqual([
      {
        kind: "command_check",
        executions: 6,
        passed: 2,
        failed: 1,
        stale: 1,
        skipped: 1,
        overridden: 1,
        failRate: 1 / 6,
      },
    ]);
  });

  it("reports a null fail-rate for a group with no terminal executions", () => {
    const { groups } = rollupGateFiringStats([
      gateRow({ status: "pending" }),
      gateRow({ status: "running" }),
    ]);

    expect(groups[0]?.executions).toBe(0);
    expect(groups[0]?.failRate).toBeNull();
  });

  it("flags never-fired gates and spares fired-once, under-threshold, and undeclared gates", () => {
    const silent = Array.from({ length: 10 }, (_, index) =>
      gateRow({
        gateId: "lint",
        nodeAttemptId: `lint-${index}`,
        status: "passed",
      }),
    );
    const firedOnce = [
      ...Array.from({ length: 9 }, (_, index) =>
        gateRow({ nodeAttemptId: `unit-${index}`, status: "passed" }),
      ),
      gateRow({ nodeAttemptId: "unit-9", status: "failed" }),
    ];
    const staleOnly = Array.from({ length: 10 }, (_, index) =>
      gateRow({
        gateId: "fmt",
        nodeAttemptId: `fmt-${index}`,
        status: "stale",
      }),
    );
    const { groups } = rollupGateFiringStats([
      ...silent,
      ...firedOnce,
      ...staleOnly,
    ]);
    const declaredGates = [
      { ...gateRow({ gateId: "lint" }), gateId: "lint" },
      { ...gateRow(), gateId: "unit" },
      { ...gateRow({ gateId: "fmt" }), gateId: "fmt" },
      // declared but never executed in the window -> NOT flagged
      { ...gateRow({ gateId: "smoke" }), gateId: "smoke" },
    ].map(({ flowId, flowRefId, nodeId, gateId, kind, mode }) => ({
      flowId,
      flowRefId,
      nodeId,
      gateId,
      kind,
      mode,
    }));

    const flagged = detectNeverFired({
      declaredGates,
      firingStats: groups,
      minExecutions: 10,
    });

    expect(flagged).toEqual([
      {
        flowId: "flow-1",
        flowRefId: "aif",
        nodeId: "checks",
        gateId: "lint",
        kind: "command_check",
        executions: 10,
      },
    ]);

    const underThreshold = detectNeverFired({
      declaredGates,
      firingStats: groups,
      minExecutions: 11,
    });

    expect(underThreshold).toEqual([]);
  });

  it("does not flag a gate whose firings happened on an undeclared flow", () => {
    const { groups } = rollupGateFiringStats(
      Array.from({ length: 10 }, (_, index) =>
        gateRow({
          flowId: "flow-2",
          flowRefId: "other",
          nodeAttemptId: `other-${index}`,
        }),
      ),
    );

    expect(
      detectNeverFired({
        declaredGates: [
          {
            flowId: "flow-1",
            flowRefId: "aif",
            nodeId: "checks",
            gateId: "unit",
            kind: "command_check",
            mode: "blocking",
          },
        ],
        firingStats: groups,
        minExecutions: 10,
      }),
    ).toEqual([]);
  });

  it("computes gate rework-follow rates and lift from attempt-keyed maps", () => {
    const attempts = [
      {
        id: "r1-checks-1",
        runId: "run-1",
        nodeId: "checks",
        nodeType: "check",
        attempt: 1,
        status: "Failed",
      },
      {
        id: "r1-checks-2",
        runId: "run-1",
        nodeId: "checks",
        nodeType: "check",
        attempt: 2,
        status: "Succeeded",
      },
      {
        id: "r2-checks-1",
        runId: "run-2",
        nodeId: "checks",
        nodeType: "check",
        attempt: 1,
        status: "Succeeded",
      },
      {
        id: "r3-review-1",
        runId: "run-3",
        nodeId: "review",
        nodeType: "human",
        attempt: 1,
        status: "Reworked",
      },
    ] as const;
    const gates = [
      gateRow({ nodeAttemptId: "r1-checks-1", status: "failed" }),
      gateRow({ nodeAttemptId: "r2-checks-1", status: "passed" }),
      gateRow({
        nodeAttemptId: "r3-review-1",
        nodeId: "review",
        gateId: "review-evidence",
        kind: "artifact_required",
        status: "passed",
      }),
    ];

    const result = rollupControlEffectiveness({ gates, attempts });

    expect(result).toHaveLength(2);

    const unit = result.find((row) => row.gateId === "unit");

    expect(unit).toMatchObject({
      flowId: "flow-1",
      nodeId: "checks",
      failedAttempts: 1,
      failedFollowedByRework: 1,
      passedAttempts: 1,
      passedFollowedByRework: 0,
      reworkRateAfterFail: 1,
      reworkRateAfterPass: 0,
      lift: null,
    });

    const review = result.find((row) => row.gateId === "review-evidence");

    expect(review).toMatchObject({
      passedAttempts: 1,
      passedFollowedByRework: 1,
      reworkRateAfterPass: 1,
      reworkRateAfterFail: null,
      lift: null,
    });
  });

  it("computes a finite lift when both verdict sides have rework follow-ups", () => {
    const attempts = [
      {
        id: "a-fail",
        runId: "run-1",
        nodeId: "checks",
        nodeType: "check",
        attempt: 1,
        status: "Failed",
      },
      {
        id: "a-fail-next",
        runId: "run-1",
        nodeId: "checks",
        nodeType: "check",
        attempt: 2,
        status: "Succeeded",
      },
      {
        id: "b-pass-reworked",
        runId: "run-2",
        nodeId: "checks",
        nodeType: "check",
        attempt: 1,
        status: "Reworked",
      },
      {
        id: "c-pass-quiet",
        runId: "run-3",
        nodeId: "checks",
        nodeType: "check",
        attempt: 1,
        status: "Succeeded",
      },
    ] as const;
    const gates = [
      gateRow({ nodeAttemptId: "a-fail", status: "failed" }),
      gateRow({ nodeAttemptId: "b-pass-reworked", status: "passed" }),
      gateRow({ nodeAttemptId: "c-pass-quiet", status: "passed" }),
    ];

    const [unit] = rollupControlEffectiveness({ gates, attempts });

    expect(unit?.reworkRateAfterFail).toBe(1);
    expect(unit?.reworkRateAfterPass).toBe(0.5);
    expect(unit?.lift).toBe(2);
  });

  it("excludes null capability sets from both sides of the comparison", () => {
    const result = rollupCapabilityEffectiveness({
      runs: [
        {
          id: "run-with",
          active: false,
          capabilities: [{ refId: "strict-rule", kind: "rule" }],
        },
        { id: "run-without", active: false, capabilities: [] },
        { id: "run-legacy", active: false, capabilities: null },
      ],
      attempts: [
        {
          id: "with-1",
          runId: "run-with",
          nodeId: "implement",
          nodeType: "ai_coding",
          attempt: 1,
          status: "Succeeded",
        },
        {
          id: "with-2",
          runId: "run-with",
          nodeId: "implement",
          nodeType: "ai_coding",
          attempt: 2,
          status: "Succeeded",
        },
        {
          id: "without-1",
          runId: "run-without",
          nodeId: "implement",
          nodeType: "ai_coding",
          attempt: 1,
          status: "Succeeded",
        },
        {
          id: "legacy-1",
          runId: "run-legacy",
          nodeId: "implement",
          nodeType: "ai_coding",
          attempt: 1,
          status: "Reworked",
        },
      ],
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.refId).toBe("strict-rule");
    expect(result[0]?.capabilityKind).toBe("rule");
    expect(result[0]?.withCapability.runCount).toBe(1);
    expect(result[0]?.withCapability.retryCount).toBe(1);
    expect(result[0]?.withCapability.correctionRate).toBe(1);
    expect(result[0]?.withoutCapability.runCount).toBe(1);
    expect(result[0]?.withoutCapability.correctionRate).toBe(0);
    expect(result[0]?.withoutCapability.runIds).toEqual(["run-without"]);
  });

  it("unions declared gates across revisions without duplicates", () => {
    const declared = declaredGatesFromManifests([
      manifest({
        revisionId: "rev-1",
        nodes: [
          {
            nodeId: "checks",
            gates: [
              { gateId: "unit", kind: "command_check", mode: "blocking" },
              { gateId: "lint", kind: "command_check", mode: "blocking" },
            ],
            guideCount: 0,
          },
        ],
      }),
      manifest({
        revisionId: "rev-2",
        nodes: [
          {
            nodeId: "checks",
            gates: [
              { gateId: "unit", kind: "command_check", mode: "blocking" },
            ],
            guideCount: 0,
          },
          {
            nodeId: "deploy",
            gates: [
              { gateId: "smoke", kind: "external_check", mode: "advisory" },
            ],
            guideCount: 0,
          },
        ],
      }),
    ]);

    expect(
      declared.map((gate) => `${gate.nodeId}:${gate.gateId}`).sort(),
    ).toEqual(["checks:lint", "checks:unit", "deploy:smoke"]);
  });

  it("builds the coverage map with mode counts, executions, and the guides-without-sensors flag", () => {
    const manifests = [
      manifest({
        revisionId: "rev-1",
        nodes: [
          {
            nodeId: "checks",
            gates: [
              { gateId: "unit", kind: "command_check", mode: "blocking" },
              { gateId: "lint", kind: "command_check", mode: "blocking" },
            ],
            guideCount: 0,
          },
          {
            nodeId: "implement",
            gates: [{ gateId: "style", kind: "skill_check", mode: "advisory" }],
            guideCount: 2,
          },
        ],
      }),
      manifest({
        revisionId: "rev-2",
        nodes: [
          { nodeId: "deploy", gates: [], guideCount: 1 },
          {
            nodeId: "checks",
            gates: [
              { gateId: "unit", kind: "command_check", mode: "blocking" },
            ],
            guideCount: 0,
          },
        ],
      }),
    ];
    const nodeAttemptCounts = new Map([
      ["flow-1::checks", 2],
      // a flow with attempt counts but no manifest must not enter coverage
      ["flow-9::ghost-node", 7],
    ]);

    const coverage = buildCoverageMap({ manifests, nodeAttemptCounts });

    expect(coverage).toHaveLength(1);
    expect(coverage[0]?.flowId).toBe("flow-1");
    expect(coverage[0]?.revisionCount).toBe(2);
    expect(coverage[0]?.nodes.map((node) => node.nodeId)).toEqual([
      "checks",
      "deploy",
      "implement",
    ]);

    const checks = coverage[0]?.nodes.find((node) => node.nodeId === "checks");
    const deploy = coverage[0]?.nodes.find((node) => node.nodeId === "deploy");
    const implement = coverage[0]?.nodes.find(
      (node) => node.nodeId === "implement",
    );

    expect(checks).toMatchObject({
      gateCount: 2,
      blockingGateCount: 2,
      advisoryGateCount: 0,
      guideCount: 0,
      guidesWithoutSensors: false,
      executions: 2,
    });
    expect(deploy).toMatchObject({
      gateCount: 0,
      blockingGateCount: 0,
      guideCount: 1,
      guidesWithoutSensors: true,
      executions: 0,
    });
    // advisory-only sensing still counts as guides-without-sensors
    expect(implement).toMatchObject({
      gateCount: 1,
      blockingGateCount: 0,
      advisoryGateCount: 1,
      guideCount: 2,
      guidesWithoutSensors: true,
      executions: 0,
    });
  });
});
