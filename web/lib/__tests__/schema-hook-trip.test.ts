import { describe, expect, it } from "vitest";

import { assignments, hitlRequests } from "@/lib/db/schema";

// T1.4 (ADR-108, migration 0066): the dedicated `hook_trip` escalation kind is
// added to BOTH the `hitl_requests.kind` and `assignments.action_kind` text
// enums (the bare-text columns accept any string at the DB layer; these enums
// are the TS-level contract the runner/respond paths rely on).
describe("hook_trip enum (ADR-108, migration 0066)", () => {
  it("hitl_requests.kind includes hook_trip (full enum frozen)", () => {
    expect(hitlRequests.kind.enumValues).toEqual([
      "permission",
      "form",
      "human",
      "agent_question",
    "infra_recovery",
    "budget_breach",
    "hook_trip",
    // ADR-160: the operator node interrupt. TS-only — neither
    // `hitl_requests.kind` nor `assignments.action_kind` carries a DB CHECK,
    // so this value needed no migration.
    "node_interrupt",
    "decision_request",
    ]);
  });

  it("assignments.action_kind includes hook_trip", () => {
    expect(assignments.actionKind.enumValues).toContain("hook_trip");
  });

  it("both enums carry node_interrupt (ADR-160)", () => {
    expect(hitlRequests.kind.enumValues).toContain("node_interrupt");
    expect(assignments.actionKind.enumValues).toContain("node_interrupt");
  });
});
