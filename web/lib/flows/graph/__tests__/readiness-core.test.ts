import type { GateResultStatus } from "@/lib/db/schema";

import { describe, expect, it } from "vitest";

import {
  READINESS_PRIORITY,
  blockingGateContribution,
  gateStatusContribution,
  rollupReadiness,
  isPhaseReady,
  latestAttemptIdsByNode,
  liveBlockingGates,
} from "@/lib/flows/graph/readiness-core";

// ==============================================================================
// Unit tests for gateStatusContribution
// ==============================================================================

describe("readiness-core: gateStatusContribution", () => {
  it("passed → clear", () => {
    expect(gateStatusContribution("passed")).toBe("clear");
  });

  it("overridden → overridden", () => {
    expect(gateStatusContribution("overridden")).toBe("overridden");
  });

  it("failed → failed", () => {
    expect(gateStatusContribution("failed")).toBe("failed");
  });

  it("stale → stale", () => {
    expect(gateStatusContribution("stale")).toBe("stale");
  });

  it("skipped → blocked", () => {
    expect(gateStatusContribution("skipped")).toBe("blocked");
  });

  it("pending → waiting", () => {
    expect(gateStatusContribution("pending")).toBe("waiting");
  });

  it("running → waiting", () => {
    expect(gateStatusContribution("running")).toBe("waiting");
  });
});

// ==============================================================================
// Unit tests for READINESS_PRIORITY order
// ==============================================================================

describe("readiness-core: READINESS_PRIORITY", () => {
  it("is ordered: failed > stale > blocked > waiting > overridden > ready", () => {
    expect(READINESS_PRIORITY).toEqual([
      "failed",
      "stale",
      "blocked",
      "waiting",
      "overridden",
      "ready",
    ]);
  });
});

// ==============================================================================
// Unit tests for rollupReadiness
// ==============================================================================

describe("readiness-core: rollupReadiness", () => {
  it("empty contributions → ready", () => {
    expect(rollupReadiness([])).toBe("ready");
  });

  it("all clear → ready", () => {
    expect(rollupReadiness(["clear", "clear", "clear"])).toBe("ready");
  });

  it("only overridden → overridden", () => {
    expect(rollupReadiness(["overridden"])).toBe("overridden");
  });

  it("clear + overridden → overridden", () => {
    expect(rollupReadiness(["clear", "overridden"])).toBe("overridden");
  });

  it("waiting → waiting", () => {
    expect(rollupReadiness(["waiting"])).toBe("waiting");
  });

  it("overridden + waiting → waiting (waiting beats overridden)", () => {
    expect(rollupReadiness(["overridden", "waiting"])).toBe("waiting");
  });

  it("blocked → blocked", () => {
    expect(rollupReadiness(["blocked"])).toBe("blocked");
  });

  it("waiting + blocked → blocked (blocked beats waiting)", () => {
    expect(rollupReadiness(["waiting", "blocked"])).toBe("blocked");
  });

  it("stale → stale", () => {
    expect(rollupReadiness(["stale"])).toBe("stale");
  });

  it("blocked + stale → stale (stale beats blocked)", () => {
    expect(rollupReadiness(["blocked", "stale"])).toBe("stale");
  });

  it("failed → failed", () => {
    expect(rollupReadiness(["failed"])).toBe("failed");
  });

  it("stale + failed → failed (failed beats stale)", () => {
    expect(rollupReadiness(["stale", "failed"])).toBe("failed");
  });

  it("mixed set with all types → failed (highest priority)", () => {
    expect(
      rollupReadiness([
        "clear",
        "overridden",
        "waiting",
        "blocked",
        "stale",
        "failed",
      ]),
    ).toBe("failed");
  });

  it("clear + clear + overridden + waiting → waiting", () => {
    expect(rollupReadiness(["clear", "clear", "overridden", "waiting"])).toBe(
      "waiting",
    );
  });
});

// ==============================================================================
// Unit tests for isPhaseReady
// ==============================================================================

