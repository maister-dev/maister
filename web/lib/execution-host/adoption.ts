import type { Db } from "./db";
import type { ContextMountSnapshot } from "@/lib/context-mounts/types";
import type { ExecutionAssignment } from "@/lib/db/schema";
import type { AdoptWorkspaceResult, AdoptWorkspaceWire } from "./contracts";
import type { ExecutionWorkspaceId } from "./types";

import { stat } from "node:fs/promises";

import { eq } from "drizzle-orm";
import pino, { type Logger } from "pino";

import { asExecutionWorkspaceId } from "./types";

import { localPackages, projects, runs, workspaces } from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";

const defaultLog = pino({
  name: "execution-host",
  level: process.env.LOG_LEVEL ?? "info",
}).child({ component: "adoption" });

export type WorkspaceSpecInput = {
  run: {
    id: string;
    runKind: "flow" | "scratch" | "agent";
    agentWorkspace: "none" | "repo_read" | "worktree" | null;
    localPackageId: string | null;
    contextMounts: ContextMountSnapshot[] | null;
    rootRunId: string | null;
    workspaceMode: "own" | "shared" | null;
  };
  project: { slug: string; repoPath: string };
  workspace: { worktreePath: string; parentRepoPath: string } | null;
  localPackage: { workingDir: string } | null;
  agentPaths: {
    workdir: string;
    readOnlyWorkdir: string;
    sharedWorktree: string | null;
  };
  ephemeralReadOnlyCheckoutExists: boolean;
};

function missingWorkspace(runId: string, what: string): MaisterError {
  return new MaisterError(
    "PRECONDITION",
    `run ${runId} has no ${what} to adopt as its execution workspace`,
    { details: { reason: "workspace_missing", runId } },
  );
}

// ADR-166 D7: the ONE kind-mapping from a run's durable rows to the adopt
// payload. Pure — the integration cases K1–K4 exercise every branch through
// the real loader; no duplicate unit test.
export function workspaceSpecFor(
  input: WorkspaceSpecInput,
): AdoptWorkspaceWire {
  const { run, project } = input;
  const mounts =
    run.contextMounts && run.contextMounts.length > 0
      ? { contextMounts: run.contextMounts }
      : {};
  const base = { runId: run.id, projectSlug: project.slug, ...mounts };

  if (run.localPackageId) {
    if (!input.localPackage) throw missingWorkspace(run.id, "local package");

    return { ...base, kind: "directory", path: input.localPackage.workingDir };
  }

  if (run.runKind === "flow" || run.runKind === "scratch") {
    if (!input.workspace) throw missingWorkspace(run.id, "workspace row");

    return {
      ...base,
      kind: "git_worktree",
      path: input.workspace.worktreePath,
      repoPath: project.repoPath,
    };
  }

  switch (run.agentWorkspace) {
    case "worktree": {
      const path =
        input.workspace?.worktreePath ??
        (run.workspaceMode === "shared" && input.agentPaths.sharedWorktree
          ? input.agentPaths.sharedWorktree
          : input.agentPaths.workdir);

      return {
        ...base,
        kind: "git_worktree",
        path,
        repoPath: project.repoPath,
      };
    }
    case "repo_read":
      // The `workspace_ref` variant is a DETACHED LINKED WORKTREE of the repo
      // (`addDetachedWorktree`), so it adopts as `git_worktree`; the plain
      // variant is the project checkout itself.
      return input.ephemeralReadOnlyCheckoutExists
        ? {
            ...base,
            kind: "git_worktree",
            path: input.agentPaths.readOnlyWorkdir,
            repoPath: project.repoPath,
          }
        : {
            ...base,
            kind: "repo_checkout",
            path: project.repoPath,
            repoPath: project.repoPath,
          };
    default:
      return { ...base, kind: "directory", path: input.agentPaths.workdir };
  }
}

