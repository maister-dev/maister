import type { TaskSource } from "./model";

import { parseHost } from "@/lib/repo-source";

// ADR-207: a generated PR body closes the bound GitHub issue only when GitHub
// itself can resolve the reference — a `github` binding on the project's own
// GitHub host with a numeric key — and only for a Run that resolves its task.
// Never derived from the internal task number or the provider id.
export function githubClosingReference(args: {
  source: TaskSource | null;
  projectGithubHost: string | null;
  resolvesTask: boolean;
}): string | null {
  const { source, projectGithubHost } = args;

  if (!args.resolvesTask || !source || !projectGithubHost) return null;
  if (source.kind !== "github" || source.instance !== projectGithubHost) {
    return null;
  }

  const issueNumber = /^#([1-9][0-9]*)$/.exec(source.externalKey ?? "")?.[1];

  return issueNumber ? `Closes ${source.scope}#${issueNumber}` : null;
}

export function projectGithubHost(project: {
  provider?: string | null;
  repoUrl?: string | null;
}): string | null {
  if (project.provider !== "github" || !project.repoUrl) return null;

  return parseHost(project.repoUrl);
}
