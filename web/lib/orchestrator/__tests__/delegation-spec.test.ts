import { describe, expect, it } from "vitest";

import { delegationSpecKind } from "@/lib/orchestrator/delegation-spec";

// ADR-163: `tasks.delegation_spec` becomes a discriminated union, and the
// discriminant is OPTIONAL on the agent arm because every row written before
// this change carries no `kind` at all. Readers must go through one helper
// rather than shape-sniffing `!spec.agentId` inline — a flow spec has no
// `agentId` either, so the inline test silently reclassifies every flow row as
// "malformed agent".
describe("delegationSpecKind (ADR-163)", () => {
  it("reads a legacy row with no `kind` as an agent spec", () => {
    expect(delegationSpecKind({ agentId: "pkg:worker" })).toBe("agent");
  });

  it("reads an explicit agent spec as an agent spec", () => {
    expect(delegationSpecKind({ kind: "agent", agentId: "pkg:worker" })).toBe(
      "agent",
    );
  });

  it("reads a flow spec as a flow spec", () => {
    expect(delegationSpecKind({ kind: "flow", flowId: "bugfix" })).toBe("flow");
  });

  it("reads null/undefined as null rather than guessing a kind", () => {
    expect(delegationSpecKind(null)).toBeNull();
    expect(delegationSpecKind(undefined)).toBeNull();
  });
});
