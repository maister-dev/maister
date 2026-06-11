import "server-only";

import { execFile } from "node:child_process";
import { cp, mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { and, eq } from "drizzle-orm";
import pino from "pino";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { atomicWriteText } from "@/lib/atomic";
import { capabilityImports } from "@/lib/db/schema";

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
// **preferring repo-local copies** at PER-ENTRY granularity: `skills/` holds one
// directory per skill, `agents/` one file per agent. If an entry already exists
// in the worktree it wins WHOLE — the matching bundle entry is skipped entirely,
// never merged into. A per-FILE skip (plain `cp force:false`) would instead union
// a partial repo-local skill dir (its `SKILL.md`) with the bundle's extra files
// (e.g. `references/*.md`), yielding a Frankenstein skill; copying entry-by-entry
// and skipping existing entries avoids that. Returns which subtrees were present
// in the bundle (i.e. a copy was attempted), not whether any file was written.
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

    for (const entry of await readdir(src)) {
      const destEntry = path.join(dest, entry);

      // Repo-local entry (skill dir / agent file) wins whole — skip it.
      if (await pathExists(destEntry)) continue;

      await cp(path.join(src, entry), destEntry, {
        recursive: true,
        force: false,
        errorOnExist: false,
      });
    }

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

// The materialized `.ai-factory/config.yaml` git-ownership override must never be
// staged or promoted by a downstream `git add -A` an agent step runs. It lives at
// a fixed worktree path (AIF reads it there), so it cannot be relocated out of the
// tree. `.git/info/exclude` is NOT usable: in a linked worktree it resolves to the
// SHARED common git dir, so it would leak the ignore to every worktree + the main
// checkout. A worktree `.gitignore` is the only per-worktree, `git add -A`-robust
// mechanism — git honors it even when the file is untracked (a fresh consumer
// repo). The `.gitignore` edit itself is `--skip-worktree`'d so it never shows in
// the run diff nor trips the commit gate's clean-tree check; `/.gitignore` is
// self-ignored so an untracked `.gitignore` on a fresh repo can't be swept in
// either. Repo-local skills/agents are NOT ignored — a consumer may track its own
// `.claude/`, and in the dogfood they are repo-local (never materialized).
const MATERIALIZED_GITIGNORE_PATTERNS = [
  "/.gitignore",
  "/.ai-factory/config.yaml",
];

export async function ensureWorktreeGitignore(
  worktreePath: string,
): Promise<void> {
  const root = path.resolve(worktreePath);
  const gitignorePath = path.join(root, ".gitignore");
  const existing = (await pathExists(gitignorePath))
    ? await readFile(gitignorePath, "utf8")
    : "";
  const present = new Set(existing.split("\n").map((line) => line.trim()));
  const missing = MATERIALIZED_GITIGNORE_PATTERNS.filter(
    (pattern) => !present.has(pattern),
  );

  if (missing.length > 0) {
    const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    const block = `${sep}\n# MAIster materialized capability bundle — never tracked or promoted\n${missing.join("\n")}\n`;

    await atomicWriteText(gitignorePath, existing + block);
  }

  await skipWorktree(root, ".gitignore");

  log.debug(
    { worktreePath: root, added: missing },
    "[capabilities.bundle] ensured worktree .gitignore for materialized content",
  );
}

// The full launch-time materialization block, extracted for reuse (ADR-076 §4):
// bundle artifacts land untracked + un-ignored, so `git clean -fd`
// (fresh-attempt rewinds, ADR-079 dirty discard) deletes them and index
// rewrites drop the skip-worktree override state. Idempotent — re-run after
// every such mutation. No-op for projects without Installed imports (a
// non-AIF project never gets a stray config override).
export async function materializeProjectBundlesIntoWorktree(args: {
  projectId: string;
  worktreePath: string;
  baseBranch: string;
  // FIXME(any): dual drizzle-orm peer-dep variants (store idiom).
  db: any;
}): Promise<{ bundles: number }> {
  const installedImports: Array<{ installedPath: string }> = await args.db
    .select({ installedPath: capabilityImports.installedPath })
    .from(capabilityImports)
    .where(
      and(
        eq(capabilityImports.projectId, args.projectId),
        eq(capabilityImports.packageStatus, "Installed"),
      ),
    );

  if (installedImports.length === 0) return { bundles: 0 };

  for (const imp of installedImports) {
    await copyBundleArtifactsToWorktree({
      installedPath: imp.installedPath,
      worktreePath: args.worktreePath,
    });
  }
  await writeAiFactoryConfigOverride({
    worktreePath: args.worktreePath,
    baseBranch: args.baseBranch,
  });
  await ensureWorktreeGitignore(args.worktreePath);

  log.debug(
    {
      projectId: args.projectId,
      worktreePath: args.worktreePath,
      bundles: installedImports.length,
    },
    "[capabilities.bundle] materialized project bundles into worktree",
  );

  return { bundles: installedImports.length };
}
