import { describe, expect, it } from "vitest";

import { HostRuntimeEventError } from "../host-runtime-errors";
import { runtimeEventSupervisorError } from "../http-api";

// ADR-183 amendment 2026-09-28: one wire token for every outbox refusal, and
// the cause beside it. Before, the five causes were indistinguishable on the
// wire, so the manager fenced on a refusal the pressure bit never cleared.
describe("an outbox refusal names its limit on the wire", () => {
  it.each([
    ["event_outbox_soft_limit", "unacknowledged"],
    ["event_outbox_hard_limit", "retained"],
    ["event_outbox_physical_limit", "physical"],
    ["event_outbox_terminal_reserve_exhausted", "control"],
    ["event_outbox_wallet_exhausted", "wallet"],
  ] as const)("%s → outboxLimit %s", (reason, outboxLimit) => {
    const mapped = runtimeEventSupervisorError(
      new HostRuntimeEventError(reason, "refused"),
    );

    expect({ code: mapped.code, details: mapped.details }).toEqual({
      code: "PRECONDITION",
      details: { reason: "event_outbox_backpressure", outboxLimit },
    });
  });

  it("a non-outbox reason carries no outboxLimit", () => {
    const mapped = runtimeEventSupervisorError(
      new HostRuntimeEventError("ack_not_contiguous", "gap"),
    );

    expect(mapped.details).toEqual({ reason: "ack_not_contiguous" });
  });
});
