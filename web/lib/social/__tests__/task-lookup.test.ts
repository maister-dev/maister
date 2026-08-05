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

  it.each([
    ["over-long key", `${"A".repeat(11)}-1`],
    ["over-long number", `API-${"9".repeat(11)}`],
    ["number above the int4 ceiling", "API-2147483648"],
    ["zero", "API-0"],
  ])("returns null for a %s ref without querying", async (_label, ref) => {
    await expect(
      resolveTaskByKeyRef(ref, dbThatMustNotBeQueried() as never),
    ).resolves.toBeNull();
  });

  it("uppercases the key before querying — projects.task_key is uppercase-only", async () => {
    // The drizzle clause is a cyclic tree, so walk it with a seen-set rather
    // than serializing it.
    function literals(node: unknown, seen = new WeakSet<object>()): string[] {
      if (typeof node === "string") return [node];
      if (node === null || typeof node !== "object") return [];
      if (seen.has(node)) return [];
      seen.add(node);

      return Object.values(node).flatMap((v) => literals(v, seen));
    }

    let captured: string[] = [];
    const db = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: (clause: unknown) => {
              captured = literals(clause);

              return [];
            },
          }),
        }),
      }),
    };

    await expect(
      resolveTaskByKeyRef("api-42", db as never),
    ).resolves.toBeNull();
    expect(captured).toContain("API");
    expect(captured).not.toContain("api");
  });
});
