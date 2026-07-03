import { describe, expect, it } from "vitest";

import { buildFilesMatrix } from "@/lib/experiments/files-matrix";

describe("buildFilesMatrix", () => {
  it("classifies single, same, and different touched files", () => {
    const matrix = buildFilesMatrix([
      {
        variantKey: "claude",
        replicateOrdinal: 1,
        files: [
          {
            path: "same.ts",
            status: "modified",
            additions: 1,
            deletions: 0,
            patchHash: "same",
          },
          {
            path: "different.ts",
            status: "modified",
            additions: 1,
            deletions: 0,
            patchHash: "a",
          },
          {
            path: "claude-only.ts",
            status: "added",
            additions: 3,
            deletions: 0,
            patchHash: "only",
          },
        ],
      },
      {
        variantKey: "codex",
        replicateOrdinal: 1,
        files: [
          {
            path: "same.ts",
            status: "modified",
            additions: 1,
            deletions: 0,
            patchHash: "same",
          },
          {
            path: "different.ts",
            status: "modified",
            additions: 2,
            deletions: 0,
            patchHash: "b",
          },
          {
            path: "renamed-old.ts => renamed-new.ts",
            status: "renamed",
            additions: 0,
            deletions: 0,
            patchHash: "rename",
          },
        ],
      },
    ]);

    expect(matrix.rows.map((row) => [row.path, row.classification])).toEqual([
      ["claude-only.ts", "single"],
      ["different.ts", "different"],
      ["renamed-old.ts => renamed-new.ts", "single"],
      ["same.ts", "same"],
    ]);
    expect(matrix.filters.same.map((row) => row.path)).toEqual(["same.ts"]);
    expect(matrix.filters.different.map((row) => row.path)).toEqual([
      "different.ts",
    ]);
    expect(matrix.rows.find((row) => row.path === "same.ts")?.touchedBy).toEqual([
      "claude",
      "codex",
    ]);
  });

  it("is empty for absent summaries", () => {
    expect(
      buildFilesMatrix([{ variantKey: "claude", replicateOrdinal: 1, files: [] }]),
    ).toEqual({ rows: [], filters: { all: [], different: [], same: [] } });
  });
});
