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
// feeds spawn (cwd + step log), prompt confinement, cost, and the events log.

export type WorkspaceResolution = {
  executionWorkspaceId?: string;
  runId: string;
  projectSlug: string;
  cwd: string;
  repoPath?: string;
  confineRoot?: string;
  runDir: string;
  logPath: string;
  eventsLogPath: string;
  costPath: string;
  contextMounts?: ContextMount[];
};

export type ResolveForSessionInput = {
  stepId: string;
  capabilityProfilePath?: string;
};

function runDirFor(runtimeRoot: string, projectSlug: string, runId: string) {
  return path.resolve(runtimeRoot, ".maister", projectSlug, "runs", runId);
}

function runPaths(runDir: string, stepId: string) {
  return {
    logPath: path.join(runDir, `${stepId}.log`),
    eventsLogPath: path.join(runDir, "run.events.jsonl"),
    costPath: path.join(runDir, "cost.jsonl"),
  };
}

function rejected(rule: WorkspaceRule, detail: string): SupervisorError {
  return new SupervisorError(
    "PRECONDITION",
    `workspace path rejected: ${rule} (${detail})`,
    { details: { reason: "workspace_rejected", rule } },
  );
}

async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

async function isGitRepoRoot(p: string): Promise<boolean> {
  try {
    await stat(path.join(p, ".git"));

    return true;
  } catch {
    return false;
  }
}

// A linked worktree's `.git` is a FILE `gitdir: <path>` that resolves under
// `<repo>/.git/worktrees/`. A directory `.git` is a repo root, not a worktree.
async function worktreeGitdir(worktree: string): Promise<string | null> {
  const dotGit = path.join(worktree, ".git");

  try {
    const st = await lstat(dotGit);

    if (!st.isFile()) return null;
  } catch {
    return null;
  }

  const content = await readFile(dotGit, "utf8");
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(content);

  if (!match) return null;

  const target = match[1];

  return path.isAbsolute(target) ? target : path.resolve(worktree, target);
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
      contextMounts: payload.contextMounts ?? null,
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

    if (input.capabilityProfilePath) {
      const relative = path.relative(
        path.resolve(handle.path),
        path.resolve(input.capabilityProfilePath),
      );

      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw rejected(
          "outside_workspace",
          "capabilityProfilePath must resolve inside the workspace",
        );
      }
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

  // The D7 kind matrix. Returns the realpath the handle is keyed on.
  private async validate(payload: AdoptWorkspacePayload): Promise<string> {
    const { kind } = payload;

    for (const candidate of [payload.path, payload.repoPath]) {
      if (candidate === undefined) continue;
      if (!path.isAbsolute(candidate)) {
        throw rejected("relative_path", candidate);
      }
      if (candidate.split(path.sep).includes("..")) {
        throw rejected("parent_segment", candidate);
      }
    }

    const real = await realpathOrNull(payload.path);

    if (!real) throw rejected("not_found", payload.path);

    const stateDir = this.opts.state.stateDir;

    if (stateDir && isUnderRoot(stateDir, real)) {
      throw rejected("inside_state_dir", payload.path);
    }

    if (kind === "git_worktree" || kind === "directory") {
      const realUnderRoots = this.opts.roots.some((root) =>
        isUnderRoot(root, real),
      );

      if (!realUnderRoots) {
        const lexicalUnderRoots = this.opts.roots.some((root) =>
          isUnderRoot(root, path.resolve(payload.path)),
        );

        throw rejected(
          lexicalUnderRoots ? "symlink_escape" : "outside_roots",
          `${payload.path} is not under ${this.opts.roots.join(":")}`,
        );
      }
    }

    if (kind === "git_worktree") {
      const repoReal = await realpathOrNull(payload.repoPath as string);

      if (!repoReal || !(await isGitRepoRoot(repoReal))) {
        throw rejected("not_a_repo", payload.repoPath as string);
      }

      const gitdir = await worktreeGitdir(real);
      const gitdirReal = gitdir ? await realpathOrNull(gitdir) : null;
      const worktreesDir = path.join(repoReal, ".git", "worktrees");

      if (!gitdirReal || !isUnderRoot(worktreesDir, gitdirReal)) {
        throw rejected(
          "gitdir_mismatch",
          `${payload.path} is not a linked worktree of ${payload.repoPath}`,
        );
      }
    }

    if (kind === "repo_checkout") {
      if (!(await isGitRepoRoot(real))) {
        throw rejected("not_a_repo", payload.path);
      }

      const repoReal = await realpathOrNull(payload.repoPath as string);

      if (!repoReal || repoReal !== real) {
        throw rejected(
          "repo_path_mismatch",
          `${payload.path} is not the repo root ${payload.repoPath}`,
        );
      }
    }

    return real;
  }
}
