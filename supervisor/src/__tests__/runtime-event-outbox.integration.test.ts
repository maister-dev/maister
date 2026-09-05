import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { openHostState } from "../host-state";

function eventDraft(
  eventType: "session.created" | "session.command" = "session.created",
) {
  return {
    draft: {
      runId: "run-event-outbox",
      assignmentId: "b213c794-fa0a-4907-ae7c-2cf2c2e8f87a",
      assignmentEpoch: 1,
      hostSessionId: "9f314433-b7e9-49b9-baf7-3a23879eae68",
      eventType,
      occurredAt: "2026-09-04T12:00:00.000Z",
      payload: { sourceMonotonicId: 1 },
    },
    terminal: eventType === "session.command",
  };
}

describe("Stage B durable host event outbox", () => {
  it("allocates an atomic stream sequence and only acknowledges a contiguous prefix", () => {
    const state = openHostState({ inMemory: true });
    const first = state.appendRuntimeEvent(eventDraft());
    const second = state.appendRuntimeEvent(eventDraft("session.command"));
    const streamId = state.getRuntimeEventStreamId();

    expect(first.sequence).toBe("0");
    expect(second.sequence).toBe("1");
    expect(
      state.runtimeEventsAfter(streamId, null).map(({ sequence }) => sequence),
    ).toEqual(["0", "1"]);
    expect(state.ackRuntimeEvents(streamId, "1")).toBe("1");
    // Acknowledgement advances the host's durable delivery watermark without
    // destroying its replay window. A reconnect with an older Last-Event-ID
    // can therefore still be served; a fresh delivery loop asks for pending
    // events and observes none.
    expect(
      state.runtimeEventsAfter(streamId, null).map(({ sequence }) => sequence),
    ).toEqual(["0", "1"]);
    expect(state.pendingRuntimeEvents(streamId)).toEqual([]);
    state.close();
  });

  it("does not advance acknowledgement across a missing sequence", () => {
    const state = openHostState({ inMemory: true });
    const streamId = state.getRuntimeEventStreamId();

    state.appendRuntimeEvent(eventDraft());
    expect(() => state.ackRuntimeEvents(streamId, "4")).toThrow(/contiguous/i);
    state.close();
  });

  it("keeps the one host-global stream and unacknowledged replay across a supervisor restart", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "maister-event-outbox-"));

    try {
      const first = openHostState({ stateDir });
      const streamId = first.getRuntimeEventStreamId();

      first.appendRuntimeEvent(eventDraft());
      first.close();

      const restarted = openHostState({ stateDir });

      expect(restarted.getRuntimeEventStreamId()).toBe(streamId);
      expect(
        restarted
          .pendingRuntimeEvents(streamId)
          .map(({ sequence }) => sequence),
      ).toEqual(["0"]);
      restarted.close();
    } finally {
      rmSync(stateDir, { force: true, recursive: true });
    }
  });
});