describe("readiness-core: isPhaseReady", () => {
  it("ready → true", () => {
    expect(isPhaseReady("ready")).toBe(true);
  });

  it("overridden → true (overridden clears enforcement)", () => {
    expect(isPhaseReady("overridden")).toBe(true);
  });

  it("blocked → false", () => {
    expect(isPhaseReady("blocked")).toBe(false);
  });

  it("stale → false", () => {
    expect(isPhaseReady("stale")).toBe(false);
  });

  it("failed → false", () => {
    expect(isPhaseReady("failed")).toBe(false);
  });

  it("waiting → false", () => {
    expect(isPhaseReady("waiting")).toBe(false);
  });
});

// ==============================================================================
// Unit tests for latestAttemptIdsByNode
// ==============================================================================

describe("readiness-core: latestAttemptIdsByNode", () => {
  it("returns max-attempt id per nodeId", () => {
    const attempts = [
      { id: "a1", nodeId: "n1", attempt: 1 },
      { id: "a2", nodeId: "n1", attempt: 2 },
      { id: "b1", nodeId: "n2", attempt: 1 },
    ];

    const result = latestAttemptIdsByNode(attempts);

    expect(result).toEqual(new Set(["a2", "b1"]));
  });

  it("returns only the max attempt per nodeId (multiple higher attempts)", () => {
    const attempts = [
      { id: "a1", nodeId: "n1", attempt: 1 },
      { id: "a2", nodeId: "n1", attempt: 3 },
      { id: "a3", nodeId: "n1", attempt: 2 },
      { id: "a4", nodeId: "n1", attempt: 5 },
    ];

    const result = latestAttemptIdsByNode(attempts);

    expect(result).toEqual(new Set(["a4"]));
  });

  it("handles multiple distinct nodes", () => {
    const attempts = [
      { id: "a2", nodeId: "n1", attempt: 2 },
      { id: "b3", nodeId: "n2", attempt: 3 },
      { id: "c1", nodeId: "n3", attempt: 1 },
    ];

    const result = latestAttemptIdsByNode(attempts);

    expect(result).toEqual(new Set(["a2", "b3", "c1"]));
  });

  it("returns empty set for empty input", () => {
    const result = latestAttemptIdsByNode([]);

    expect(result).toEqual(new Set());
  });
});

// ==============================================================================
// Unit tests for liveBlockingGates
// ==============================================================================

type GateRow = {
  id: string;
  gateId: string;
  kind: GateResultStatus | string;
  mode: string;
  status: GateResultStatus;
  nodeAttemptId: string;
  createdAt: Date;
};