async function pathIsDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export async function loadWorkspaceSpecInput(
  db: Db,
  runId: string,
): Promise<WorkspaceSpecInput> {
  const [run] = await db
    .select({
      id: runs.id,
      runKind: runs.runKind,
      agentWorkspace: runs.agentWorkspace,
      localPackageId: runs.localPackageId,
      contextMounts: runs.contextMounts,
      rootRunId: runs.rootRunId,
      workspaceMode: runs.workspaceMode,
      projectId: runs.projectId,
    })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);

  if (!run) {
    throw new MaisterError("PRECONDITION", `run ${runId} not found`, {
      details: { reason: "run_missing", runId },
    });
  }
  let localPackage: { slug: string; workingDir: string } | null = null;

  if (run.localPackageId) {
    const [row] = await db
      .select({
        slug: localPackages.slug,
        workingDir: localPackages.workingDir,
      })
      .from(localPackages)
      .where(eq(localPackages.id, run.localPackageId))
      .limit(1);

    localPackage = row ?? null;
  }

  // ADR-097: a local-package assistant run has NO project — the package is its
  // runtime identity (its slug names the runtime subtree, its working dir is
  // the adopted directory).
  let project: { slug: string; repoPath: string } | null = null;

  if (run.projectId) {
    const [row] = await db
      .select({ slug: projects.slug, repoPath: projects.repoPath })
      .from(projects)
      .where(eq(projects.id, run.projectId))
      .limit(1);

    project = row ?? null;
  } else if (localPackage) {
    project = { slug: localPackage.slug, repoPath: localPackage.workingDir };
  }

  if (!project) throw missingWorkspace(runId, "project");

  const workspaceFor = async (ownerRunId: string) => {
    const [row] = await db
      .select({
        worktreePath: workspaces.worktreePath,
        parentRepoPath: workspaces.parentRepoPath,
      })
      .from(workspaces)
      .where(eq(workspaces.runId, ownerRunId))
      .limit(1);

    return row ?? null;
  };
  let workspace = await workspaceFor(runId);

  if (!workspace && run.workspaceMode === "shared" && run.rootRunId) {
    workspace = await workspaceFor(run.rootRunId);
  }

  // Dynamic on purpose: `agents/launch` is a large module that will itself
  // address execution through this package (Phase 4) — a static edge here
  // would close an import cycle.
  const {
    agentWorkdirPath,
    agentReadOnlyWorkdirPath,
    sharedAgentWorktreePath,
  } = await import("@/lib/agents/launch");
  const readOnlyWorkdir = agentReadOnlyWorkdirPath(project.slug, runId);

  return {
    run: {
      id: run.id,
      runKind: run.runKind,
      agentWorkspace: run.agentWorkspace,
      localPackageId: run.localPackageId,
      contextMounts: run.contextMounts,
      rootRunId: run.rootRunId,
      workspaceMode: run.workspaceMode,
    },
    project,
    workspace,
    localPackage,
    agentPaths: {
      workdir: agentWorkdirPath(project.slug, runId),
      readOnlyWorkdir,
      sharedWorktree: run.rootRunId
        ? sharedAgentWorktreePath(project.slug, run.rootRunId)
        : null,
    },
    ephemeralReadOnlyCheckoutExists:
      run.runKind === "agent" && run.agentWorkspace === "repo_read"
        ? await pathIsDirectory(readOnlyWorkdir)
        : false,
  };
}

export function isUnknownWorkspaceError(err: unknown): boolean {
  return (
    isMaisterError(err) &&
    err.code === "PRECONDITION" &&
    err.details?.reason === "unknown_workspace"
  );
}

// The host no longer honours the handle the assignment carries — its store was
// wiped (`unknown_workspace`) or the handle was released after the worktree
// was removed and re-created at the same path (`workspace_released`, the
// ADR-141 reopen). Either way ONE fresh adoption is the remedy.
export function isReadoptableWorkspaceError(err: unknown): boolean {
  return (
    isMaisterError(err) &&
    err.code === "PRECONDITION" &&
    (err.details?.reason === "unknown_workspace" ||
      err.details?.reason === "workspace_released")
  );
}

export type AdoptingClient = {
  readonly assignment: ExecutionAssignment;
  adoptWorkspace(spec: AdoptWorkspaceWire): Promise<AdoptWorkspaceResult>;
};

// ADR-166 E-EH-08: adopt ONCE per assignment — the stored handle short-circuits
// the wire; `force` re-adopts after the host refused the stored handle
// (`isReadoptableWorkspaceError`). The client persists the handle in the ack
// transaction.
export async function ensureWorkspaceAdopted(args: {
  db: Db;
  client: AdoptingClient;
  force?: boolean;
  logger?: Logger;
}): Promise<ExecutionWorkspaceId> {
  const logger = args.logger ?? defaultLog;
  const current = args.client.assignment;

  if (!args.force && current.executionWorkspaceId) {
    return asExecutionWorkspaceId(current.executionWorkspaceId);
  }

  const spec = workspaceSpecFor(
    await loadWorkspaceSpecInput(args.db, current.runId),
  );
  const result = await args.client.adoptWorkspace(spec);

  logger.info(
    {
      runId: current.runId,
      assignmentId: current.id,
      assignmentEpoch: current.epoch,
      executionWorkspaceId: result.executionWorkspaceId,
      workspaceKind: result.kind,
      replayed: result.replayed,
      readopted: args.force === true,
    },
    "workspace-adopted",
  );

  return result.executionWorkspaceId;
}
