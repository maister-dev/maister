import { describe, expect, it } from "vitest";

import {
  capExperimentDiffSnapshot,
  summarizeDiffFilesWithPatchHashes,
} from "@/lib/experiments/diff-snapshot";

describe("experiment diff snapshots", () => {
  it("summarizes every file from the full diff with stable patch hashes", () => {
    const diff = [
      "diff --git a/a.txt b/a.txt",
      "index 111..222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/b.txt b/b.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/b.txt",
      "@@ -0,0 +1 @@",
      "+created",
      "",
    ].join("\n");

    const summaries = summarizeDiffFilesWithPatchHashes(diff);

    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toMatchObject({
      path: "a.txt",
      status: "M",
      additions: 1,
      deletions: 1,
    });
    expect(summaries[1]).toMatchObject({
      path: "b.txt",
      status: "A",
      additions: 1,
      deletions: 0,
    });
    expect(summaries[0].patchHash).toMatch(/^[0-9a-f]{64}$/);
    expect(summaries[0].patchHash).not.toBe(summaries[1].patchHash);
  });

  it("caps snapshot text without dropping the full files summary signal", () => {
    const capped = capExperimentDiffSnapshot("abcdef", {
      maxBytes: 3,
      alreadyTruncated: false,
    });

    expect(capped).toEqual({
      text: "abc",
      bytes: 6,
      truncated: true,
    });
  });

  it("preserves upstream truncation even when text is below the experiment cap", () => {
    expect(
      capExperimentDiffSnapshot("abc", {
        maxBytes: 10,
        alreadyTruncated: true,
      }),
    ).toEqual({
      text: "abc",
      bytes: 3,
      truncated: true,
    });
  });
});