describe("readiness-core: liveBlockingGates", () => {
  it("filters to blocking mode only", () => {
    const now = new Date();
    const liveAttemptIds = new Set(["attempt-1"]);
    const gates: GateRow[] = [
      {
        id: "g1",
        gateId: "check-1",
        kind: "command_check" as any,
        mode: "blocking",
        status: "failed",
        nodeAttemptId: "attempt-1",
        createdAt: now,
      },
      {
        id: "g2",
        gateId: "check-2",
        kind: "command_check" as any,
        mode: "advisory",
        status: "failed",
        nodeAttemptId: "attempt-1",
        createdAt: now,
      },
    ];

    const result = liveBlockingGates(gates, liveAttemptIds);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("g1");
  });

  it("filters to live attempts only", () => {
    const now = new Date();
    const liveAttemptIds = new Set(["attempt-2"]);
    const gates: GateRow[] = [
      {
        id: "g1",
        gateId: "check-1",
        kind: "command_check" as any,
        mode: "blocking",
        status: "failed",
        nodeAttemptId: "attempt-1",
        createdAt: now,
      },
      {
        id: "g2",
        gateId: "check-2",
        kind: "command_check" as any,
        mode: "blocking",
        status: "failed",
        nodeAttemptId: "attempt-2",
        createdAt: now,
      },
    ];

    const result = liveBlockingGates(gates, liveAttemptIds);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("g2");
  });

  it("keeps blocking command_check gates on live attempts", () => {
    const now = new Date();
    const liveAttemptIds = new Set(["attempt-1"]);
    const gates: GateRow[] = [
      {
        id: "g1",
        gateId: "cmd",
        kind: "command_check" as any,
        mode: "blocking",
        status: "failed",
        nodeAttemptId: "attempt-1",
        createdAt: now,
      },
    ];

    const result = liveBlockingGates(gates, liveAttemptIds);

    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("command_check");
  });

  it("keeps blocking ai_judgment gates on live attempts", () => {
    const now = new Date();
    const liveAttemptIds = new Set(["attempt-1"]);
    const gates: GateRow[] = [
      {
        id: "g1",
        gateId: "judge",
        kind: "ai_judgment" as any,
        mode: "blocking",
        status: "stale",
        nodeAttemptId: "attempt-1",
        createdAt: now,
      },
    ];

    const result = liveBlockingGates(gates, liveAttemptIds);

    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("ai_judgment");
  });

  it("keeps blocking skill_check gates on live attempts", () => {
    const now = new Date();
    const liveAttemptIds = new Set(["attempt-1"]);
    const gates: GateRow[] = [
      {
        id: "g1",
        gateId: "skill",
        kind: "skill_check" as any,
        mode: "blocking",
        status: "failed",
        nodeAttemptId: "attempt-1",
        createdAt: now,
      },
    ];

    const result = liveBlockingGates(gates, liveAttemptIds);

    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("skill_check");
  });

  it("keeps blocking artifact_required gates on live attempts", () => {
    const now = new Date();
    const liveAttemptIds = new Set(["attempt-1"]);
    const gates: GateRow[] = [
      {
        id: "g1",
        gateId: "artifact",
        kind: "artifact_required" as any,
        mode: "blocking",
        status: "failed",
        nodeAttemptId: "attempt-1",
        createdAt: now,
      },
    ];

    const result = liveBlockingGates(gates, liveAttemptIds);

    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("artifact_required");
  });

  it("collapses external_check gates to latest per gateId", () => {
    const now = new Date();
    const later = new Date(now.getTime() + 1000);
    const liveAttemptIds = new Set(["attempt-1"]);
    const gates: GateRow[] = [
      {
        id: "g1",
        gateId: "ci-gate",
        kind: "external_check" as any,
        mode: "blocking",
        status: "pending",
        nodeAttemptId: "attempt-1",
        createdAt: now,
      },
      {
        id: "g2",
        gateId: "ci-gate",
        kind: "external_check" as any,
        mode: "blocking",
        status: "passed",
        nodeAttemptId: "attempt-1",
        createdAt: later, // newer
      },
    ];

    const result = liveBlockingGates(gates, liveAttemptIds);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("g2"); // keeps the newer one
  });

  it("drops external_check rows from non-live attempts before collapse", () => {
    const now = new Date();
    const liveAttemptIds = new Set(["attempt-2"]);
    const gates: GateRow[] = [
      {
        id: "g1",
        gateId: "ci-gate",
        kind: "external_check" as any,
        mode: "blocking",
        status: "passed",
        nodeAttemptId: "attempt-1", // stale attempt
        createdAt: now,
      },
      {
        id: "g2",
        gateId: "ci-gate",
        kind: "external_check" as any,
        mode: "blocking",
        status: "pending",
        nodeAttemptId: "attempt-2", // live attempt
        createdAt: now,
      },
    ];

    const result = liveBlockingGates(gates, liveAttemptIds);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("g2");
  });

  it("returns empty array when no gates match filters", () => {
    const now = new Date();
    const liveAttemptIds = new Set(["attempt-1"]);
    const gates: GateRow[] = [
      {
        id: "g1",
        gateId: "check",
        kind: "command_check" as any,
        mode: "advisory", // not blocking
        status: "failed",
        nodeAttemptId: "attempt-1",
        createdAt: now,
      },
    ];

    const result = liveBlockingGates(gates, liveAttemptIds);

    expect(result).toHaveLength(0);
  });

  it("handles mixed gate kinds with external collapse", () => {
    const now = new Date();
    const later = new Date(now.getTime() + 1000);
    const liveAttemptIds = new Set(["attempt-1"]);
    const gates: GateRow[] = [
      {
        id: "g1",
        gateId: "cmd-gate",
        kind: "command_check" as any,
        mode: "blocking",
        status: "failed",
        nodeAttemptId: "attempt-1",
        createdAt: now,
      },
      {
        id: "g2",
        gateId: "ci-gate",
        kind: "external_check" as any,
        mode: "blocking",
        status: "passed",
        nodeAttemptId: "attempt-1",
        createdAt: now,
      },
      {
        id: "g3",
        gateId: "ci-gate",
        kind: "external_check" as any,
        mode: "blocking",
        status: "failed",
        nodeAttemptId: "attempt-1",
        createdAt: later, // newer external_check for same gateId
      },
    ];

    const result = liveBlockingGates(gates, liveAttemptIds);

    // Should have the command_check (g1) and the newer external_check (g3)
    expect(result).toHaveLength(2);
    const ids = new Set(result.map((g) => g.id));

    expect(ids).toEqual(new Set(["g1", "g3"]));
  });
});

