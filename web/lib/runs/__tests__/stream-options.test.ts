import { describe, expect, it } from "vitest";

import {
  shouldReplayRunStream,
  streamReadyEvent,
} from "@/lib/runs/stream-options";

describe("run stream options", () => {
  it("replays by default", () => {
    expect(shouldReplayRunStream("http://localhost/api/runs/1/stream")).toBe(
      true,
    );
  });

  it("supports live-tail mode for tick-only consumers", () => {
    expect(
      shouldReplayRunStream("http://localhost/api/runs/1/stream?replay=0"),
    ).toBe(false);
    expect(
      shouldReplayRunStream("http://localhost/api/runs/1/stream?replay=false"),
    ).toBe(false);
    expect(
      shouldReplayRunStream("http://localhost/api/runs/1/stream?replay=live"),
    ).toBe(false);
  });

  it("uses a synthetic ready event without a durable id", () => {
    expect(streamReadyEvent()).toEqual({
      replay: false,
      type: "session.stream_ready",
    });
  });
});
