import type { Logger } from "pino";
import type { HostState, WorkspaceRow } from "./host-state";
import type {
  AdoptWorkspacePayload,
  ContextMount,
  WorkspaceKind,
  WorkspaceRule,
} from "./types";

import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { SupervisorError } from "./types";
import { isUnderRoot } from "./workspace-roots";

// ADR-166 D7: opaque adopted-workspace handles. `POST /workspaces/adopt` is the
// ONLY path-bearing route; every later route derives its paths from the handle
// through `resolveForSession` — the single path-derivation function that
// feeds spawn (cwd + step log) and prompt confinement.

export type WorkspaceResolution = {
  executionWorkspaceId: string;
  runId: string;
  projectSlug: string;
  cwd: string;
  repoPath?: string;
  confineRoot?: string;
  runDir: string;
  logPath: string;
  contextMounts?: ContextMount[];
};

export type ResolveForSessionInput = {
  stepId: string;
};

function runDirFor(runtimeRoot: string, projectSlug: string, runId: string) {
  return path.resolve(runtimeRoot, ".maister", projectSlug, "runs", runId);
}

function runPaths(runDir: string, stepId: string) {
  return {
    logPath: path.join(runDir, `${stepId}.log`),
  };
}

async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

// A `.git` FILE is a linked worktree, never a repo root.
function isGitRepoRoot(p: string): Promise<boolean> {
  return isDirectory(path.join(p, ".git"));
}

// A linked worktree's `.git` is a FILE `gitdir: <path>` that resolves under
// `<repo>/.git/worktrees/`. A directory `.git` is a repo root, not a worktree.
// Every filesystem failure reads as "not a worktree" so it maps to a rule
// token, never a 500.
async function worktreeGitdir(worktree: string): Promise<string | null> {
  const dotGit = path.join(worktree, ".git");
  let content: string;

  try {
    if (!(await lstat(dotGit)).isFile()) return null;
    content = await readFile(dotGit, "utf8");
  } catch {
    return null;
  }

  const match = /^gitdir:\s*(.+?)\s*$/m.exec(content);

  if (!match) return null;

  const target = match[1];

  return path.isAbsolute(target) ? target : path.resolve(worktree, target);
}

// A context mount is a git checkout of either shape: a repo root (`.git`
// directory) or — the production shape, `git worktree add --detach` — a
// linked worktree (`.git` file whose gitdir exists).
async function isGitCheckout(p: string): Promise<boolean> {
  if (await isGitRepoRoot(p)) return true;

  const gitdir = await worktreeGitdir(p);

  return gitdir !== null && (await isDirectory(gitdir));
}

function hasParentSegment(p: string): boolean {
  return p.split(path.sep).includes("..");
}

export type WorkspaceRegistryOptions = {
  state: HostState;
  roots: string[];
  runtimeRoot: string;
  logger: Logger;
  now?: () => Date;
};

export class WorkspaceRegistry {
  private readonly log: Logger;
  private readonly now: () => Date;

  constructor(private readonly opts: WorkspaceRegistryOptions) {
    this.log = opts.logger.child({ component: "workspace-registry" });
    this.now = opts.now ?? (() => new Date());
  }

  get roots(): readonly string[] {
    return this.opts.roots;
  }

  async adopt(
    payload: AdoptWorkspacePayload,
  ): Promise<{ handle: WorkspaceRow; replayed: boolean }> {
    const realPath = await this.validate(payload);
    const contextMounts = payload.contextMounts
      ? await this.validateMounts(payload.contextMounts)
      : null;
    const existing = this.opts.state.findWorkspaceByRealPath(
      payload.runId,
      realPath,
    );

    if (existing) {
      this.log.info(
        {
          executionWorkspaceId: existing.id,
          runId: payload.runId,
          kind: existing.kind,
          replayed: true,
        },
        "workspace-adopted",
      );

      return { handle: existing, replayed: true };
    }

    const handle: WorkspaceRow = {
      id: `ws_${randomUUID().replace(/-/g, "")}`,
      runId: payload.runId,
      projectSlug: payload.projectSlug,
      kind: payload.kind,
      path: payload.path,
      realPath,
      repoPath: payload.repoPath ?? null,
      runDir: runDirFor(
        this.opts.runtimeRoot,
        payload.projectSlug,
        payload.runId,
      ),
      contextMounts,
      adoptedAt: this.now().toISOString(),
      releasedAt: null,
    };

    this.opts.state.insertWorkspace(handle);
    this.log.info(
      {
        executionWorkspaceId: handle.id,
        runId: payload.runId,
        projectSlug: payload.projectSlug,
        kind: handle.kind,
        replayed: false,
      },
      "workspace-adopted",
    );

    return { handle, replayed: false };
  }

  get(id: string): WorkspaceRow | null {
    return this.opts.state.getWorkspace(id);
  }

  release(id: string): boolean {
    const released = this.opts.state.releaseWorkspace(
      id,
      this.now().toISOString(),
    );

    if (released) {
      this.log.info({ executionWorkspaceId: id }, "workspace-released");
    }

    return released;
  }

