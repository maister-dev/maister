import { describe, expect, it } from "vitest";

import {
  deriveNodeInterruptOptions,
  INTERRUPTIBLE_NODE_TYPES,
  NODE_INTERRUPT_OPTION_IDS,
  WORKSPACE_POLICY_IDS,
} from "@/lib/runs/node-interrupt";

// T-B5 (AC-B5) — ADR-161: the option set is SERVER-owned and `restart_from`'s
// targets are LEDGER-derived, because the static graph has cycles and "earlier"
// is therefore not derivable from topology. Forward skips are out of scope.

const BASE = {
  interruptedNodeId: "implement",
  ledgerNodeIds: ["plan", "implement", "checks", "implement"] as const,
  operatorRestartCount: 0,
  maxOperatorRestarts: 10,
};

describe("T-B5 ADR-161 — server-owned option matrix", () => {
  it("offers exactly the four options, defaulting to restart_node", () => {
    const m = deriveNodeInterruptOptions(BASE);

    expect(m.options.map((o) => o.optionId)).toEqual([
      ...NODE_INTERRUPT_OPTION_IDS,
    ]);
    expect(m.defaultOptionId).toBe("restart_node");
  });

  it("derives restart targets from the ledger, de-duplicated, excluding the interrupted node", () => {
    const m = deriveNodeInterruptOptions(BASE);

    expect(m.restartTargets.map((t) => t.nodeId)).toEqual(["plan", "checks"]);
  });

  // Declared rework targets are PRESENTATION only — they must not widen or
  // narrow what is permitted.
  it("flags declared rework targets as recommended without changing eligibility", () => {
    const m = deriveNodeInterruptOptions({
      ...BASE,
      declaredReworkTargets: ["plan", "never-ran"],
    });

    expect(m.restartTargets).toEqual([
      { nodeId: "plan", recommended: true },
      { nodeId: "checks", recommended: false },
    ]);
    // `never-ran` has no prior attempt, so it is NOT offered even though the
    // flow declares it — that would be a forward skip.
    expect(m.restartTargets.map((t) => t.nodeId)).not.toContain("never-ran");
  });

  it("disables restart_from when no other node has run yet", () => {
    const m = deriveNodeInterruptOptions({
      ...BASE,
      ledgerNodeIds: ["implement"],
    });

    expect(m.restartTargets).toEqual([]);
    const restartFrom = m.options.find((o) => o.optionId === "restart_from");

    expect(restartFrom?.enabled).toBe(false);
    expect(restartFrom?.disabledReason).toContain("no earlier node");
  });

  // The safety cap bounds operator restarts per run; `resume` and `stop` are
  // never capped — an operator must always be able to let it continue or stop.
  it("disables both restart options at the safety cap, leaving resume and stop", () => {
    const m = deriveNodeInterruptOptions({
      ...BASE,
      operatorRestartCount: 10,
      maxOperatorRestarts: 10,
    });

    const byId = Object.fromEntries(m.options.map((o) => [o.optionId, o]));

    expect(byId.restart_node.enabled).toBe(false);
    expect(byId.restart_node.disabledReason).toContain(
      "MAISTER_MAX_OPERATOR_RESTARTS",
    );
    expect(byId.restart_from.enabled).toBe(false);
    expect(byId.resume.enabled).toBe(true);
    expect(byId.stop.enabled).toBe(true);
  });
});

describe("T-B1 ADR-161 — interruptible node types", () => {
  it.each([["ai_coding"], ["judge"], ["orchestrator"]])(
    "admits %s (agent-executed)",
    (t) => {
      expect(INTERRUPTIBLE_NODE_TYPES.has(t as never)).toBe(true);
    },
  );

  // cli/check run a detached process group; killing one mid-command is a
  // different mechanism and is deliberately deferred out of v1.
  it.each([["cli"], ["check"], ["human"], ["form"], ["consensus"]])(
    "refuses %s",
    (t) => {
      expect(INTERRUPTIBLE_NODE_TYPES.has(t as never)).toBe(false);
    },
  );

  it("allow-lists exactly three workspace policies", () => {
    expect([...WORKSPACE_POLICY_IDS]).toEqual([
      "keep",
      "rewind-to-node-checkpoint",
      "fresh-attempt",
    ]);
  });
});
