import path from "node:path";

export const MAISTER_REPOS_DISPLAY_ROOT = "<maister_repos>";
export const MAISTER_WORKTREES_DISPLAY_ROOT = "<maister_worktrees>";

function formatPathInsideRoot(
  targetPath: string,
  rootPath: string,
  displayRoot: string,
): string {
  const normalizedTargetPath = path.resolve(targetPath);
  const normalizedRootPath = path.resolve(rootPath);
  const relativePath = path.relative(normalizedRootPath, normalizedTargetPath);

  if (relativePath === "") return displayRoot;

  if (!relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
    return `${displayRoot}/${relativePath.split(path.sep).join("/")}`;
  }

  return targetPath;
}

export function formatProjectRepoPath(
  repoPath: string,
  reposRootPath: string,
): string {
  return formatPathInsideRoot(
    repoPath,
    reposRootPath,
    MAISTER_REPOS_DISPLAY_ROOT,
  );
}

export function formatRunWorktreePath(
  worktreePath: string,
  worktreesRootPath: string,
): string {
  return formatPathInsideRoot(
    worktreePath,
    worktreesRootPath,
    MAISTER_WORKTREES_DISPLAY_ROOT,
  );
}
