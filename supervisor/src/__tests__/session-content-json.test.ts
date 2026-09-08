import { describe, expect, it } from "vitest";

import { encodeSessionContent } from "../session-content-json";

describe("bounded session JSON encoding", () => {
  it("preserves exact JSON bytes across escaping and surrogate boundaries", () => {
    const value = {
      escaped: '\\"\n\r\t\u0000é'.repeat(20_000),
      paired: "x".repeat(8191) + "😀",
      lone: "\ud800",
      omitted: undefined,
      nested: [true, null, undefined, { text: "retained" }],
    };
    const chunks = [...encodeSessionContent(value)];

    expect(
      Math.max(...chunks.map((chunk) => chunk.byteLength)),
    ).toBeLessThanOrEqual(48 * 1024);
    expect(Buffer.concat(chunks).toString("utf8")).toBe(JSON.stringify(value));
  });
});
