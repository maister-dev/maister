import { describe, expect, it } from "vitest";

import {
  assertDraftVersion,
  canonicalAuthoredContentHash,
  type AuthoredCapabilityKind,
} from "@/lib/catalog/authored-service";
import { isMaisterError, MaisterError } from "@/lib/errors";

describe("canonicalAuthoredContentHash", () => {
  it("is stable across object key order", () => {
    const first = canonicalAuthoredContentHash({
      kind: "rule",
      body: { title: "Review", content: "Check tests" },
    });
    const second = canonicalAuthoredContentHash({
      body: { content: "Check tests", title: "Review" },
      kind: "rule",
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it("includes the capability kind in the hash", () => {
    const kinds = ["rule", "skill", "flow"] satisfies AuthoredCapabilityKind[];

    expect(
      new Set(
        kinds.map((kind) =>
          canonicalAuthoredContentHash({
            kind,
            body: { title: "Same body", content: "Same body" },
          }),
        ),
      ).size,
    ).toBe(3);
  });
});

describe("assertDraftVersion", () => {
  it("throws CONFLICT for stale draft edits", () => {
    let caught: unknown;

    try {
      assertDraftVersion({ expectedDraftVersion: 4, actualDraftVersion: 5 });
    } catch (err) {
      caught = err;
    }

    expect(isMaisterError(caught)).toBe(true);
    expect((caught as MaisterError).code).toBe("CONFLICT");
  });
});
