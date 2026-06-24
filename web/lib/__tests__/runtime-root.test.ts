import path from "node:path";

import { describe, expect, it } from "vitest";

import { defaultRuntimeRoot } from "@/lib/runtime-root";

describe("defaultRuntimeRoot", () => {
  it("resolves package cwd to the repository root", () => {
    const repoRoot = path.join(path.sep, "repos", "mAIster");

    expect(defaultRuntimeRoot(path.join(repoRoot, "web"))).toBe(repoRoot);
    expect(defaultRuntimeRoot(path.join(repoRoot, "supervisor"))).toBe(
      repoRoot,
    );
  });

  it("keeps a repository cwd unchanged", () => {
    const repoRoot = path.join(path.sep, "repos", "mAIster");

    expect(defaultRuntimeRoot(repoRoot)).toBe(repoRoot);
  });
});
