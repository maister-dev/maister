import "server-only";

import { cp, lstat, mkdir, readdir, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import pino from "pino";

import {
  type AdapterId,
  getAdapterSupportById,
} from "@/lib/acp-runners/adapter-support";
import { copyBundleArtifactsToWorktree } from "@/lib/capabilities/materialize-bundle";
import { capabilityMaterializationRootPath } from "@/lib/capabilities/materialize";
import { atomicWriteText } from "@/lib/atomic";

const log = pino({
  name: "capabilities",
  level: process.env.LOG_LEVEL ?? "info",
});

export type AdapterHomeResult = {
  /** Redirect env merged into the session's adapterLaunch.env (home-redirect). */
  env: Record<string, string>;
  /** Roots written, for logging / cleanup. */
  materializedRoots: string[];
};

async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);

    return true;
  } catch {
    return false;
  }
}

/**
 * Materialize a coder subagent definition to the worktree `.claude/agents/<stem>.md`
 * (FR-C4). The shared writer used by both the flow-node binding and scratch
 * (claude-only — other adapters have no subagent surface). The `:` in a
 * package-qualified id is hostile to the `.claude/agents` convention, so the file
 * lands under its STEM. Returns the written path.
 */
export async function materializeSubagentDefinition(args: {
  worktreePath: string;
  agentId: string;
  source: string;
}): Promise<string> {
  const targetDir = path.join(
    path.resolve(args.worktreePath),
    ".claude",
    "agents",
  );
  const stem = args.agentId.split(":").pop() ?? args.agentId;
  const targetPath = path.join(targetDir, `${stem}.md`);

  await mkdir(targetDir, { recursive: true });
  await atomicWriteText(targetPath, args.source);

  return targetPath;
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/**
 * Materialize a project's installed-bundle skills into the per-adapter target
 * (FR-C1/C2) and return the redirect env the spawn must set.
 *
 * - claude (cwd-dir): copy each bundle's `skills/` + `agents/` into the worktree
 *   `.claude/` (the agent auto-discovers from cwd). No redirect env.
 * - codex (home-redirect): compose a per-session `CODEX_HOME` — symlink the
 *   global `auth.json`/`config.toml`, symlink each global `~/.codex/skills/*`,
 *   then copy the project bundle skills (**project wins** on name collision).
 *   codex#21907: codex does not auto-read cwd `.codex/skills` yet, hence the
 *   composed home. Returns `{ CODEX_HOME }`.
 * - gemini/opencode/mimo (home-redirect): write bundle skills under a per-session
 *   home dir and return the adapter's redirect env. The exact per-agent skills
 *   subpath is T3.5-verified via smoke; this lands the dir + env contract.
 *
 * Single-host assumption: the worktree + `~/.codex` are on the agent host (the
 * current colocated deployment). Multi-host moves this supervisor-side.
 */
export async function materializeAdapterCapabilityHome(args: {
  agent: AdapterId;
  worktreePath: string;
  runId: string;
  nodeAttemptId?: string;
  installedPaths: readonly string[];
  // Injectable for tests; defaults to the host's global codex home.
  codexGlobalHome?: string;
}): Promise<AdapterHomeResult> {
  const worktreePath = path.resolve(args.worktreePath);
  const materialization = getAdapterSupportById(args.agent)?.materialization;

  // claude (or unknown) → cwd-dir `.claude/` copy (existing behavior).
  if (!materialization || materialization.mode === "cwd-dir") {
    for (const installedPath of args.installedPaths) {
      await copyBundleArtifactsToWorktree({ installedPath, worktreePath });
    }

    return { env: {}, materializedRoots: [] };
  }

  const homeRoot = path.join(
    capabilityMaterializationRootPath(
      worktreePath,
      args.runId,
      args.nodeAttemptId,
    ),
    materialization.dir,
  );

  await mkdir(homeRoot, { recursive: true });

  if (args.agent === "codex") {
    await composeCodexHome({
      homeRoot,
      installedPaths: args.installedPaths,
      codexGlobalHome: args.codexGlobalHome ?? path.join(homedir(), ".codex"),
    });
  } else {
    // gemini/opencode/mimo: skills under `<home>/skills/` (exact per-agent
    // subpath is T3.5-verified via smoke; this lands the dir + env contract).
    await copyBundleSkills(path.join(homeRoot, "skills"), args.installedPaths);
  }

  const env = materialization.redirectEnv
    ? { [materialization.redirectEnv]: homeRoot }
    : {};

  log.debug(
    { agent: args.agent, homeRoot, redirectEnv: materialization.redirectEnv },
    "[capabilities.adapter-home] materialized adapter home",
  );

  return { env, materializedRoots: [homeRoot] };
}

// codex composed home: global symlinks + project skills (project wins).
async function composeCodexHome(args: {
  homeRoot: string;
  installedPaths: readonly string[];
  codexGlobalHome: string;
}): Promise<void> {
  // 1. Symlink global auth + config so the relocated home keeps credentials.
  for (const file of ["auth.json", "config.toml"]) {
    const src = path.join(args.codexGlobalHome, file);

    if (await pathExists(src)) {
      const dest = path.join(args.homeRoot, file);

      if (await pathExists(dest)) await rm(dest, { force: true });
      await symlink(src, dest);
    }
  }

  const skillsDir = path.join(args.homeRoot, "skills");

  await mkdir(skillsDir, { recursive: true });

  // 2. Symlink each global skill (restores global parity with claude).
  const globalSkills = path.join(args.codexGlobalHome, "skills");

  for (const entry of await listDir(globalSkills)) {
    if (entry.startsWith(".")) continue;
    const dest = path.join(skillsDir, entry);

    if (await pathExists(dest))
      await rm(dest, { recursive: true, force: true });
    await symlink(path.join(globalSkills, entry), dest);
  }

  // 3. Copy project bundle skills — PROJECT WINS (replace a same-named global).
  await copyBundleSkills(skillsDir, args.installedPaths, { projectWins: true });
}

// Copy each bundle's `skills/<slug>` into `destSkillsDir`. With `projectWins`,
// an existing entry (e.g. a symlinked global skill) is replaced; otherwise a
// repo-local entry is preserved (matching copyBundleArtifactsToWorktree).
async function copyBundleSkills(
  destSkillsDir: string,
  installedPaths: readonly string[],
  opts: { projectWins?: boolean } = {},
): Promise<void> {
  await mkdir(destSkillsDir, { recursive: true });

  for (const installedPath of installedPaths) {
    const src = path.join(installedPath, "skills");

    for (const entry of await listDir(src)) {
      if (entry.startsWith(".")) continue;
      const dest = path.join(destSkillsDir, entry);

      if (await pathExists(dest)) {
        if (!opts.projectWins) continue;
        await rm(dest, { recursive: true, force: true });
      }

      await cp(path.join(src, entry), dest, {
        recursive: true,
        force: false,
        errorOnExist: false,
      });
    }
  }
}
