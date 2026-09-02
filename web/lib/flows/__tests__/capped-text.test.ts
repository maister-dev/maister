import { describe, expect, it } from "vitest";

import {
  appendCapped,
  isCappedTextTruncated,
  STDOUT_CAP_BYTES,
} from "@/lib/flows/capped-text";
import { extractSentinelBlock } from "@/lib/flows/graph/node-output";

// ADR-165 AC-22. The accumulator is shared by the flow-node path and the
// standalone-agent path, so its exact truncation semantics are contract: they
// decide whether an oversize sentinel block reads as ABSENT (a state the caller
// handles) or as a truncated parse (a plausible wrong answer).

const OPEN = "```json maister:output";
const CLOSE = "```";

describe("appendCapped", () => {
  it("keeps the FIRST cap characters and drops the rest", () => {
    expect(appendCapped("abc", "defgh", 5)).toBe("abcde");
  });

  it("appends whole chunks while under the cap", () => {
    expect(appendCapped("ab", "cd", 10)).toBe("abcd");
  });

  it("is a no-op once the buffer is already at the cap", () => {
    expect(appendCapped("abcde", "fgh", 5)).toBe("abcde");
  });

  it("handles an exact fit without truncating", () => {
    expect(appendCapped("abc", "de", 5)).toBe("abcde");
  });

  it("defaults to the 1 MiB ceiling", () => {
    expect(STDOUT_CAP_BYTES).toBe(1_000_000);
    expect(appendCapped("", "x".repeat(STDOUT_CAP_BYTES + 10)).length).toBe(
      STDOUT_CAP_BYTES,
    );
  });

  it("marks truncation once the ceiling is reached", () => {
    expect(isCappedTextTruncated("abcd", 5)).toBe(false);
    expect(isCappedTextTruncated(appendCapped("abcd", "efg", 5), 5)).toBe(true);
  });
});

describe("the truncation semantics the sentinel contract depends on", () => {
  it("a block whose CLOSING fence fell past the cap reads as ABSENT, not as a partial parse", () => {
    const full = `${OPEN}\n{"verdict":"pass"}\n${CLOSE}\n`;
    // Cap just short of the closing fence.
    const truncated = appendCapped("", full, full.length - 5);

    expect(truncated).not.toContain(`\n${CLOSE}`);
    expect(extractSentinelBlock(truncated, 1_000_000)).toEqual({
      kind: "absent",
    });
  });

  it("a block that fits entirely still parses", () => {
    const full = `noise\n${OPEN}\n{"verdict":"pass"}\n${CLOSE}\n`;

    expect(
      extractSentinelBlock(appendCapped("", full, 10_000), 1_000_000),
    ).toEqual({ kind: "value", value: { verdict: "pass" } });
  });

  it("the LAST properly-fenced block wins over an earlier one", () => {
    const text = [
      OPEN,
      '{"verdict":"first"}',
      CLOSE,
      "some prose",
      OPEN,
      '{"verdict":"second"}',
      CLOSE,
    ].join("\n");

    expect(extractSentinelBlock(text, 1_000_000)).toEqual({
      kind: "value",
      value: { verdict: "second" },
    });
  });
});