// ==============================================================================
// M29 (ADR-073, D-C7): assertion-aware artifact_required failed re-evaluation
// ==============================================================================

describe("readiness-core: blockingGateContribution (M29 assertion-awareness)", () => {
  const currentDefIds = new Set(["impl-diff", "test-report"]);

  it("legacy failed artifact_required with all inputs present → clear (regression)", () => {
    expect(
      blockingGateContribution(
        {
          kind: "artifact_required",
          status: "failed",
          inputArtifactRefs: ["impl-diff", "test-report"],
        },
        currentDefIds,
      ),
    ).toBe("clear");
  });

  it("legacy failed artifact_required with a missing input → failed (regression)", () => {
    expect(
      blockingGateContribution(
        {
          kind: "artifact_required",
          status: "failed",
          inputArtifactRefs: ["impl-diff", "absent-def"],
        },
        currentDefIds,
      ),
    ).toBe("failed");
  });

  it("assertion-failed verdict → failed even when EVERY input is present", () => {
    expect(
      blockingGateContribution(
        {
          kind: "artifact_required",
          status: "failed",
          inputArtifactRefs: ["impl-diff", "test-report"],
          verdict: {
            verdict: "fail",
            reasons: ["must_touch: no path matched [src/**]"],
            payload: { assertionFailed: true },
          },
        },
        currentDefIds,
      ),
    ).toBe("failed");
  });

  it("assertion-failed verdict with EMPTY inputArtifactRefs → failed", () => {
    expect(
      blockingGateContribution(
        {
          kind: "artifact_required",
          status: "failed",
          inputArtifactRefs: [],
          verdict: { verdict: "fail", payload: { assertionFailed: true } },
        },
        currentDefIds,
      ),
    ).toBe("failed");
  });

  it("a failed verdict WITHOUT assertionFailed keeps the inputs-present → clear re-eval", () => {
    expect(
      blockingGateContribution(
        {
          kind: "artifact_required",
          status: "failed",
          inputArtifactRefs: ["impl-diff"],
          verdict: {
            verdict: "fail",
            reasons: ["missing or stale artifact(s)"],
          },
        },
        currentDefIds,
      ),
    ).toBe("clear");
  });

  it("a PASSED gate with an assertion verdict maps clear as before", () => {
    expect(
      blockingGateContribution(
        {
          kind: "artifact_required",
          status: "passed",
          inputArtifactRefs: ["impl-diff"],
          verdict: { verdict: "pass" },
        },
        currentDefIds,
      ),
    ).toBe("clear");
  });
});
