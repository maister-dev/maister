/** Git branch name contract shared by worktree and provider command sinks. */
export function branchNameViolation(branch: string): string | undefined {
  if (!branch.length || branch.length > 255)
    return "branch must contain between 1 and 255 characters";
  if (!/^[A-Za-z0-9_./-]+$/.test(branch))
    return "branch must match /^[A-Za-z0-9_./-]+$/";
  if (branch.startsWith("-")) return "branch must not start with '-'";
  if (branch.includes("..")) return "branch must not contain '..'";
  if (branch.startsWith("/") || branch.endsWith("/") || branch.includes("//"))
    return "branch must not start or end with '/' or contain '//'";
  if (branch.startsWith(".") || branch.includes("/."))
    return "no branch name component may start with '.'";
  if (branch.endsWith(".")) return "branch must not end with '.'";
  if (/\.lock(\/|$)/.test(branch))
    return "no branch name component may end with .lock";

  return undefined;
}
