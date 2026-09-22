import { describe, expect, it } from "vitest";

import {
  calculateStreamLag,
  isHostBacklogLagEligible,
} from "@/lib/execution-host/events/lag";

describe("execution event lag arithmetic", () => {
  it("counts the first event behind a never-observed cursor", () => {
    expect(
      calculateStreamLag({
        headSequence: "0",
        lastReceivedSequence: null,
        lastContiguousSequence: null,
        lastAckConfirmedSequence: null,
      }),
    ).toEqual({
      hostToManager: "1",
      contiguityGap: "0",
      ackConfirmation: "0",
      diagnostics: [],
    });
    expect(
      isHostBacklogLagEligible(
        { unacknowledgedCount: 101, oldestUnacknowledgedAgeMs: 120_000 },
        120_000,
      ),
    ).toBe(true);
  });

  it("preserves signed-BIGINT precision for every distance", () => {
    expect(
      calculateStreamLag({
        headSequence: "9223372036854775807",
        lastReceivedSequence: "9223372036854775700",
        lastContiguousSequence: "9223372036854775600",
        lastAckConfirmedSequence: "9223372036854775500",
      }),
    ).toEqual({
      hostToManager: "107",
      contiguityGap: "100",
      ackConfirmation: "100",
      diagnostics: [],
    });
  });

  it("reports sampled races and inconsistent manager watermarks as unknown", () => {
    expect(
      calculateStreamLag({
        headSequence: "8",
        lastReceivedSequence: "9",
        lastContiguousSequence: "7",
        lastAckConfirmedSequence: "6",
      }),
    ).toEqual({
      hostToManager: null,
      contiguityGap: "2",
      ackConfirmation: "1",
      diagnostics: ["host_head_behind_manager"],
    });
    expect(
      calculateStreamLag({
        headSequence: "10",
        lastReceivedSequence: "8",
        lastContiguousSequence: "9",
        lastAckConfirmedSequence: "10",
      }),
    ).toEqual({
      hostToManager: "2",
      contiguityGap: null,
      ackConfirmation: null,
      diagnostics: ["contiguous_ahead_of_received", "ack_ahead_of_contiguous"],
    });
  });

  it("requires both a backlog above the threshold and the configured age", () => {
    expect(
      isHostBacklogLagEligible(
        { unacknowledgedCount: 100, oldestUnacknowledgedAgeMs: 120_000 },
        120_000,
      ),
    ).toBe(false);
    expect(
      isHostBacklogLagEligible(
        { unacknowledgedCount: 101, oldestUnacknowledgedAgeMs: 119_999 },
        120_000,
      ),
    ).toBe(false);
  });
});
