import { describe, expect, it } from "vitest";

import { canonicalMemoryPath, memoryNotePath } from "../paths";

describe("AV-12 virtual memory paths", () => {
  it.each([
    "../memories/notes/v.md",
    "/memories/../v.md",
    "/memories/%2e%2e/v.md",
    "/memories/%252f/v.md",
    "/memories//v.md",
    "/memories/v.md?download=1",
    "/memories/a\\v.md",
    "/memories/v\u0000.md",
    "/memories/v\ud800.md",
    `/memories/${"你".repeat(171)}.md`,
    `/memories/${"a/".repeat(16)}v.md`,
  ])("rejects %j before selecting a vault key", (path) => {
    expect(() => canonicalMemoryPath(path)).toThrow(
      expect.objectContaining({ code: "CONFIG" }),
    );
  });

  it("normalizes NFC once and preserves case", () => {
    expect(canonicalMemoryPath("/memories/Cafe\u0301.md")).toBe(
      "/memories/Café.md",
    );
    expect(canonicalMemoryPath("/memories/CAFÉ.md")).toBe("/memories/CAFÉ.md");
    expect(canonicalMemoryPath("/memories")).toBe("/memories");
    expect(() => memoryNotePath("/memories")).toThrow(
      expect.objectContaining({ code: "CONFIG" }),
    );
  });
});
