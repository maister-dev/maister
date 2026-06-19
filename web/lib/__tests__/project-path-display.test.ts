import { describe, expect, it } from "vitest";

import { formatProjectRepoPath } from "@/lib/project-path-display";

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
