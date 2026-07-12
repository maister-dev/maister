import { describe, expect, it, vi } from "vitest";

import {
  parseGiteaPullRequestView,
  parseGitHubPullRequestView,
  parseGitLabMergeRequestView,
  resolvePullRequestTarget,
} from "@/lib/scheduler/handlers/repo-delivery-pr-history";

describe("repo delivery PR history", () => {
  it("resolves GitHub's provider-backed merge SHA without reading a subject line", async () => {
    const execute = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        mergedAt: "2026-07-12T16:00:00Z",
        mergeCommit: { oid: "abcdef1234567" },
      }),
    });

    await expect(
      resolvePullRequestTarget(
        {
          provider: "github",
          repoPath: "/repo",
          prNumber: 42,
          remoteUrl: "https://github.com/acme/repo.git",
        },
        { readGitHub: execute },
      ),
    ).resolves.toEqual({ state: "resolved", targetSha: "abcdef1234567" });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: "/repo",
        prNumber: 42,
      }),
    );
  });

  it("keeps an open or closed-unmerged pull request out of delivery", () => {
    expect(
      parseGitHubPullRequestView(
        JSON.stringify({ mergedAt: null, mergeCommit: null }),
      ),
    ).toBeNull();
  });

  it("parses GitLab's documented merged target SHA", async () => {
    const execute = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        merged_at: "2026-07-12T16:00:00Z",
        merge_commit_sha: "abcdef1234567",
      }),
    });

    const result = await execute({});

    expect(parseGitLabMergeRequestView(result.stdout)).toBe("abcdef1234567");
    await expect(
      resolvePullRequestTarget(
        {
          provider: "gitlab",
          repoPath: "/repo",
          prNumber: 24,
          remoteUrl: "https://gitlab.example/acme/repo.git",
        },
        { readGitLab: execute },
      ),
    ).resolves.toEqual({ state: "resolved", targetSha: "abcdef1234567" });
  });

  it("parses Gitea-compatible merged target evidence", () => {
    expect(
      parseGiteaPullRequestView(
        JSON.stringify({
          merged: true,
          merge_commit_sha: "abcdef1234567",
        }),
      ),
    ).toBe("abcdef1234567");
    expect(
      parseGiteaPullRequestView(
        JSON.stringify({ merged: false, merged_at: null }),
      ),
    ).toBeNull();
  });

  it("marks a provider unavailable rather than guessing from a commit message", async () => {
    await expect(
      resolvePullRequestTarget(
        {
          provider: "generic",
          repoPath: "/repo",
          prNumber: 42,
          remoteUrl: "https://example.test/acme/repo.git",
        },
        {},
      ),
    ).resolves.toEqual({ state: "unsupported" });

    await expect(
      resolvePullRequestTarget(
        {
          provider: "github",
          repoPath: "/repo",
          prNumber: 42,
          remoteUrl: "https://github.com/acme/repo.git",
        },
        { readGitHub: vi.fn().mockRejectedValue(new Error("gh unavailable")) },
      ),
    ).resolves.toEqual({ state: "unavailable" });
  });

  it("rejects a merged response that does not identify a target commit", () => {
    expect(() =>
      parseGitHubPullRequestView(
        JSON.stringify({ mergedAt: "2026-07-12T16:00:00Z", mergeCommit: null }),
      ),
    ).toThrow("merge commit SHA");
  });
});
