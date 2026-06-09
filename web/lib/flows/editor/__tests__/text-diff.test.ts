import { describe, expect, it } from "vitest";

import { unifiedLineDiff } from "@/lib/flows/editor/text-diff";

describe("unifiedLineDiff", () => {
  it("identical inputs → empty string", () => {
    expect(unifiedLineDiff("a\nb\nc", "a\nb\nc")).toBe("");
  });

  it("empty before → pure additions", () => {
    expect(unifiedLineDiff("", "x\ny")).toBe("+ x\n+ y");
  });

  it("empty after → pure removals", () => {
    expect(unifiedLineDiff("x\ny", "")).toBe("- x\n- y");
  });

  it("a changed line shows a removal and an addition, common lines as context", () => {
    const diff = unifiedLineDiff("a\nOLD\nc", "a\nNEW\nc");

    expect(diff).toContain("  a");
    expect(diff).toContain("- OLD");
    expect(diff).toContain("+ NEW");
    expect(diff).toContain("  c");
  });

  it("an appended line is a single addition", () => {
    expect(unifiedLineDiff("a\nb", "a\nb\nc")).toBe("  a\n  b\n+ c");
  });
});
