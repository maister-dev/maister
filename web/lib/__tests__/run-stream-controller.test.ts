import { describe, expect, it } from "vitest";

import {
  advanceRunStreamLifecycle,
  buildRunStreamUrl,
  initialRunStreamLifecycle,
  reconnectDelayMs,
} from "@/lib/run-stream-controller";

describe("run stream lifecycle controller", () => {
  it("uses bounded exponential retry delays and stops after the budget", () => {
    expect(reconnectDelayMs(0)).toBe(500);
    expect(reconnectDelayMs(1)).toBe(1_000);
    expect(reconnectDelayMs(2)).toBe(2_000);
    expect(reconnectDelayMs(3)).toBeNull();
  });

  it("keeps the last event id in the replay URL", () => {
    expect(buildRunStreamUrl("https://maister.test", "run / 1", 42, true)).toBe(
      "https://maister.test/api/runs/run%20%2F%201/stream?lastEventId=42",
    );
    expect(
      buildRunStreamUrl("https://maister.test", "run-1", null, false),
    ).toBe("https://maister.test/api/runs/run-1/stream?replay=0");
  });

  it("moves through reconnecting and disconnects when the retry budget is exhausted", () => {
    const live = advanceRunStreamLifecycle(initialRunStreamLifecycle, "opened");
    const firstClose = advanceRunStreamLifecycle(live, "unexpected_close");
    const secondAttempt = advanceRunStreamLifecycle(firstClose, "retrying");
    const secondClose = advanceRunStreamLifecycle(
      secondAttempt,
      "unexpected_close",
    );
    const thirdAttempt = advanceRunStreamLifecycle(secondClose, "retrying");
    const thirdClose = advanceRunStreamLifecycle(
      thirdAttempt,
      "unexpected_close",
    );
    const fourthAttempt = advanceRunStreamLifecycle(thirdClose, "retrying");
    const exhausted = advanceRunStreamLifecycle(
      fourthAttempt,
      "unexpected_close",
    );

    expect(firstClose).toEqual({ kind: "reconnecting", retryAttempt: 1 });
    expect(exhausted).toEqual({ kind: "disconnected", retryAttempt: 3 });
  });

  it("manual reconnect resets the retry budget and terminal state cannot schedule a retry", () => {
    const reconnecting = {
      kind: "reconnecting" as const,
      retryAttempt: 3,
    };
    const manual = advanceRunStreamLifecycle(reconnecting, "manual_reconnect");
    const terminal = advanceRunStreamLifecycle(manual, "terminal");

    expect(manual).toEqual({ kind: "connecting", retryAttempt: 0 });
    expect(terminal).toEqual({ kind: "closed", retryAttempt: 0 });
    expect(reconnectDelayMs(terminal.retryAttempt, terminal.kind)).toBeNull();
  });
});
