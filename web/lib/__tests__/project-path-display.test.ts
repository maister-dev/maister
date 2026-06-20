import { describe, expect, it } from "vitest";

import {
  formatProjectRepoPath,
  formatRunWorktreePath,
} from "@/lib/project-path-display";

describe("formatProjectRepoPath", () => {
  it("replaces the configured repos root with the maister repos marker", () => {
    expect(
      formatProjectRepoPath(
        "/Users/developer/.maister/repos/mAIster",
        "/Users/developer/.maister/repos",
      ),
    ).toBe("<maister_repos>/mAIster");
  });

  it("renders the repos root itself as the marker", () => {
    expect(
      formatProjectRepoPath(
        "/Users/developer/.maister/repos",
        "/Users/developer/.maister/repos",
      ),
    ).toBe("<maister_repos>");
  });

  it("keeps paths outside the configured repos root unchanged", () => {
    expect(
      formatProjectRepoPath(
        "/repos/mAIster",
        "/Users/developer/.maister/repos",
      ),
    ).toBe("/repos/mAIster");
  });

  it("does not mask paths that only share the repos root prefix", () => {
    expect(
      formatProjectRepoPath(
        "/Users/developer/.maister/repos-archive/mAIster",
        "/Users/developer/.maister/repos",
      ),
    ).toBe("/Users/developer/.maister/repos-archive/mAIster");
  });
});

describe("formatRunWorktreePath", () => {
  it("replaces the configured worktrees root with the maister worktrees marker", () => {
    expect(
      formatRunWorktreePath(
        "/Users/developer/.maister/worktrees/mAIster/run-1",
        "/Users/developer/.maister/worktrees",
      ),
    ).toBe("<maister_worktrees>/mAIster/run-1");
  });

  it("renders the worktrees root itself as the marker", () => {
    expect(
      formatRunWorktreePath(
        "/Users/developer/.maister/worktrees",
        "/Users/developer/.maister/worktrees",
      ),
    ).toBe("<maister_worktrees>");
  });

  it("keeps paths outside the configured worktrees root unchanged", () => {
    expect(
      formatRunWorktreePath(
        "/repos/mAIster",
        "/Users/developer/.maister/worktrees",
      ),
    ).toBe("/repos/mAIster");
  });

  it("does not mask paths that only share the worktrees root prefix", () => {
    expect(
      formatRunWorktreePath(
        "/Users/developer/.maister/worktrees-archive/mAIster/run-1",
        "/Users/developer/.maister/worktrees",
      ),
    ).toBe("/Users/developer/.maister/worktrees-archive/mAIster/run-1");
  });
});
