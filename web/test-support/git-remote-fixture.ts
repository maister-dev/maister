import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Real git for the workbench git suites: a bare remote, a parent clone and run
// worktrees, all under one caller-owned root. Every call pins an identity and
// the C locale (git's diagnostics are gettext-translated, and a suite that reads
// stderr must see the same text on every host).
export async function gitIn(
  cwd: string,
  args: readonly string[],
): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    [
      "-c",
      "user.name=workbench-git-test",
      "-c",
      "user.email=workbench-git-test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      cwd,
      env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 16 * 1024 * 1024,
    },
  );

  return stdout.trim();
}

export type BareRemoteRepo = {
  remote: string;
  parent: string;
  baseSha: string;
};

// A bare remote plus a parent clone with one `base` commit on `main`, pushed.
export async function initRepoWithBareRemote(
  root: string,
): Promise<BareRemoteRepo> {
  const remote = join(root, `remote-${randomUUID()}.git`);
  const parent = join(root, `parent-${randomUUID()}`);

  await gitIn(root, ["init", "-q", "--bare", "-b", "main", remote]);
  await gitIn(root, ["clone", "-q", remote, parent]);
  await writeFile(join(parent, "base.txt"), "base\n");
  await gitIn(parent, ["add", "base.txt"]);
  await gitIn(parent, ["commit", "-q", "-m", "base"]);
  await gitIn(parent, ["push", "-q", "-u", "origin", "main"]);

  return {
    remote,
    parent,
    baseSha: await gitIn(parent, ["rev-parse", "HEAD"]),
  };
}

// A run worktree on a NEW `branch` cut from `main`; by default with one feature
// commit so the branch is ahead of its base.
export async function addRunWorktree(
  root: string,
  parent: string,
  branch: string,
  opts: { commit?: boolean } = {},
): Promise<string> {
  const worktree = join(root, `wt-${randomUUID()}`);

  await mkdir(dirname(worktree), { recursive: true });
  await gitIn(parent, [
    "worktree",
    "add",
    "-q",
    "-b",
    branch,
    worktree,
    "main",
  ]);

  if (opts.commit !== false) {
    await commitFile(worktree, "feature.txt", "feature\n", "feature commit");
  }

  return worktree;
}

export async function commitFile(
  cwd: string,
  file: string,
  content: string,
  message: string,
): Promise<string> {
  await mkdir(dirname(join(cwd, file)), { recursive: true });
  await writeFile(join(cwd, file), content);
  await gitIn(cwd, ["add", file]);
  await gitIn(cwd, ["commit", "-q", "-m", message]);

  return gitIn(cwd, ["rev-parse", "HEAD"]);
}

// Commit onto `branch` of the bare remote from a throwaway clone (someone
// else's push), creating the branch from `main` when it does not exist yet.
// Returns the new remote head.
export async function advanceRemoteBranch(
  root: string,
  remote: string,
  branch: string,
  file = `remote-${randomUUID()}.txt`,
): Promise<string> {
  const clone = join(root, `adv-${randomUUID()}`);

  await gitIn(root, ["clone", "-q", remote, clone]);

  const exists =
    (await gitIn(clone, ["ls-remote", "--heads", "origin", branch])) !== "";

  if (exists) {
    await gitIn(clone, ["switch", "-q", "--track", `origin/${branch}`]);
  } else {
    await gitIn(clone, ["switch", "-q", "-c", branch]);
  }

  const sha = await commitFile(clone, file, `${file}\n`, `advance ${branch}`);

  await gitIn(clone, ["push", "-q", "origin", `HEAD:refs/heads/${branch}`]);
  await rm(clone, { recursive: true, force: true });

  return sha;
}

export async function remoteHead(
  remote: string,
  branch: string,
): Promise<string | null> {
  const out = await gitIn(dirname(remote), [
    "--git-dir",
    remote,
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]).catch(() => "");

  return out === "" ? null : out;
}

export async function gitConfigValue(
  repo: string,
  key: string,
): Promise<string | null> {
  const out = await gitIn(repo, ["config", "--get", key]).catch(() => "");

  return out === "" ? null : out;
}
