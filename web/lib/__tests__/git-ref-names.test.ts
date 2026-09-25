import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { branchNameSchema } from "@/lib/git-ref-names";

// ADR-181 D4: an operator now types the public branch name, so the schema must
// refuse every name `git check-ref-format --branch` refuses. A name it lets
// through fails only at the push, as a transient-looking git error that no
// retry fixes.
function gitAccepts(name: string): boolean {
  try {
    execFileSync("git", ["check-ref-format", "--branch", name], {
      stdio: "ignore",
    });

    return true;
  } catch {
    return false;
  }
}

describe("branchNameSchema", () => {
  it.each([
    "main",
    "feature/ABC-12-fix-login",
    "maister/task-0b7e/attempt-2",
    "release-1.2",
    "a.b/c_d",
  ])("accepts %s, as git does", (name) => {
    expect(gitAccepts(name)).toBe(true);
    expect(branchNameSchema.safeParse(name).success).toBe(true);
  });

  it.each([
    ["a trailing dot", "feature/x."],
    ["a component starting with a dot", "feature/.x"],
    ["a leading dot", ".x"],
    ["consecutive slashes", "feature//x"],
    ["a leading slash", "/x"],
    ["a component ending in .lock", "a.lock/b"],
    ["a trailing slash", "x/"],
    ["a double dot", "a..b"],
    ["a leading dash", "-x"],
  ])("refuses %s, as git does", (_label, name) => {
    expect(gitAccepts(name)).toBe(false);
    expect(branchNameSchema.safeParse(name).success).toBe(false);
  });
});
