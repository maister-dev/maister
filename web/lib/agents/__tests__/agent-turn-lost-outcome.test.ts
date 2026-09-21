// ADR-177 T3.4 — which terminal status an agent turn produces.
//
// This arm shipped as an inline ternary inside `agentPromptOwner.prepare`,
// whose `apply` is unreachable without a live launcher — so NO test executed
// it, and inverting it left the whole suite green. Review caught that; the
// decision is now a named function and this is its coverage.
//
// Pure: the decision reads the outcome and nothing else.

import { describe, expect, it } from "vitest";

import { TERMINAL_CAS_SOURCE } from "@/lib/agents/finalization";
import { agentTerminalOutcomeFor } from "@/lib/agents/prompt-owner";

const TURN_LOST_NESTED = {
  code: "PRECONDITION",
  details: { reason: "turn_lost" },
};
// `foldReceipt`'s accepted-with-no-terminal fallback flattens the reason.
const TURN_LOST_FLAT = { code: "ACP_PROTOCOL", reason: "turn_lost" };

function failed(error: Record<string, unknown>) {
  return { state: "failed", error } as never;
}

describe("agentTerminalOutcomeFor", () => {
  it("a succeeded turn is Done, whatever the error field says", () => {
    expect(agentTerminalOutcomeFor(true, failed(TURN_LOST_NESTED))).toEqual({
      outcome: "Done",
    });
  });

  it.each([
    ["nested", TURN_LOST_NESTED],
    ["flat", TURN_LOST_FLAT],
  ])("a lost turn (%s shape) is Crashed, not Failed", (_shape, error) => {
    // The inversion guard. `Failed` is not recoverable and it blames the agent
    // for a host restart; both production error shapes must reach `Crashed`.
    expect(agentTerminalOutcomeFor(false, failed(error))).toEqual({
      outcome: "Crashed",
      reason: "agent_turn_lost",
    });
  });

  it.each([
    ["an ordinary adapter failure", { code: "SPAWN" }],
    [
      "a different ACP_PROTOCOL reason",
      { code: "ACP_PROTOCOL", details: { reason: "receipt_missing" } },
    ],
    ["an error with no reason at all", { code: "PRECONDITION" }],
  ])("%s stays Failed", (_label, error) => {
    expect(agentTerminalOutcomeFor(false, failed(error))).toEqual({
      outcome: "Failed",
      reason: "agent_prompt_failed",
    });
  });

  it("a fenced outcome is Failed — only a FAILED turn can be lost", () => {
    expect(
      agentTerminalOutcomeFor(false, {
        state: "fenced",
        error: TURN_LOST_NESTED,
      } as never),
    ).toEqual({ outcome: "Failed", reason: "agent_prompt_failed" });
  });

  it("the Crashed outcome WIDENS the CAS source set, and that is intended", () => {
    // `Failed` admits `Running | NeedsInput`; `Crashed` additionally admits
    // `NeedsInputIdle | Review`. The one-argument change carries that widening
    // implicitly, so it is asserted rather than left to be rediscovered: a host
    // restart can strand a paused or reviewing agent run the same way it
    // strands a running one. If this ever NARROWS, a lost turn would silently
    // lose the CAS and leave the run live with its command unapplied.
    expect(new Set(TERMINAL_CAS_SOURCE.Crashed)).toEqual(
      new Set([...TERMINAL_CAS_SOURCE.Failed, "NeedsInputIdle", "Review"]),
    );
  });
});
