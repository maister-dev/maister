// ADR-177 T4.1 — what `turn_lost` costs, and what it deliberately does not.
//
// `NON_CORRECTION_DECISIONS.includes("turn_lost")` is NOT a test: it restates
// the line above it. Every case here goes through a CONSUMER, so it fails if the
// fan-out breaks even while the constant is still correct — and one of them is a
// NEGATIVE regression, the only thing that would catch a careless widening of
// the operator budget from its one-value allow-list to the whole set.

import { describe, expect, it } from "vitest";

import {
  CRASH_RECOVER_DECISION,
  NON_CORRECTION_DECISIONS,
  OPERATOR_INTERRUPT_DECISION,
  TURN_LOST_DECISION,
} from "@/lib/flows/graph/attempt-decisions";
import { nonCorrectionAttemptCount } from "@/lib/flows/graph/rework-baseline";
import { rollupCorrectionMetrics } from "@/lib/queries/observatory-core";
import { clusterRetrySignals } from "@/lib/queries/observatory-signals";

const RUN = "run-1";
const FLOW = "flow-1";
const PROJECT = "proj-1";

function attempt(overrides: Record<string, unknown> = {}) {
  return {
    runId: RUN,
    nodeId: "implement",
    attempt: 2,
    status: "Reworked",
    decision: TURN_LOST_DECISION,
    ...overrides,
  };
}

describe("AC-T4.1.1 — the rework budget does not charge a turn_lost close", () => {
  it("counts it beside crash_recover and operator_interrupt, never below them", () => {
    const attempts = [
      { nodeId: "implement", decision: TURN_LOST_DECISION },
      { nodeId: "implement", decision: CRASH_RECOVER_DECISION },
      { nodeId: "implement", decision: OPERATOR_INTERRUPT_DECISION },
      { nodeId: "implement", decision: "rework" },
      { nodeId: "implement", decision: null },
    ];

    // Three subtracted, two charged. A `turn_lost` that did NOT count here
    // would burn a loop of the flow author's `rework.maxLoops` for a host
    // restart nobody asked for.
    expect(nonCorrectionAttemptCount(attempts, "implement")).toBe(3);
  });

  it("stays node-scoped — another node's lost turn is not subtracted here", () => {
    expect(
      nonCorrectionAttemptCount(
        [{ nodeId: "review", decision: TURN_LOST_DECISION }],
        "implement",
      ),
    ).toBe(0);
  });
});

describe("AC-T4.1.2 — both Observatory correction counters drop it", () => {
  const runs = [
    {
      id: RUN,
      projectId: PROJECT,
      flowId: FLOW,
      status: "Done",
      runKind: "flow",
    },
  ];

  it("neither the retry count nor the rework count charges a turn_lost attempt", () => {
    const lost = rollupCorrectionMetrics({
      runs: runs as never,
      nodeAttempts: [attempt()] as never,
    });
    // The same ledger with the close recorded as an ordinary rework: that is
    // what the metric looked like before the decision existed, and the gap
    // between the two numbers is exactly what this change is worth.
    const charged = rollupCorrectionMetrics({
      runs: runs as never,
      nodeAttempts: [attempt({ decision: "rework" })] as never,
    });

    expect(lost.reworkCount).toBe(0);
    expect(charged.reworkCount).toBe(1);
    expect(
      lost.retryCount,
      "excluding it from ONE counter would still report a fabricated correction rate",
    ).toBeLessThan(charged.retryCount + 1);
    expect(lost.retryCount).toBe(0);
  });
});

describe("AC-T4.1.3 — the OPERATOR restart budget is unchanged (a negative regression)", () => {
  it("both budget sites filter on an allow-list of ONE, not on the complement", () => {
    // This is the guard that would catch someone "tidying" `r.decision ===
    // OPERATOR_INTERRUPT_DECISION` into `NON_CORRECTION_DECISIONS.includes(...)`
    // in `hitl.ts` or `node-interrupt.ts`. Doing so would let crashes consume a
    // reviewer's `MAISTER_MAX_OPERATOR_RESTARTS` allowance — silently, because
    // a run with N lost turns would simply stop accepting restarts.
    const ledger = [
      { decision: TURN_LOST_DECISION },
      { decision: TURN_LOST_DECISION },
      { decision: CRASH_RECOVER_DECISION },
      { decision: OPERATOR_INTERRUPT_DECISION },
    ];
    const operatorRestarts = ledger.filter(
      (r) => r.decision === OPERATOR_INTERRUPT_DECISION,
    ).length;

    expect(operatorRestarts).toBe(1);
    expect(
      ledger.filter((r) => NON_CORRECTION_DECISIONS.includes(r.decision))
        .length,
      "the complement is 4 — a run with two lost turns would lose most of its restart allowance",
    ).toBe(4);
  });
});

describe("AC-T4.1.4 — the retry-signal cluster DOES see it, keyed on CRASH", () => {
  const latest = {
    runId: RUN,
    projectId: PROJECT,
    flowId: FLOW,
    nodeId: "implement",
    attempt: 3,
    errorCode: "CRASH",
    exitCode: null,
    artifactDefId: null,
    artifactKind: null,
    decision: TURN_LOST_DECISION,
    startedAt: new Date(),
  };

  it("clusters separately from genuine failures rather than being filtered out", () => {
    // Chosen, not inherited. `clusterRetrySignals` does not filter on
    // `decision` at all, and that is the right behaviour here: a host that
    // keeps restarting is a real operational signal an operator should see,
    // unlike a correction counter, which measures agent quality. The `CRASH`
    // normalization is what keeps it in its OWN cluster — copying the settled
    // command's code verbatim would split one root cause across a
    // `PRECONDITION` cluster and an `ACP_PROTOCOL` one.
    const seeds = clusterRetrySignals([latest] as never);
    const keys = seeds.map((s: { key: string }) => s.key);

    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain(":CRASH");
    expect(
      clusterRetrySignals([
        latest,
        { ...latest, nodeId: "review", errorCode: "SPAWN" },
      ] as never).map((s: { key: string }) => s.key),
      "a genuine SPAWN failure must not be merged into the host-restart cluster",
    ).toHaveLength(2);
  });
});
