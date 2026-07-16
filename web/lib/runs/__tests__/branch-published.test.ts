// ADR-141: THE published predicate. It decides whether a sync force-pushes
// (`input.push ?? published`) AND seeds the review panel's "push" checkbox, so
// the two must read the same rule — they did not, and the panel's narrower copy
// silently dropped the push for a run with an open PR but no tracking ref.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/worktree", () => ({ branchHasUpstream: vi.fn() }));

const { isBranchPublished } = await import("@/lib/runs/branch-published");
const { branchHasUpstream } = await import("@/lib/worktree");

beforeEach(() => {
  vi.mocked(branchHasUpstream).mockReset();
});

describe("isBranchPublished", () => {
  it("is TRUE for a branch with a PR even when it has no upstream tracking ref", async () => {
    // The divergence that mattered. A PR cannot exist unless the branch was
    // pushed, but the tracking ref is local config a worktree recreated by
    // recovery or reopen simply may not have. Reading only the tracking ref
    // showed "push" OFF, so the sync silently left the PR on pre-sync commits.
    vi.mocked(branchHasUpstream).mockResolvedValue(false);

    expect(
      await isBranchPublished({
        prUrl: "https://github.com/x/y/pull/1",
        repo: "/repo",
        branch: "maister/x",
      }),
    ).toBe(true);
  });

  it("short-circuits: a known PR never needs the git question asked", async () => {
    vi.mocked(branchHasUpstream).mockResolvedValue(false);

    await isBranchPublished({
      prUrl: "https://github.com/x/y/pull/1",
      repo: "/repo",
      branch: "maister/x",
    });

    expect(branchHasUpstream).not.toHaveBeenCalled();
  });

  it("falls back to the upstream tracking ref when there is no PR", async () => {
    vi.mocked(branchHasUpstream).mockResolvedValue(true);

    expect(
      await isBranchPublished({ prUrl: null, repo: "/repo", branch: "b" }),
    ).toBe(true);
    expect(branchHasUpstream).toHaveBeenCalledWith("/repo", "b");
  });

  it("is FALSE for a branch with neither — nothing to force-push onto", async () => {
    vi.mocked(branchHasUpstream).mockResolvedValue(false);

    expect(
      await isBranchPublished({ prUrl: null, repo: "/repo", branch: "b" }),
    ).toBe(false);
  });

  it("propagates a git failure — callers that must degrade own that choice", async () => {
    // The live sync path deliberately does NOT swallow this: deciding "not
    // published" on a git blip would turn a missed push into a reported success.
    vi.mocked(branchHasUpstream).mockRejectedValue(new Error("git exploded"));

    await expect(
      isBranchPublished({ prUrl: null, repo: "/repo", branch: "b" }),
    ).rejects.toThrow("git exploded");
  });
});
