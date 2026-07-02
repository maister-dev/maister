import { describe, expect, it } from "vitest";

import { splitForEmbedding } from "@/lib/brain/chunk";

// T2.2 support: the minimal recursive oversize splitter.
describe("splitForEmbedding", () => {
  it("returns a single segment for short content (the common case)", () => {
    expect(splitForEmbedding("a short lesson")).toEqual(["a short lesson"]);
  });

  it("returns [] for empty / whitespace-only content", () => {
    expect(splitForEmbedding("   \n  ")).toEqual([]);
  });

  it("splits oversize content into ordered segments within the budget", () => {
    const paragraph = `${"word ".repeat(40).trim()}`; // ~199 chars
    const content = Array(10).fill(paragraph).join("\n\n");
    const segments = splitForEmbedding(content, 300);

    expect(segments.length).toBeGreaterThan(1);
    for (const s of segments) expect(s.length).toBeLessThanOrEqual(300);
    // order preserved — first segment starts the document
    expect(segments[0].startsWith("word")).toBe(true);
  });

  it("hard-slices a single unbroken token that exceeds the budget", () => {
    const content = "x".repeat(1000);
    const segments = splitForEmbedding(content, 100);

    expect(segments).toHaveLength(10);
    for (const s of segments) expect(s.length).toBeLessThanOrEqual(100);
    expect(segments.join("")).toBe(content);
  });
});
