import "server-only";

import type { Provider } from "@/lib/repo-source";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { parseGiteaRemote } from "@/lib/runs/pr-adapter";

const execFileAsync = promisify(execFile);

const EXEC_TIMEOUT_MS = 60_000;
const EXEC_MAX_BUFFER = 4 * 1024 * 1024;
const COMMIT_SHA = /^[0-9a-f]{7,64}$/i;

export type PullRequestTargetResolution =
  | { state: "resolved"; targetSha: string }
  | { state: "unmerged" }
  | { state: "unsupported" }
  | { state: "unavailable" };

export type PullRequestTargetLookup = (input: {
  provider: Provider;
  repoPath: string;
  prNumber: number;
  remoteUrl: string;
}) => Promise<PullRequestTargetResolution>;

type CliCommand = (input: {
  repoPath: string;
  prNumber: number;
}) => Promise<{ stdout: string }>;

type GiteaRequest = (input: {
  provider: "gitea" | "gitverse";
  remoteUrl: string;
  prNumber: number;
}) => Promise<{ stdout: string }>;

export type PullRequestTargetDependencies = {
  readGitHub?: CliCommand;
  readGitLab?: CliCommand;
  readGitea?: GiteaRequest;
};

type ProviderPullRequestView = {
  mergedAt?: unknown;
  merged_at?: unknown;
  merged?: unknown;
  mergeCommit?: { oid?: unknown } | null;
  mergeCommitSha?: unknown;
  merge_commit_sha?: unknown;
  squashCommitSha?: unknown;
  squash_commit_sha?: unknown;
};

export function parseGitHubPullRequestView(stdout: string): string | null {
  const parsed = parseProviderResponse(stdout, "GitHub");

  if (isUnmerged(parsed)) return null;

  return requireSha(parsed.mergeCommit?.oid, "GitHub PR history");
}

export function parseGitLabMergeRequestView(stdout: string): string | null {
  const parsed = parseProviderResponse(stdout, "GitLab");

  if (isUnmerged(parsed)) return null;

  return requireSha(
    firstDefined(
      parsed.squashCommitSha,
      parsed.squash_commit_sha,
      parsed.mergeCommitSha,
      parsed.merge_commit_sha,
    ),
    "GitLab MR history",
  );
}

export function parseGiteaPullRequestView(stdout: string): string | null {
  const parsed = parseProviderResponse(stdout, "Gitea");

  if (parsed.merged === false) return null;
  if (parsed.merged !== true) {
    throw new RangeError("Gitea PR history returned an invalid merged state");
  }

  return requireSha(
    firstDefined(parsed.mergeCommitSha, parsed.merge_commit_sha),
    "Gitea PR history",
  );
}

export async function resolvePullRequestTarget(
  input: {
    provider: Provider;
    repoPath: string;
    prNumber: number;
    remoteUrl: string;
  },
  dependencies: PullRequestTargetDependencies = {},
): Promise<PullRequestTargetResolution> {
  if (!Number.isSafeInteger(input.prNumber) || input.prNumber <= 0) {
    return { state: "unavailable" };
  }

  try {
    switch (input.provider) {
      case "github": {
        const result = await (dependencies.readGitHub ?? readGitHubPullRequest)(
          input,
        );
        const targetSha = parseGitHubPullRequestView(result.stdout);

        return targetSha === null
          ? { state: "unmerged" }
          : { state: "resolved", targetSha };
      }
      case "gitlab": {
        const result = await (
          dependencies.readGitLab ?? readGitLabMergeRequest
        )(input);
        const targetSha = parseGitLabMergeRequestView(result.stdout);

        return targetSha === null
          ? { state: "unmerged" }
          : { state: "resolved", targetSha };
      }
      case "gitea":
      case "gitverse": {
        const giteaInput = {
          provider: input.provider,
          remoteUrl: input.remoteUrl,
          prNumber: input.prNumber,
        } as const;
        const result = await (dependencies.readGitea ?? readGiteaPullRequest)(
          giteaInput,
        );
        const targetSha = parseGiteaPullRequestView(result.stdout);

        return targetSha === null
          ? { state: "unmerged" }
          : { state: "resolved", targetSha };
      }
      default:
        return { state: "unsupported" };
    }
  } catch {
    // A provider lookup is supplemental evidence. The scanner still caches the
    // repository denominator, but marks the PR unit rate incomplete.
    return { state: "unavailable" };
  }
}

function parseProviderResponse(
  stdout: string,
  provider: string,
): ProviderPullRequestView {
  let parsed: unknown;

  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new RangeError(`${provider} PR history returned invalid JSON`);
  }

  if (!isRecord(parsed)) {
    throw new RangeError(`${provider} PR history returned an invalid payload`);
  }

  return parsed as ProviderPullRequestView;
}

function isUnmerged(view: ProviderPullRequestView): boolean {
  const mergedAt = firstPresent(view.mergedAt, view.merged_at);

  if (mergedAt === null) return true;
  if (typeof mergedAt !== "string" || mergedAt.length === 0) {
    throw new RangeError("PR history returned an invalid merged timestamp");
  }

  return false;
}

function requireSha(value: unknown, source: string): string {
  if (typeof value !== "string" || !COMMIT_SHA.test(value)) {
    throw new RangeError(`${source} returned no merge commit SHA`);
  }

  return value.toLowerCase();
}

function firstDefined(...values: readonly unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function firstPresent(...values: readonly unknown[]): unknown {
  return values.find((value) => value !== undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readGitHubPullRequest(input: {
  repoPath: string;
  prNumber: number;
}): Promise<{ stdout: string }> {
  return execFileAsync(
    "gh",
    ["pr", "view", String(input.prNumber), "--json", "mergedAt,mergeCommit"],
    cliOptions(input.repoPath),
  );
}

async function readGitLabMergeRequest(input: {
  repoPath: string;
  prNumber: number;
}): Promise<{ stdout: string }> {
  return execFileAsync(
    "glab",
    ["mr", "view", String(input.prNumber), "--output", "json"],
    cliOptions(input.repoPath),
  );
}

function cliOptions(repoPath: string): {
  cwd: string;
  signal: AbortSignal;
  maxBuffer: number;
} {
  return {
    cwd: repoPath,
    signal: AbortSignal.timeout(EXEC_TIMEOUT_MS),
    maxBuffer: EXEC_MAX_BUFFER,
  };
}

async function readGiteaPullRequest(input: {
  provider: "gitea" | "gitverse";
  remoteUrl: string;
  prNumber: number;
}): Promise<{ stdout: string }> {
  const tokenName =
    input.provider === "gitverse" ? "GITVERSE_TOKEN" : "GITEA_TOKEN";
  const token = process.env[tokenName];

  if (!token) {
    throw new Error(`${tokenName} is not configured`);
  }

  const { apiBase, owner, repo } = parseGiteaRemote(input.remoteUrl);
  const response = await fetch(
    `${apiBase}/api/v1/repos/${owner}/${repo}/pulls/${input.prNumber}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(EXEC_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    throw new Error(`Gitea PR history returned HTTP ${response.status}`);
  }

  return { stdout: await response.text() };
}
