// ADR-155: KEY-N is a platform-unique global task address, so a malformed ref
// must be rejected by the parser BEFORE it reaches the database — a bad body
// field is not a query. The real join is exercised in
// social-domain.integration.test.ts.

import { describe, expect, it } from "vitest";

import { resolveTaskByKeyRef } from "@/lib/social/task-lookup";

function dbThatMustNotBeQueried() {
  return {
    select() {
      throw new Error("parser let a malformed keyRef reach the database");
    },
  };
}

describe("resolveTaskByKeyRef parsing (ADR-155)", () => {
  it.each([
    ["missing separator", "nope"],
    ["missing number", "API-"],
    ["missing key", "-42"],
    ["non-numeric suffix", "API-4x"],
    ["empty", ""],
    ["leading digit in key", "1API-42"],
    ["whitespace", "API - 42"],
  ])("returns null for a %s ref without querying", async (_label, ref) => {
    await expect(
      resolveTaskByKeyRef(ref, dbThatMustNotBeQueried() as never),
    ).resolves.toBeNull();
  });

  it("normalizes a lowercase key and does reach the database", async () => {
    await expect(
      resolveTaskByKeyRef("api-42", dbThatMustNotBeQueried() as never),
    ).rejects.toThrow("parser let a malformed keyRef reach the database");
  });
});
