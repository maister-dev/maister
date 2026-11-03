import { describe, expect, it } from "vitest";

import { supervisorEventFromCanonicalRow } from "@/lib/execution-host/events/session-stream";
import {
  encodeHookTripPayload,
  parseScratchMessageContent,
} from "@/lib/run-transcript/transcript";
import { parseNoProgressDiagnostics } from "@/lib/runs/no-progress-diagnostics";

const diagnostics = {
  threshold: 150,
  countedOperations: 151,
  turnsSinceProgress: 150,
  progressResets: 1,
  pendingOperations: 0,
  ignoredUpdates: 302,
  progressMode: "read_only" as const,
  stopReason: "no_progress" as const,
  recentOperations: [
    {
      toolCallId: "call-151",
      kind: "read",
      status: "completed",
      progress: false,
      reason: "repeated_evidence",
    },
  ],
};

describe("guardrail diagnostic propagation", () => {
  it("retains diagnostic evidence through the canonical event and transcript codecs", () => {
    const event = supervisorEventFromCanonicalRow({
      eventType: "session.hook_trip",
      payloadSchema: "maister.session.hook_trip.v1",
      hostSessionId: "session-1",
      runSequence: 1n,
      payload: {
        rule: "no_progress",
        lifecycle: "post_turn",
        disposition: "halt",
        toolCall: null,
        diagnostics,
      },
    });

    expect(event).toMatchObject({ type: "session.hook_trip", diagnostics });
    expect(
      parseScratchMessageContent(
        "system",
        encodeHookTripPayload("no_progress", "halt", diagnostics),
      ),
    ).toMatchObject({ kind: "hook_trip", diagnostics });
  });

  it("keeps the original stop reason on a checkpoint exit", () => {
    expect(
      supervisorEventFromCanonicalRow({
        eventType: "session.exited",
        payloadSchema: "maister.session.exited.v1",
        hostSessionId: "session-1",
        runSequence: 2n,
        payload: {
          exitCode: 0,
          reason: "checkpoint",
          stopReason: "no_progress",
        },
      }),
    ).toMatchObject({ reason: "checkpoint", stopReason: "no_progress" });
  });

  it("does not expose raw input or output fields in diagnostic evidence", () => {
    expect(
      parseNoProgressDiagnostics({
        ...diagnostics,
        rawInput: "secret",
        rawOutput: "secret",
        recentOperations: [
          { ...diagnostics.recentOperations[0], rawInput: "secret" },
        ],
      }),
    ).toEqual(diagnostics);
    expect(
      parseNoProgressDiagnostics({ ...diagnostics, threshold: -1 }),
    ).toBeUndefined();
  });
});