  resolveForSession(
    executionWorkspaceId: string,
    input: ResolveForSessionInput,
  ): WorkspaceResolution {
    const handle = this.opts.state.getWorkspace(executionWorkspaceId);

    if (!handle) {
      throw new SupervisorError("PRECONDITION", "unknown execution workspace", {
        details: { reason: "unknown_workspace" },
      });
    }

    if (handle.releasedAt) {
      throw new SupervisorError(
        "PRECONDITION",
        "execution workspace has been released",
        { details: { reason: "workspace_released", runId: handle.runId } },
      );
    }

    const kind = handle.kind as WorkspaceKind;
    const resolution: WorkspaceResolution = {
      executionWorkspaceId: handle.id,
      runId: handle.runId,
      projectSlug: handle.projectSlug,
      cwd: handle.path,
      runDir: handle.runDir,
      ...runPaths(handle.runDir, input.stepId),
      contextMounts:
        (handle.contextMounts as ContextMount[] | null) ?? undefined,
    };

    if (kind === "git_worktree" && handle.repoPath) {
      resolution.repoPath = handle.repoPath;
    } else if (kind === "repo_checkout") {
      resolution.repoPath = handle.path;
    } else if (kind === "directory") {
      resolution.confineRoot = handle.path;
    }

    return resolution;
  }

  // The message names only the offending path (operators need it); the
  // configured roots and the repo path stay in the debug log.
  private reject(
    rule: WorkspaceRule,
    offendingPath: string,
    context: {
      repoPath?: string;
      roots?: readonly string[];
      mount?: string;
    } = {},
  ): SupervisorError {
    this.log.debug(
      { rule, path: offendingPath, ...context },
      "workspace-rejected",
    );

    return new SupervisorError(
      "PRECONDITION",
      `workspace path rejected: ${rule} (${offendingPath})`,
      {
        details: {
          reason: "workspace_rejected",
          rule,
          ...(context.mount ? { mount: context.mount } : {}),
        },
      },
    );
  }

  private insideStateDir(real: string): boolean {
    const stateDir = this.opts.state.stateDirReal;

    return stateDir !== null && isUnderRoot(stateDir, real);
  }

  // The D7 kind matrix. Returns the realpath the handle is keyed on.
  private async validate(payload: AdoptWorkspacePayload): Promise<string> {
    const { kind } = payload;

    for (const candidate of [payload.path, payload.repoPath]) {
      if (candidate === undefined) continue;
      if (!path.isAbsolute(candidate)) {
        throw this.reject("relative_path", candidate);
      }
      if (hasParentSegment(candidate)) {
        throw this.reject("parent_segment", candidate);
      }
    }

    const real = await realpathOrNull(payload.path);

    if (!real) throw this.reject("not_found", payload.path);

    if (this.insideStateDir(real)) {
      throw this.reject("inside_state_dir", payload.path);
    }

    if (kind === "git_worktree" || kind === "directory") {
      const realUnderRoots = this.opts.roots.some((root) =>
        isUnderRoot(root, real),
      );

      if (!realUnderRoots) {
        const lexicalUnderRoots = this.opts.roots.some((root) =>
          isUnderRoot(root, path.resolve(payload.path)),
        );

        throw this.reject(
          lexicalUnderRoots ? "symlink_escape" : "outside_roots",
          payload.path,
          { roots: this.opts.roots },
        );
      }
    }

    if (kind === "git_worktree") {
      const repoPath = payload.repoPath as string;
      const repoReal = await realpathOrNull(repoPath);

      if (!repoReal || !(await isGitRepoRoot(repoReal))) {
        throw this.reject("not_a_repo", repoPath);
      }

      const gitdir = await worktreeGitdir(real);
      const gitdirReal = gitdir ? await realpathOrNull(gitdir) : null;
      const worktreesDir = path.join(repoReal, ".git", "worktrees");

      if (!gitdirReal || !isUnderRoot(worktreesDir, gitdirReal)) {
        throw this.reject("gitdir_mismatch", payload.path, { repoPath });
      }
    }

    if (kind === "repo_checkout") {
      const repoPath = payload.repoPath as string;

      if (!(await isGitRepoRoot(real))) {
        throw this.reject("not_a_repo", payload.path);
      }

      const repoReal = await realpathOrNull(repoPath);

      if (!repoReal || repoReal !== real) {
        throw this.reject("repo_path_mismatch", payload.path, { repoPath });
      }
    }

    return real;
  }

  // Every mount must be a git checkout the host can actually read; the stored
  // path is its realpath. Refusals carry the mount's slug.
  private async validateMounts(
    mounts: ContextMount[],
  ): Promise<ContextMount[]> {
    const resolved: ContextMount[] = [];

    for (const mount of mounts) {
      const context = { mount: mount.slug };

      if (!path.isAbsolute(mount.path)) {
        throw this.reject("relative_path", mount.path, context);
      }
      if (hasParentSegment(mount.path)) {
        throw this.reject("parent_segment", mount.path, context);
      }

      const real = await realpathOrNull(mount.path);

      if (!real || !(await isDirectory(real))) {
        throw this.reject("not_found", mount.path, context);
      }
      if (this.insideStateDir(real)) {
        throw this.reject("inside_state_dir", mount.path, context);
      }
      if (!(await isGitCheckout(real))) {
        throw this.reject("not_a_repo", mount.path, context);
      }

      resolved.push({ ...mount, path: real });
    }

    return resolved;
  }
}
