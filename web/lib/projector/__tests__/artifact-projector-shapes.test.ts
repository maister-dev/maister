// An ACP adapter's telemetry frames are not a corrupt event. Treating an
// unrecognised `sessionUpdate` discriminant as a PERMANENT projection failure
// poisons canonical-artifact-projector-v1 at the first such frame — observed on
// the stand at run_sequence 4 of 6824 — and the consumer's cursor then never
// advances again, so nothing else in the run is ever projected. Adapters keep
// adding frames (`model_advisory` from claude, `session_info_update` from
// codex), so an unknown shape must WARN and skip, exactly as `deriveFromLine`'s
// own contract promises. A genuinely malformed event stays permanent.

import type { ExecutionEvent } from "@/lib/db/schema";

import { describe, expect, it } from "vitest";

import { ExecutionEventProjectionError } from "@/lib/execution-host/events/projector";
import { canonicalArtifactProjector } from "@/lib/projector/artifact-projector";

const tx = {} as never;

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
  it.each([
    [
      "model_advisory (claude adapter)",
      {
        sessionUpdate: "model_advisory",
        channel: "settings_local",
        configuredModel: "claude-fable-5-1[1m]",
        observedModelId: "default",
      },
    ],
    [
      "session_info_update (codex adapter)",
      {
        sessionUpdate: "session_info_update",
        _meta: { codex: { threadStatus: "active" } },
      },
    ],
  ])("derives nothing from adapter telemetry: %s", async (_name, update) => {
    await expect(
      canonicalArtifactProjector.project(tx, updateEvent(update)),
    ).resolves.toBeUndefined();
  });

  it("skips an unrecognised shape instead of poisoning the consumer", async () => {
    await expect(
      canonicalArtifactProjector.project(
        tx,
        updateEvent({ sessionUpdate: "a_shape_a_later_adapter_adds" }),
      ),
    ).resolves.toBeUndefined();
  });

  it("still refuses a malformed event permanently", async () => {
    const malformed = await canonicalArtifactProjector
      .project(tx, updateEvent(undefined))
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(malformed).toBeInstanceOf(ExecutionEventProjectionError);
    expect((malformed as ExecutionEventProjectionError).permanent).toBe(true);
  });
});
