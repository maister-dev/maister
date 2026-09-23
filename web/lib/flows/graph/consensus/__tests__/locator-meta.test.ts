import { describe, expect, it } from "vitest";

import {
  decodeConsensusLocatorMeta,
  decodeConsensusTextBounds,
} from "../locator-meta";

describe("decodeConsensusLocatorMeta", () => {
  it("reads a legacy inline locator as metadata not recorded", () => {
    expect(
      decodeConsensusLocatorMeta({ kind: "inline", text: "old draft" }),
    ).toEqual({
      partial: false,
      stopReason: null,
      reason: null,
      truncated: false,
    });
  });

  it("returns null for a non-inline locator", () => {
    expect(
      decodeConsensusLocatorMeta({ kind: "execution-object", objectId: "o" }),
    ).toBeNull();
  });

  it("keeps well-formed bounds and drops accounting that does not add up", () => {
    const valid = { bytes: 10, retainedBytes: 6, droppedBytes: 4, cap: 8 };

    expect(
      decodeConsensusLocatorMeta({
        kind: "inline",
        text: "x",
        partial: true,
        stopReason: "max_tokens",
        reason: "output_cap_exceeded",
        truncated: true,
        textBounds: valid,
        inputTextBounds: { ...valid, droppedBytes: 5 },
      }),
    ).toEqual({
      partial: true,
      stopReason: "max_tokens",
      reason: "output_cap_exceeded",
      truncated: true,
      textBounds: valid,
    });
  });

  it.each([
    null,
    "10",
    { bytes: -1, retainedBytes: 0, droppedBytes: 0, cap: 1 },
    { bytes: 1.5, retainedBytes: 1.5, droppedBytes: 0, cap: 1 },
    { bytes: 3, retainedBytes: 1, droppedBytes: 1, cap: 1 },
  ])("rejects malformed bounds %j", (value) => {
    expect(decodeConsensusTextBounds(value)).toBeUndefined();
  });
});
