import { describe, expect, it } from "vitest";

import { computeDiffOfDiffs } from "@/lib/experiments/diff-of-diffs";

const DIFF_A = `diff --git a/a.ts b/a.ts
index 111..222 100644
--- a/a.ts
+++ b/a.ts
@@ -10,7 +10,7 @@
-old
+new
`;

const DIFF_A_REBASED = `diff --git a/a.ts b/a.ts
index aaa..bbb 100644
--- a/a.ts
+++ b/a.ts
@@ -90,7 +90,7 @@
-old
+new
`;

describe("computeDiffOfDiffs", () => {
  it("returns no lines for identical normalized changes", () => {
    expect(computeDiffOfDiffs(DIFF_A, DIFF_A_REBASED)).toEqual({
      identical: true,
      partial: false,
      lines: [],
    });
  });

  it("classifies same-file different hunks", () => {
    const result = computeDiffOfDiffs(
      DIFF_A,
      `diff --git a/a.ts b/a.ts
@@ -1,1 +1,1 @@
-old
+other
`,
    );

    expect(result.identical).toBe(false);
    expect(result.lines).toContainEqual({ kind: "removed", line: "+new" });
    expect(result.lines).toContainEqual({ kind: "added", line: "+other" });
  });

  it("flags truncated inputs as partial without relying on marker text", () => {
    expect(
      computeDiffOfDiffs(
        { text: DIFF_A, truncated: true },
        { text: DIFF_A, truncated: false },
      ),
    ).toMatchObject({ identical: true, partial: true });
  });
});
