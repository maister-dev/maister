import "server-only";

import { execFile } from "node:child_process";
import { cp, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import pino from "pino";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { atomicWriteText } from "@/lib/atomic";

const log = pino({
  name: "capabilities",
  level: process.env.LOG_LEVEL ?? "info",
});

const execFileAsync = promisify(execFile);

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);

    return true;
  } catch {
    return false;
  }
}

// Copy a capability bundle's `skills/` + `agents/` into the worktree's `.claude/`,
// **preferring repo-local copies**: existing files are never overwritten
// (`force:false` ⇒ per-file skip), so a skill already present in the checked-out
// project repo wins over the bundle's version. Returns which subtrees were present
// in the bundle (i.e. a copy was attempted), not whether any file was actually written.
export async function copyBundleArtifactsToWorktree(args: {
  installedPath: string;
  worktreePath: string;
}): Promise<{ skills: boolean; agents: boolean }> {
  const worktreePath = path.resolve(args.worktreePath);
  const copied = { skills: false, agents: false };

  for (const sub of ["skills", "agents"] as const) {
    const src = path.join(args.installedPath, sub);

    if (!(await pathExists(src))) continue;

    const dest = path.join(worktreePath, ".claude", sub);

    await mkdir(dest, { recursive: true });
    await cp(src, dest, { recursive: true, force: false, errorOnExist: false });
    copied[sub] = true;
  }

  log.debug(
    { installedPath: args.installedPath, worktreePath, copied },
    "[capabilities.bundle] copied bundle artifacts into worktree .claude/",
  );

  return copied;
}

// Best-effort: mark a tracked file `--skip-worktree` so local edits never show in
// `git status`/diff and are never staged/committed/promoted. A non-git worktree or
// an untracked file is fine — skip silently (hardening, not a precondition).
async function skipWorktree(
  worktreePath: string,
  relFile: string,
): Promise<void> {
  try {
    await execFileAsync(
      "git",
      ["-C", worktreePath, "update-index", "--skip-worktree", relFile],
      { cwd: worktreePath },
    );
  } catch (err) {
    log.debug(
      {
        worktreePath,
        relFile,
        err: err instanceof Error ? err.message : String(err),
      },
      "[capabilities.bundle] skip-worktree skipped",
    );
  }
}

// Give MAIster worktree/branch ownership: patch the worktree's
// `.ai-factory/config.yaml` so AIF never creates its own branch/worktree
// (`git.create_branches:false`). The file is `--skip-worktree`'d first so this
// local override never pollutes the run diff or gets promoted; comments are not
// preserved (irrelevant — the override is never committed).
export async function writeAiFactoryConfigOverride(args: {
  worktreePath: string;
  baseBranch: string;
}): Promise<void> {
  const worktreePath = path.resolve(args.worktreePath);
  const rel = path.join(".ai-factory", "config.yaml");
  const configPath = path.join(worktreePath, rel);

  let existing: Record<string, unknown> = {};

  if (await pathExists(configPath)) {
    await skipWorktree(worktreePath, rel);
    const parsed = parseYaml(await readFile(configPath, "utf8")) as unknown;

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  }

  const gitBlock = {
    ...((existing.git as Record<string, unknown> | undefined) ?? {}),
    enabled: true,
    create_branches: false,
    base_branch: args.baseBranch,
  };
  const updated = { ...existing, git: gitBlock };

  await mkdir(path.dirname(configPath), { recursive: true });
  await atomicWriteText(configPath, stringifyYaml(updated));

  log.debug(
    { worktreePath, baseBranch: args.baseBranch },
    "[capabilities.bundle] wrote .ai-factory/config.yaml override",
  );
}
