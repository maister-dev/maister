import { describe, expect, it } from "vitest";

import { reviewSourceFingerprint } from "@/lib/runs/review-source";

describe("reviewSourceFingerprint", () => {
  const source = {
    baseCommit: "base-sha",
    diff: "diff --git a/app.ts b/app.ts\n",
    nameStatus: [
      { path: "app.ts", status: "M" },
      { path: "new-name.ts", oldPath: "old-name.ts", status: "R" },
    ],
    truncated: false,
  } as const;

  it("is deterministic for the canonical source inputs", () => {
    expect(reviewSourceFingerprint(source)).toBe(
      reviewSourceFingerprint(source),
    );
    expect(reviewSourceFingerprint(source)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it.each([
    ["base commit", { ...source, baseCommit: "other-base" }],
    ["filtered bytes", { ...source, diff: "different diff" }],
    [
      "name-status entries",
      { ...source, nameStatus: [{ path: "app.ts", status: "A" }] },
    ],
    ["truncation flag", { ...source, truncated: true }],
  ])("changes when the %s changes", (_field, changed) => {
    expect(reviewSourceFingerprint(changed)).not.toBe(
      reviewSourceFingerprint(source),
    );
  });
});
