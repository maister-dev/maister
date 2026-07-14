import { describe, expect, it } from "vitest";

import {
  filterReviewableChangeEntries,
  isMaterializedReviewChangePath,
  isReviewableChangePath,
} from "@/lib/runs/reviewable-changes";

describe("reviewable-changes", () => {
  it("treats materialized Claude bundle paths as non-reviewable", () => {
    expect(
      isMaterializedReviewChangePath(".claude/skills/aif-plan/SKILL.md"),
    ).toBe(true);
    expect(isMaterializedReviewChangePath(".claude/agents/reviewer.md")).toBe(
      true,
    );
    expect(isMaterializedReviewChangePath(".claude/settings.local.json")).toBe(
      true,
    );
  });

  it("keeps user-authored dirty files reviewable", () => {
    expect(isReviewableChangePath(".ai-factory/PLAN.md")).toBe(true);
    expect(
      isReviewableChangePath("web/components/workbench/run-diff.tsx"),
    ).toBe(true);
  });

  it("filters only materialized files from change-entry lists", () => {
    const entries = filterReviewableChangeEntries([
      { path: ".ai-factory/PLAN.md", status: "A" },
      { path: ".claude/skills/aif-plan/SKILL.md", status: "A" },
    ]);

    expect(entries).toEqual([{ path: ".ai-factory/PLAN.md", status: "A" }]);
  });

  it("excludes a rename or copy when either old or new path is materialized", () => {
    const entries = filterReviewableChangeEntries([
      {
        path: "src/reviewable.ts",
        oldPath: ".claude/agents/reviewer.md",
        status: "R",
      },
      {
        path: ".claude/skills/aif-review/SKILL.md",
        oldPath: "src/reviewable-copy.ts",
        status: "C",
      },
      {
        path: "src/new-name.ts",
        oldPath: "src/old-name.ts",
        status: "R",
      },
    ]);

    expect(entries).toEqual([
      {
        path: "src/new-name.ts",
        oldPath: "src/old-name.ts",
        status: "R",
      },
    ]);
  });
});
