import "server-only";

export const MATERIALIZED_REVIEW_CHANGE_PREFIXES = [
  ".claude/agents/",
  ".claude/skills/",
] as const;

export const MATERIALIZED_REVIEW_CHANGE_PATHS = [
  ".claude/settings.local.json",
  ".claude/settings.local.json.maister-owned",
] as const;

export type ReviewableChangeEntry = {
  path: string;
};

function normalizeRepoPath(path: string): string {
  return path.replaceAll("\\", "/");
}

export function isMaterializedReviewChangePath(path: string): boolean {
  const normalized = normalizeRepoPath(path);

  return (
    MATERIALIZED_REVIEW_CHANGE_PATHS.includes(
      normalized as (typeof MATERIALIZED_REVIEW_CHANGE_PATHS)[number],
    ) ||
    MATERIALIZED_REVIEW_CHANGE_PREFIXES.some((prefix) =>
      normalized.startsWith(prefix),
    )
  );
}

export function isReviewableChangePath(path: string): boolean {
  return !isMaterializedReviewChangePath(path);
}

export function filterReviewableChangeEntries<T extends ReviewableChangeEntry>(
  entries: readonly T[],
): T[] {
  return entries.filter((entry) => isReviewableChangePath(entry.path));
}
