// ADR-181 (Codex F4/F5): a finalize binds to the head the recorded PR carries,
// so the read never guesses. A provider that answers nothing usable is a
// refusal, a retryable one when retrying may help, and never a PR state.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPrState } from "@/lib/runs/pr-adapter";
import { readRecordedPullRequest } from "@/lib/workbench-git/pull-request";

vi.mock("@/lib/runs/pr-adapter", () => ({
  getPrState: vi.fn(),
  selectPrAdapter: vi.fn(),
}));

vi.mock("@/lib/repo-source", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/repo-source")>()),
  readRemoteOrigin: vi.fn(async () => null),
}));

const GITHUB = {
  repoUrl: "https://github.com/acme/app.git",
  provider: "github",
};

const STATE = {
  kind: "state" as const,
  state: "merged" as const,
  mergedAt: "2026-09-26T08:00:00Z",
  mergeCommitSha: null,
  hasConflicts: null,
  headSha: "a".repeat(40),
};

function read(project: typeof GITHUB | null = GITHUB) {
  return readRecordedPullRequest({
    project,
    parentRepoPath: "/repos/app",
    prNumber: 42,
  });
}

beforeEach(() => {
  vi.mocked(getPrState).mockReset();
});

describe("readRecordedPullRequest", () => {
  it("reads the PR through the project's recorded remote and provider", async () => {
    vi.mocked(getPrState).mockResolvedValue(STATE);

    await expect(read()).resolves.toEqual({
      state: "merged",
      headSha: "a".repeat(40),
    });
    expect(getPrState).toHaveBeenCalledWith({
      provider: "github",
      remoteUrl: GITHUB.repoUrl,
      prNumber: 42,
    });
  });

  it.each([
    [
      "a read retrying may fix",
      { kind: "skip", transient: true, reason: "gh CLI not available" },
      { code: "EXECUTOR_UNAVAILABLE" },
    ],
    [
      "a state without the head it carries",
      { ...STATE, headSha: null },
      { code: "EXECUTOR_UNAVAILABLE" },
    ],
    [
      "a read no retry fixes",
      { kind: "skip", transient: false, reason: "cannot derive owner/repo" },
      { code: "PRECONDITION", details: { reason: "provider_unsupported" } },
    ],
    [
      "a provider with no PR reads",
      { kind: "unsupported" },
      { code: "PRECONDITION", details: { reason: "provider_unsupported" } },
    ],
  ])("refuses %s", async (_label, answer, refusal) => {
    vi.mocked(getPrState).mockResolvedValue(answer as never);

    await expect(read()).rejects.toMatchObject(refusal);
  });

  it("refuses a checkout with no remote without asking any provider", async () => {
    await expect(read(null)).rejects.toMatchObject({
      code: "PRECONDITION",
      details: { reason: "provider_unsupported" },
    });
    expect(getPrState).not.toHaveBeenCalled();
  });
});
