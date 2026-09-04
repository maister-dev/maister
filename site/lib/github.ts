import { z } from "zod";

import type { RepositorySummary } from "@/lib/github-schema";

import { GITHUB_REPOSITORY } from "@/lib/site-config";

const githubRepositorySchema = z.object({
  default_branch: z.string(),
  description: z.string().nullable(),
  forks_count: z.number().int().nonnegative(),
  full_name: z.string(),
  html_url: z.string().url(),
  license: z.object({ spdx_id: z.string() }).nullable(),
  open_issues_count: z.number().int().nonnegative(),
  pushed_at: z.string().datetime(),
  stargazers_count: z.number().int().nonnegative(),
});

export class GitHubRepositoryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitHubRepositoryError";
  }
}

async function fetchRepositoryAttempt(): Promise<RepositorySummary> {
  const url = `https://api.github.com/repos/${GITHUB_REPOSITORY}`;
  const token = process.env.GITHUB_TOKEN;
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "maister-public-site",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    next: { revalidate: 900 },
    signal: AbortSignal.timeout(6_000),
  });

  if (!response.ok) {
    const responseBody = await response.text();

    throw new GitHubRepositoryError(
      `GitHub repository request failed: url=${url} status=${response.status} body=${responseBody.slice(0, 500)}`,
    );
  }

  const parsed = githubRepositorySchema.safeParse(await response.json());

  if (!parsed.success) {
    throw new GitHubRepositoryError(
      `GitHub repository response was invalid: repository=${GITHUB_REPOSITORY} issues=${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }

  return {
    defaultBranch: parsed.data.default_branch,
    description: parsed.data.description,
    forks: parsed.data.forks_count,
    fullName: parsed.data.full_name,
    license: parsed.data.license?.spdx_id ?? "Not declared",
    openIssues: parsed.data.open_issues_count,
    pushedAt: parsed.data.pushed_at,
    stars: parsed.data.stargazers_count,
    url: parsed.data.html_url,
  };
}

export async function fetchRepositorySummary(): Promise<RepositorySummary> {
  let lastError: GitHubRepositoryError | null = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await fetchRepositoryAttempt();
    } catch (error) {
      lastError =
        error instanceof GitHubRepositoryError
          ? error
          : new GitHubRepositoryError(
              `GitHub repository request failed: repository=${GITHUB_REPOSITORY}`,
              { cause: error },
            );
      console.warn("GitHub repository fetch failed", {
        attempt,
        error: lastError.message,
        repository: GITHUB_REPOSITORY,
      });

      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }

  if (!lastError) {
    throw new GitHubRepositoryError(
      `GitHub repository request failed without an error: repository=${GITHUB_REPOSITORY}`,
    );
  }

  throw lastError;
}
