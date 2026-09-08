import { describe, expect, it } from "vitest";

import { haltRuleFromEvent } from "@/lib/runs/hook-trip-rule";

// ADR-108 / ADR-130: the halting rule carried on an escalation is the REAL
// rule — a capability_guard N-deny halt must never be mislabeled as
// repetition. Ported from the flow-consumer wiring suite that S2 retired
// (its fake-DB dispatch path now requires the Postgres-backed client).
describe("haltRuleFromEvent", () => {
  it("carries the liveness breakers and the capability guard unchanged", () => {
    expect(haltRuleFromEvent("repetition")).toBe("repetition");
    expect(haltRuleFromEvent("no_progress")).toBe("no_progress");
    expect(haltRuleFromEvent("capability_guard")).toBe("capability_guard");
  });

  it("folds a stray deny-only path_guard halt to repetition instead of crashing", () => {
    expect(haltRuleFromEvent("path_guard")).toBe("repetition");
  });
});
