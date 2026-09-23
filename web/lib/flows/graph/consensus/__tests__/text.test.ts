import { describe, expect, it } from "vitest";

import {
  CONSENSUS_PROMPT_TEXT_CAP_BYTES,
  boundConsensusText,
  finishConsensusOutput,
  retainConsensusOutput,
} from "../text";

describe("consensus UTF-8 text bound", () => {
  it("delivers a 60,000-byte draft including its tail", () => {
    const draft = `${"a".repeat(59_990)}\nlast line`;
    const result = boundConsensusText(draft, CONSENSUS_PROMPT_TEXT_CAP_BYTES);

    expect(result.text).toBe(draft);
    expect(result.truncated).toBe(false);
  });

  it("marks the exact dropped byte count without splitting a code point", () => {
    const draft = "🙂".repeat(20_000);
    const result = boundConsensusText(draft, CONSENSUS_PROMPT_TEXT_CAP_BYTES);

    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(
      CONSENSUS_PROMPT_TEXT_CAP_BYTES,
    );
    expect(Buffer.byteLength(result.text, "utf8") + 4).toBeGreaterThan(
      CONSENSUS_PROMPT_TEXT_CAP_BYTES,
    );
    expect(result.text).not.toContain("�");
    expect(result.text).toContain(
      `\n[consensus text truncated: dropped ${result.bounds.droppedBytes} UTF-8 bytes; cap 65536 bytes]`,
    );
    expect(result.bounds.bytes).toBe(80_000);
    expect(result.bounds.retainedBytes + result.bounds.droppedBytes).toBe(
      80_000,
    );
    expect(result.truncated).toBe(true);
  });

  it("joins an ACP surrogate pair split across chunks before applying the byte cap", () => {
    const first = retainConsensusOutput(
      { text: "", retainedBytes: 0, droppedBytes: 0 },
      "\ud83d",
      4,
    );
    const joined = finishConsensusOutput(
      retainConsensusOutput(first, "\ude42", 4),
      4,
    );
    const dropped = finishConsensusOutput(
      retainConsensusOutput(first, "\ude42", 3),
      3,
    );

    expect(joined).toMatchObject({
      text: "🙂",
      retainedBytes: 4,
      droppedBytes: 0,
    });
    expect(dropped).toMatchObject({
      text: "",
      retainedBytes: 0,
      droppedBytes: 4,
    });
    expect(joined.text).not.toContain("�");
  });

  it("keeps the longest prefix even when the dropped-byte count loses a digit", () => {
    const value = "a".repeat(1_000);

    for (let cap = 67; cap <= 82; cap += 1) {
      const result = boundConsensusText(value, cap);
      const candidates = Array.from(
        { length: value.length + 1 },
        (_, retained) => retained,
      ).filter(
        (retained) =>
          retained +
            Buffer.byteLength(
              `\n[consensus text truncated: dropped ${value.length - retained} UTF-8 bytes; cap ${cap} bytes]`,
              "utf8",
            ) <=
          cap,
      );

      expect(result.bounds.retainedBytes).toBe(Math.max(...candidates));
    }
  });
});
