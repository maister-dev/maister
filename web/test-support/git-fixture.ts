import { execFile } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Real git repositories for execution-host adoption tests: the supervisor's
// D7 matrix inspects `.git`, so a directory alone does not pass.
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    [
      "-c",
      "user.name=eh-test",
      "-c",
      "user.email=eh-test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  );

  return stdout.trim();
}

export async function initRepo(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "commit", "-q", "--allow-empty", "-m", "init");

  return realpath(dir);
}

export async function addWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
): Promise<string> {
  await mkdir(path.dirname(worktreePath), { recursive: true });
  await git(repoPath, "worktree", "add", "-q", "-b", branch, worktreePath);

  return realpath(worktreePath);
}

export async function initRepoWithWorktree(
  root: string,
  name = "repo",
): Promise<{ repoPath: string; worktreePath: string; branch: string }> {
  const repoPath = await initRepo(path.join(root, name));
  const branch = `maister/${name}-${Date.now().toString(36)}`;
  const worktreePath = await addWorktree(
    repoPath,
    path.join(root, `${name}-wt`),
    branch,
  );

  return { repoPath, worktreePath, branch };
}
