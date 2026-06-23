import { describe, expect, it } from "vitest";

import { assignments, hitlRequests } from "@/lib/db/schema";

// T1.4 (ADR-104, migration 0063): the dedicated `hook_trip` escalation kind is
// added to BOTH the `hitl_requests.kind` and `assignments.action_kind` text
// enums (the bare-text columns accept any string at the DB layer; these enums
// are the TS-level contract the runner/respond paths rely on).
describe("hook_trip enum (ADR-104, migration 0063)", () => {
  it("hitl_requests.kind includes hook_trip (full enum frozen)", () => {
    expect(hitlRequests.kind.enumValues).toEqual([
      "permission",
      "form",
      "human",
      "infra_recovery",
      "budget_breach",
      "hook_trip",
    ]);
  });

  it("assignments.action_kind includes hook_trip", () => {
    expect(assignments.actionKind.enumValues).toContain("hook_trip");
  });
});
