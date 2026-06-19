import path from "node:path";

export const MAISTER_REPOS_DISPLAY_ROOT = "<maister_repos>";

export function formatProjectRepoPath(
  repoPath: string,
  reposRootPath: string,
): string {
  const normalizedRepoPath = path.resolve(repoPath);
  const normalizedReposRootPath = path.resolve(reposRootPath);
  const relativePath = path.relative(
    normalizedReposRootPath,
    normalizedRepoPath,
  );

  if (relativePath === "") return MAISTER_REPOS_DISPLAY_ROOT;

  if (!relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
    return `${MAISTER_REPOS_DISPLAY_ROOT}/${relativePath
      .split(path.sep)
      .join("/")}`;
  }

  return repoPath;
}
