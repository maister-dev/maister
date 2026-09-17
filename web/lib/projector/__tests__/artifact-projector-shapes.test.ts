// An ACP adapter's telemetry frame is not a corrupt event. Treating an
// unrecognised `sessionUpdate` discriminant as a PERMANENT projection failure
// poisoned canonical-artifact-projector-v1 at the first such frame — observed on
// the stand at run_sequence 4 of 6824 — and the consumer's cursor then never
// advanced again, so nothing else in the run was ever projected.
//
// Two rules are pinned here. An unknown discriminant WARNS and skips, as
// `deriveFromLine`'s own contract promises, so the next adapter frame cannot
// stop a run's projection. And every shape the protocol defines is allow-listed,
// so the ordinary run stays silent: `usage_update` alone is ~1600 events per
// run, and a warning each would trade a poisoned projector for a flooded log.

import type { ExecutionEvent } from "@/lib/db/schema";
import type { ExecutionEventProjectionError as ProjectionError } from "@/lib/execution-host/events/projector";

import { beforeEach, describe, expect, it, vi } from "vitest";

const warn = vi.fn();

vi.mock("pino", () => ({
  default: () => ({
    warn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
}));

const { ExecutionEventProjectionError } = await import(
  "@/lib/execution-host/events/projector"
);
const { canonicalArtifactProjector } = await import(
  "@/lib/projector/artifact-projector"
);

const tx = {} as never;

// Every `sessionUpdate` the ACP schema defines except the two tool-call
// variants. Pinning the PROTOCOL's set, rather than the shapes that happened to
// poison a consumer, is what makes the next SDK bump visible here first — six
// of these were missing, and `usage_update` had poisoned six consumers unseen.
const NON_DERIVING = [
  "agent_message_chunk",
  "agent_thought_chunk",
  "available_commands_update",
  "compaction_summary_chunk",
  "compaction_update",
  "config_option_update",
  "current_mode_update",
  "plan",
  "plan_removed",
  "plan_update",
  "session_info_update",
  "usage_update",
  "user_message_chunk",
] as const;

// Frames a vendor adapter adds beyond the schema.
const VENDOR_TELEMETRY = [
  [
    "model_advisory (claude)",
    {
      sessionUpdate: "model_advisory",
      channel: "settings_local",
      configuredModel: "claude-fable-5-1[1m]",
      observedModelId: "default",
    },
  ],
  [
    "session_info_update carrying codex meta",
    {
      sessionUpdate: "session_info_update",
      _meta: { codex: { threadStatus: "active" } },
    },
  ],
] as const;

function updateEvent(update: unknown): ExecutionEvent {
  return {
    id: "event-1",
    source: "host",
    runId: "run-1",
    eventType: "session.update",
    payloadSchema: "maister.session.update.v1",
    payload: { nodeAttemptId: null, update },
  } as unknown as ExecutionEvent;
}

describe("canonicalArtifactProjector shapes", () => {
  beforeEach(() => {
    warn.mockClear();
  });

  it.each(NON_DERIVING)(
    "derives nothing and stays silent for the protocol shape %s",
    async (sessionUpdate) => {
      await expect(
        canonicalArtifactProjector.project(tx, updateEvent({ sessionUpdate })),
      ).resolves.toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it.each(VENDOR_TELEMETRY)(
    "derives nothing and stays silent for vendor telemetry: %s",
    async (_name, update) => {
      await expect(
        canonicalArtifactProjector.project(tx, updateEvent(update)),
      ).resolves.toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    },
  );

  // UT-TRC-03 — the primary test for that requirement. It predates the TRC set
  // and already states the contract exactly, so it is re-pointed here rather
  // than duplicated: a second test of the same invariant is overlap.
  it("UT-TRC-03: warns and skips an unrecognised shape instead of poisoning the consumer", async () => {
    await expect(
      canonicalArtifactProjector.project(
        tx,
        updateEvent({ sessionUpdate: "a_shape_a_later_adapter_adds" }),
      ),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatchObject({
      runId: "run-1",
      eventId: "event-1",
      sessionUpdate: "a_shape_a_later_adapter_adds",
    });
  });

  it("still refuses a malformed event permanently", async () => {
    const malformed = await canonicalArtifactProjector
      .project(tx, updateEvent(undefined))
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(malformed).toBeInstanceOf(ExecutionEventProjectionError);
    expect((malformed as ProjectionError).permanent).toBe(true);
  });
});
