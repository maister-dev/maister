import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { ZodType } from "zod";
import type { ProjectAction } from "@/lib/authz";

import { randomUUID } from "node:crypto";

import { and, eq, inArray, isNull } from "drizzle-orm";
import pino from "pino";

import { systemCloseActiveAssignmentsForRun } from "@/lib/assignments/service";
import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { preserveWorktree, type PreserveResult } from "@/lib/gc/preserve";
import {
  promotionClaimTimeoutSeconds,
  worktreesRoot,
} from "@/lib/instance-config";
import { promoteNextPending } from "@/lib/scheduler";
import {
  deleteSession,
  listSessions,
  type SupervisorSessionRecord,
} from "@/lib/supervisor-client";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";
import {
  branchNameSchema,
  createBranchAtHead,
  headCommit,
  listRemotes,
  localBranchHead,
  pushBranch,
  remoteBranchHead,
  remoteNameSchema,
  removeOwnedWorktree,
  snapshotDirtyWorktree,
  statusPorcelain,
} from "@/lib/worktree";
import {
  deriveWorkbenchLifecycleActions,
  type WorkbenchLifecycleActionId,
  type WorkbenchRunStatus,
} from "@/lib/workbench-lifecycle/policy";

const { projects, runs, scratchRuns, workspaces } = schema;

const log = pino({
  name: "workbench-lifecycle",
  level: process.env.LOG_LEVEL ?? "info",
});

function db(): NodePgDatabase<typeof schema> {
  return getDb() as unknown as NodePgDatabase<typeof schema>;
}

type LifecycleAction = Extract<ProjectAction, "recoverRun" | "promoteRun">;
type LifecycleOperationState = "done" | "failed";

export type LifecycleOperationName =
  | "archive"
  | "drop"
  | "exportBranch"
  | "snapshotCommit"
  | "handoffBranch";

export type LifecycleOperationClaim = {
  attemptId: string;
};

export type LifecycleProject = {
  id: string;
  mainBranch: string;
};

export type LifecycleRun = {
  id: string;
  projectId: string;
  runKind: "flow" | "scratch" | "agent";
  status: WorkbenchRunStatus;
  acpSessionId: string | null;
  currentStepId: string | null;
};

export type LifecycleWorkspace = {
  id: string;
  runId: string;
  projectId: string;
  branch: string;
  worktreePath: string;
  parentRepoPath: string;
  removedAt: Date | null;
  archivedBranch: string | null;
  archivedAt: Date | null;
  baseBranch: string | null;
  baseCommit: string | null;
};

export type LifecycleContext = {
  project: LifecycleProject;
  run: LifecycleRun;
  workspace: LifecycleWorkspace | null;
};

export type RecordArchiveInput = {
  workspaceId: string;
  archivedBranch: string;
  archivedAt: Date;
};

export type RecordDropInput = {
  runId: string;
  runKind: "flow" | "scratch" | "agent";
  workspaceId: string;
  removedAt: Date;
  expectedRunStatus: WorkbenchRunStatus;
  nextRunStatus: WorkbenchRunStatus | null;
  archivedBranch: string | null;
  archivedAt: Date | null;
};

export type WorkbenchLifecycleDeps = {
  requireActiveSession: () => Promise<void>;
  loadContext: (runId: string) => Promise<LifecycleContext>;
  authorize: (projectId: string, action: LifecycleAction) => Promise<void>;
  listSessions: () => Promise<SupervisorSessionRecord[]>;
  deleteSession: (sessionId: string) => Promise<void>;
  markStoppedAndCloseAssignments: (args: {
    runId: string;
    endedAt: Date;
    reason: string;
  }) => Promise<void>;
  promoteNextPending: () => Promise<void>;
  preserveWorktree: (args: {
    worktreePath: string;
    parentRepoPath: string;
    branch: string;
    baseRef: string;
    runId: string;
  }) => Promise<PreserveResult>;
  recordArchive: (args: RecordArchiveInput) => Promise<void>;
  recordDrop: (args: RecordDropInput) => Promise<void>;
  removeOwnedWorktree: (args: {
    projectRepoPath: string;
    worktreePath: string;
    allowedRoot: string;
    force: boolean;
  }) => Promise<void>;
  worktreesRoot: () => string;
  statusPorcelain: (args: { worktreePath: string }) => Promise<string>;
  snapshotDirtyWorktree: (args: {
    worktreePath: string;
    commitMessage: string;
  }) => Promise<boolean>;
  pushBranch: (args: {
    projectRepoPath: string;
    remote: string;
    branch: string;
    force?: boolean;
  }) => Promise<void>;
  claimLifecycleOperation: (args: {
    runId: string;
    workspaceId: string;
    operation: LifecycleOperationName;
  }) => Promise<LifecycleOperationClaim>;
  finalizeLifecycleOperation: (args: {
    workspaceId: string;
    attemptId: string;
    state: LifecycleOperationState;
  }) => Promise<void>;
  listRemotes: (args: { projectRepoPath: string }) => Promise<string[]>;
  headCommit: (args: { worktreePath: string }) => Promise<string>;
  localBranchHead: (args: {
    projectRepoPath: string;
    branch: string;
  }) => Promise<string | null>;
  remoteBranchHead: (args: {
    projectRepoPath: string;
    remote: string;
    branch: string;
  }) => Promise<string | null>;
  createBranchAtHead: (args: {
    worktreePath: string;
    branch: string;
  }) => Promise<void>;
};

export type WorkbenchLifecycleOptions = {
  deps?: WorkbenchLifecycleDeps;
};

export type ArchiveWorkbenchResult = {
  ok: true;
  runId: string;
  archived: boolean;
  archivedBranch: string | null;
  snapshotted: boolean;
};

export type DropWorkbenchResult = {
  ok: true;
  runId: string;
  runStatus: WorkbenchRunStatus;
  workspaceRemoved: boolean;
  archivedBranch: string | null;
};

export type ExportWorkbenchBranchInput = {
  remote: string;
  snapshotDirty: boolean;
  commitMessage: string | null;
  force?: boolean;
};

export type ExportWorkbenchBranchResult = {
  ok: true;
  runId: string;
  branch: string;
  remote: string;
  pushedRef: string;
  snapshotCreated: boolean;
  checkoutCommands: string[];
};

export type StopFlowWorkbenchResult = {
  ok: true;
  runId: string;
  runStatus: "Review";
  supervisorStopped: boolean;
};

export type StopWorkbenchRunResult = {
  ok: true;
  runId: string;
  runStatus: "Review" | "Abandoned";
  supervisorStopped: boolean;
};

export type StopThenArchiveResult = ArchiveWorkbenchResult & {
  supervisorStopped: boolean;
};

export type StopThenDropResult = DropWorkbenchResult & {
  supervisorStopped: boolean;
};

export type HandoffMetadataResult = {
  ok: true;
  runId: string;
  branch: string;
  dirty: boolean;
  remotes: string[];
  defaultRemote: string | null;
  suggestedHandoffBranch: string;
  checkoutCommands: string[];
};

export type SnapshotWorkbenchCommitInput = {
  commitMessage: string;
};

export type SnapshotWorkbenchCommitResult = {
  ok: true;
  runId: string;
  branch: string;
  commit: string;
  snapshotCreated: boolean;
};

export type CreateWorkbenchHandoffBranchInput = {
  remote: string;
  handoffBranch: string;
};

export type CreateWorkbenchHandoffBranchResult = {
  ok: true;
  runId: string;
  branch: string;
  handoffBranch: string;
  remote: string;
  pushedRef: string;
  headCommit: string;
  checkoutCommands: string[];
};

const STOP_STATUSES: WorkbenchRunStatus[] = [
  "Running",
  "NeedsInput",
  "NeedsInputIdle",
];

const LIFECYCLE_RECLAIMABLE_STATES = new Set(["none", "failed"]);

function depsFromOptions(
  options: WorkbenchLifecycleOptions | undefined,
): WorkbenchLifecycleDeps {
  return options?.deps ?? defaultWorkbenchLifecycleDeps();
}

function isEnabled(
  ctx: LifecycleContext,
  id: WorkbenchLifecycleActionId,
): boolean {
  const action = deriveWorkbenchLifecycleActions({
    runKind: ctx.run.runKind,
    runStatus: ctx.run.status,
    scratchDialogStatus: null,
    hasWorkspace: ctx.workspace !== null,
    workspaceRemoved: ctx.workspace?.removedAt !== null,
    workspaceArchived: ctx.workspace?.archivedBranch !== null,
  }).find((candidate) => candidate.id === id);

  return action?.enabled === true;
}

function requireActionAllowed(
  ctx: LifecycleContext,
  id: WorkbenchLifecycleActionId,
): void {
  const action = deriveWorkbenchLifecycleActions({
    runKind: ctx.run.runKind,
    runStatus: ctx.run.status,
    scratchDialogStatus: null,
    hasWorkspace: ctx.workspace !== null,
    workspaceRemoved: ctx.workspace?.removedAt !== null,
    workspaceArchived: ctx.workspace?.archivedBranch !== null,
  }).find((candidate) => candidate.id === id);

  if (action?.enabled) return;

  throw new MaisterError(
    "PRECONDITION",
    `workbench action ${id} is not allowed for run ${ctx.run.id}: ${action?.disabledReason ?? "unknown"}`,
  );
}

function requireWorkspace(ctx: LifecycleContext): LifecycleWorkspace {
  if (ctx.workspace === null) {
    throw new MaisterError(
      "PRECONDITION",
      `workbench run ${ctx.run.id} has no workspace`,
    );
  }

  if (ctx.workspace.removedAt !== null) {
    throw new MaisterError(
      "PRECONDITION",
      `workbench run ${ctx.run.id} workspace was already removed`,
    );
  }

  return ctx.workspace;
}

function validateInput<T>(
  schema: ZodType<T>,
  value: unknown,
  fieldName: string,
): T {
  const parsed = schema.safeParse(value);

  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => issue.message)
      .join("; ");

    throw new MaisterError("PRECONDITION", `Invalid ${fieldName}: ${message}`);
  }

  return parsed.data;
}

function requireCommitMessage(commitMessage: string): string {
  const trimmed = commitMessage.trim();

  if (trimmed.length === 0 || trimmed.includes("\0")) {
    throw new MaisterError(
      "PRECONDITION",
      "commitMessage is required and must not contain NUL",
    );
  }

  return trimmed;
}

async function dirtyState(
  workspace: LifecycleWorkspace,
  deps: WorkbenchLifecycleDeps,
): Promise<boolean> {
  const porcelain = await deps.statusPorcelain({
    worktreePath: workspace.worktreePath,
  });

  return porcelain.trim() !== "";
}

function suggestedHandoffBranch(runId: string): string {
  return `maister/handoff/${runId}`;
}

function checkoutCommands(args: {
  projectRepoPath: string;
  remote: string;
  branch: string;
}): string[] {
  return [
    `git -C ${args.projectRepoPath} fetch ${args.remote} ${args.branch}`,
    `git -C ${args.projectRepoPath} switch --track ${args.remote}/${args.branch}`,
  ];
}

function defaultRemoteFor(remotes: string[]): string | null {
  if (remotes.includes("origin")) return "origin";

  return remotes[0] ?? null;
}

function canReclaimLifecycle(workspace: {
  lifecycleOperationState?: string | null;
  lifecycleOperationClaimedAt?: Date | null;
}): boolean {
  const state = workspace.lifecycleOperationState ?? "none";

  if (LIFECYCLE_RECLAIMABLE_STATES.has(state)) return true;

  if (state === "claiming") {
    const claimedAt = workspace.lifecycleOperationClaimedAt
      ? new Date(workspace.lifecycleOperationClaimedAt)
      : null;

    if (!claimedAt) return true;
    const cutoffMs = Date.now() - promotionClaimTimeoutSeconds() * 1000;

    return claimedAt.getTime() < cutoffMs;
  }

  return false;
}

function baseRefFor(
  ctx: LifecycleContext,
  workspace: LifecycleWorkspace,
): string {
  return workspace.baseCommit ?? workspace.baseBranch ?? ctx.project.mainBranch;
}

async function preservePresentWorkspace(
  runId: string,
  ctx: LifecycleContext,
  deps: WorkbenchLifecycleDeps,
): Promise<PreserveResult> {
  const workspace = requireWorkspace(ctx);
  const result = await deps.preserveWorktree({
    worktreePath: workspace.worktreePath,
    parentRepoPath: workspace.parentRepoPath,
    branch: workspace.branch,
    baseRef: baseRefFor(ctx, workspace),
    runId,
  });

  if (!result.ok) {
    throw new MaisterError(
      "CONFLICT",
      `could not preserve worktree for run ${runId}`,
    );
  }

  return result;
}

async function markLifecycleClaimFailed(args: {
  deps: WorkbenchLifecycleDeps;
  workspaceId: string;
  attemptId: string;
  err: unknown;
}): Promise<void> {
  if (
    args.err instanceof MaisterError &&
    args.err.code === "EXECUTOR_UNAVAILABLE"
  ) {
    return;
  }

  try {
    await args.deps.finalizeLifecycleOperation({
      workspaceId: args.workspaceId,
      attemptId: args.attemptId,
      state: "failed",
    });
  } catch (finalizeErr) {
    log.warn(
      {
        workspaceId: args.workspaceId,
        attemptId: args.attemptId,
        err:
          finalizeErr instanceof Error
            ? finalizeErr.message
            : String(finalizeErr),
      },
      "workbench lifecycle failure finalization failed",
    );
  }
}

async function recordArchiveIfCreated(
  workspace: LifecycleWorkspace,
  result: PreserveResult,
  deps: WorkbenchLifecycleDeps,
): Promise<string | null> {
  if (!result.archivedBranch) {
    return workspace.archivedBranch;
  }

  const archivedAt = result.archivedAt ?? new Date();

  await deps.recordArchive({
    workspaceId: workspace.id,
    archivedBranch: result.archivedBranch,
    archivedAt,
  });

  return result.archivedBranch;
}

export async function archiveWorkbench(
  runId: string,
  options?: WorkbenchLifecycleOptions,
): Promise<ArchiveWorkbenchResult> {
  const deps = depsFromOptions(options);

  await deps.requireActiveSession();

  const ctx = await deps.loadContext(runId);

  await deps.authorize(ctx.run.projectId, "recoverRun");

  return archiveWorkbenchForCtx(runId, ctx, deps);
}

async function archiveWorkbenchForCtx(
  runId: string,
  ctx: LifecycleContext,
  deps: WorkbenchLifecycleDeps,
): Promise<ArchiveWorkbenchResult> {
  requireActionAllowed(ctx, "archive");

  const workspace = requireWorkspace(ctx);
  const claim = await deps.claimLifecycleOperation({
    runId,
    workspaceId: workspace.id,
    operation: "archive",
  });

  try {
    const preserveResult = await preservePresentWorkspace(runId, ctx, deps);
    const archivedBranch = await recordArchiveIfCreated(
      workspace,
      preserveResult,
      deps,
    );

    await deps.finalizeLifecycleOperation({
      workspaceId: workspace.id,
      attemptId: claim.attemptId,
      state: "done",
    });

    return {
      ok: true,
      runId,
      archived: preserveResult.archivedBranch !== undefined,
      archivedBranch,
      snapshotted: preserveResult.snapshotted === true,
    };
  } catch (err) {
    await markLifecycleClaimFailed({
      deps,
      workspaceId: workspace.id,
      attemptId: claim.attemptId,
      err,
    });

    throw err;
  }
}

export async function getWorkbenchHandoffMetadata(
  runId: string,
  options?: WorkbenchLifecycleOptions,
): Promise<HandoffMetadataResult> {
  const deps = depsFromOptions(options);

  await deps.requireActiveSession();

  const ctx = await deps.loadContext(runId);

  await deps.authorize(ctx.run.projectId, "promoteRun");
  requireActionAllowed(ctx, "exportBranch");

  const workspace = requireWorkspace(ctx);
  const [dirty, remotes] = await Promise.all([
    dirtyState(workspace, deps),
    deps.listRemotes({ projectRepoPath: workspace.parentRepoPath }),
  ]);
  const defaultRemote = defaultRemoteFor(remotes);
  const suggestedBranch = suggestedHandoffBranch(runId);

  log.info(
    {
      runId,
      projectId: ctx.run.projectId,
      dirty,
      remoteCount: remotes.length,
      defaultRemote,
    },
    "workbench handoff metadata resolved",
  );

  return {
    ok: true,
    runId,
    branch: workspace.branch,
    dirty,
    remotes,
    defaultRemote,
    suggestedHandoffBranch: suggestedBranch,
    checkoutCommands: defaultRemote
      ? checkoutCommands({
          projectRepoPath: workspace.parentRepoPath,
          remote: defaultRemote,
          branch: suggestedBranch,
        })
      : [],
  };
}

export async function snapshotWorkbenchCommit(
  runId: string,
  args: SnapshotWorkbenchCommitInput & WorkbenchLifecycleOptions,
): Promise<SnapshotWorkbenchCommitResult> {
  const deps = depsFromOptions(args);

  await deps.requireActiveSession();

  const ctx = await deps.loadContext(runId);

  await deps.authorize(ctx.run.projectId, "promoteRun");
  requireActionAllowed(ctx, "exportBranch");

  const workspace = requireWorkspace(ctx);
  const commitMessage = requireCommitMessage(args.commitMessage);
  const dirty = await dirtyState(workspace, deps);

  if (!dirty) {
    throw new MaisterError(
      "PRECONDITION",
      `worktree is clean for run ${runId}`,
    );
  }

  const claim = await deps.claimLifecycleOperation({
    runId,
    workspaceId: workspace.id,
    operation: "snapshotCommit",
  });

  try {
    const snapshotCreated = await deps.snapshotDirtyWorktree({
      worktreePath: workspace.worktreePath,
      commitMessage,
    });
    const commit = await deps.headCommit({
      worktreePath: workspace.worktreePath,
    });

    await deps.finalizeLifecycleOperation({
      workspaceId: workspace.id,
      attemptId: claim.attemptId,
      state: "done",
    });

    log.info(
      {
        runId,
        projectId: ctx.run.projectId,
        branch: workspace.branch,
        commit,
        snapshotCreated,
      },
      "workbench snapshot commit completed",
    );

    return {
      ok: true,
      runId,
      branch: workspace.branch,
      commit,
      snapshotCreated,
    };
  } catch (err) {
    await deps.finalizeLifecycleOperation({
      workspaceId: workspace.id,
      attemptId: claim.attemptId,
      state: "failed",
    });

    throw err;
  }
}

export async function createWorkbenchHandoffBranch(
  runId: string,
  args: CreateWorkbenchHandoffBranchInput & WorkbenchLifecycleOptions,
): Promise<CreateWorkbenchHandoffBranchResult> {
  const deps = depsFromOptions(args);

  await deps.requireActiveSession();

  const ctx = await deps.loadContext(runId);

  await deps.authorize(ctx.run.projectId, "promoteRun");
  requireActionAllowed(ctx, "exportBranch");

  const workspace = requireWorkspace(ctx);
  const remote = validateInput(remoteNameSchema, args.remote, "remote");
  const handoffBranch = validateInput(
    branchNameSchema,
    args.handoffBranch,
    "branch",
  );
  const dirty = await dirtyState(workspace, deps);

  if (dirty) {
    throw new MaisterError(
      "PRECONDITION",
      `commit dirty work before handoff for run ${runId}`,
    );
  }

  const remotes = await deps.listRemotes({
    projectRepoPath: workspace.parentRepoPath,
  });

  if (!remotes.includes(remote)) {
    throw new MaisterError(
      "PRECONDITION",
      `remote does not exist for run ${runId}: ${remote}`,
    );
  }

  const head = await deps.headCommit({
    worktreePath: workspace.worktreePath,
  });
  const localHead = await deps.localBranchHead({
    projectRepoPath: workspace.parentRepoPath,
    branch: handoffBranch,
  });

  if (localHead !== null && localHead !== head) {
    throw new MaisterError(
      "CONFLICT",
      `local branch already exists at a different commit: ${handoffBranch}`,
    );
  }

  if (localHead === head) {
    log.info(
      {
        runId,
        projectId: ctx.run.projectId,
        handoffBranch,
        headCommit: head,
      },
      "[FIX:M27] workbench handoff local branch already matches head; reusing",
    );
  }

  const remoteHead = await deps.remoteBranchHead({
    projectRepoPath: workspace.parentRepoPath,
    remote,
    branch: handoffBranch,
  });

  if (remoteHead !== null && remoteHead !== head) {
    throw new MaisterError(
      "CONFLICT",
      `remote branch already exists at a different commit: ${remote}/${handoffBranch}`,
    );
  }

  if (remoteHead === head) {
    log.info(
      {
        runId,
        projectId: ctx.run.projectId,
        handoffBranch,
        remote,
        headCommit: head,
      },
      "[FIX:M27] workbench handoff remote branch already matches head; reusing",
    );
  }

  const claim = await deps.claimLifecycleOperation({
    runId,
    workspaceId: workspace.id,
    operation: "handoffBranch",
  });

  try {
    if (localHead === null) {
      await deps.createBranchAtHead({
        worktreePath: workspace.worktreePath,
        branch: handoffBranch,
      });
    }

    if (remoteHead === null) {
      await deps.pushBranch({
        projectRepoPath: workspace.parentRepoPath,
        remote,
        branch: handoffBranch,
      });
    }

    await deps.finalizeLifecycleOperation({
      workspaceId: workspace.id,
      attemptId: claim.attemptId,
      state: "done",
    });

    log.info(
      {
        runId,
        projectId: ctx.run.projectId,
        branch: workspace.branch,
        handoffBranch,
        remote,
        headCommit: head,
      },
      "workbench handoff branch ready",
    );

    return {
      ok: true,
      runId,
      branch: workspace.branch,
      handoffBranch,
      remote,
      pushedRef: `${remote}/${handoffBranch}`,
      headCommit: head,
      checkoutCommands: checkoutCommands({
        projectRepoPath: workspace.parentRepoPath,
        remote,
        branch: handoffBranch,
      }),
    };
  } catch (err) {
    if (err instanceof MaisterError && err.code === "EXECUTOR_UNAVAILABLE") {
      log.warn(
        {
          runId,
          projectId: ctx.run.projectId,
          branch: workspace.branch,
          handoffBranch,
          remote,
        },
        "workbench handoff push failed; lifecycle claim left retryable",
      );

      throw err;
    }

    await deps.finalizeLifecycleOperation({
      workspaceId: workspace.id,
      attemptId: claim.attemptId,
      state: "failed",
    });

    throw err;
  }
}

export async function dropWorkbench(
  runId: string,
  options?: WorkbenchLifecycleOptions,
): Promise<DropWorkbenchResult> {
  const deps = depsFromOptions(options);

  await deps.requireActiveSession();

  const ctx = await deps.loadContext(runId);

  await deps.authorize(ctx.run.projectId, "recoverRun");

  return dropWorkbenchForCtx(runId, ctx, deps);
}

async function dropWorkbenchForCtx(
  runId: string,
  ctx: LifecycleContext,
  deps: WorkbenchLifecycleDeps,
): Promise<DropWorkbenchResult> {
  requireActionAllowed(ctx, "drop");

  const workspace = requireWorkspace(ctx);
  const claim = await deps.claimLifecycleOperation({
    runId,
    workspaceId: workspace.id,
    operation: "drop",
  });

  try {
    const preserveResult = await preservePresentWorkspace(runId, ctx, deps);
    const archivedBranch =
      preserveResult.archivedBranch ?? workspace.archivedBranch;
    const archivedAt = preserveResult.archivedAt ?? workspace.archivedAt;

    await deps.removeOwnedWorktree({
      projectRepoPath: workspace.parentRepoPath,
      worktreePath: workspace.worktreePath,
      allowedRoot: deps.worktreesRoot(),
      force: true,
    });

    const nextRunStatus = ctx.run.status === "Done" ? null : "Abandoned";
    const removedAt = new Date();

    await deps.recordDrop({
      runId,
      runKind: ctx.run.runKind,
      workspaceId: workspace.id,
      removedAt,
      expectedRunStatus: ctx.run.status,
      nextRunStatus,
      archivedBranch,
      archivedAt,
    });
    await deps.finalizeLifecycleOperation({
      workspaceId: workspace.id,
      attemptId: claim.attemptId,
      state: "done",
    });

    return {
      ok: true,
      runId,
      runStatus: nextRunStatus ?? ctx.run.status,
      workspaceRemoved: true,
      archivedBranch,
    };
  } catch (err) {
    await markLifecycleClaimFailed({
      deps,
      workspaceId: workspace.id,
      attemptId: claim.attemptId,
      err,
    });

    throw err;
  }
}

export async function exportWorkbenchBranch(
  runId: string,
  args: ExportWorkbenchBranchInput & WorkbenchLifecycleOptions,
): Promise<ExportWorkbenchBranchResult> {
  const deps = depsFromOptions(args);

  await deps.requireActiveSession();

  const ctx = await deps.loadContext(runId);

  await deps.authorize(ctx.run.projectId, "promoteRun");
  requireActionAllowed(ctx, "exportBranch");

  const workspace = requireWorkspace(ctx);
  const remote = validateInput(remoteNameSchema, args.remote, "remote");
  const remotes = await deps.listRemotes({
    projectRepoPath: workspace.parentRepoPath,
  });

  if (!remotes.includes(remote)) {
    throw new MaisterError(
      "PRECONDITION",
      `remote does not exist for run ${runId}: ${remote}`,
    );
  }

  const porcelain = await deps.statusPorcelain({
    worktreePath: workspace.worktreePath,
  });
  const dirty = porcelain.trim() !== "";

  if (dirty && !args.snapshotDirty) {
    throw new MaisterError(
      "PRECONDITION",
      `dirty worktree for run ${runId}; enable snapshotDirty to export`,
    );
  }

  const commitMessage = dirty
    ? requireCommitMessage(args.commitMessage ?? "")
    : null;
  const claim = await deps.claimLifecycleOperation({
    runId,
    workspaceId: workspace.id,
    operation: "exportBranch",
  });

  try {
    let snapshotCreated = false;

    if (dirty) {
      if (commitMessage === null) {
        throw new MaisterError(
          "PRECONDITION",
          `commitMessage is required when snapshotDirty is true for run ${runId}`,
        );
      }

      snapshotCreated = await deps.snapshotDirtyWorktree({
        worktreePath: workspace.worktreePath,
        commitMessage,
      });
    }

    await deps.pushBranch({
      projectRepoPath: workspace.parentRepoPath,
      remote,
      branch: workspace.branch,
      force: args.force,
    });
    await deps.finalizeLifecycleOperation({
      workspaceId: workspace.id,
      attemptId: claim.attemptId,
      state: "done",
    });

    return {
      ok: true,
      runId,
      branch: workspace.branch,
      remote,
      pushedRef: `${remote}/${workspace.branch}`,
      snapshotCreated,
      checkoutCommands: [
        `git -C ${workspace.parentRepoPath} fetch ${remote} ${workspace.branch}`,
        `git -C ${workspace.parentRepoPath} switch ${workspace.branch}`,
      ],
    };
  } catch (err) {
    await markLifecycleClaimFailed({
      deps,
      workspaceId: workspace.id,
      attemptId: claim.attemptId,
      err,
    });

    throw err;
  }
}

export async function stopFlowWorkbench(
  runId: string,
  options?: WorkbenchLifecycleOptions,
): Promise<StopFlowWorkbenchResult> {
  const deps = depsFromOptions(options);

  await deps.requireActiveSession();

  const ctx = await deps.loadContext(runId);

  await deps.authorize(ctx.run.projectId, "recoverRun");

  if (ctx.run.runKind !== "flow") {
    throw new MaisterError(
      "PRECONDITION",
      `run is not a flow workbench: ${runId}`,
    );
  }

  return stopFlowAfterAuth(runId, ctx, deps);
}

async function stopLiveSupervisorSession(
  ctx: LifecycleContext,
  deps: WorkbenchLifecycleDeps,
): Promise<boolean> {
  if (!ctx.run.acpSessionId) return false;

  const sessions = await deps.listSessions();
  const live = sessions.find(
    (session) =>
      session.status === "live" &&
      session.acpSessionId === ctx.run.acpSessionId,
  );

  if (!live) return false;

  await deps.deleteSession(live.sessionId);

  return true;
}

async function stopFlowAfterAuth(
  runId: string,
  ctx: LifecycleContext,
  deps: WorkbenchLifecycleDeps,
): Promise<StopFlowWorkbenchResult> {
  if (!isEnabled(ctx, "stop")) {
    requireActionAllowed(ctx, "stop");
  }

  const supervisorStopped = await stopLiveSupervisorSession(ctx, deps);

  await deps.markStoppedAndCloseAssignments({
    runId,
    endedAt: new Date(),
    reason: "run stopped by operator",
  });

  try {
    await deps.promoteNextPending();
  } catch (err) {
    log.error(
      {
        runId,
        projectId: ctx.run.projectId,
        err: err instanceof Error ? err.message : String(err),
      },
      "promoteNextPending after workbench stop failed",
    );
  }

  return { ok: true, runId, runStatus: "Review", supervisorStopped };
}

async function stopAgentAfterAuth(
  runId: string,
  ctx: LifecycleContext,
  deps: WorkbenchLifecycleDeps,
): Promise<StopWorkbenchRunResult> {
  if (!isEnabled(ctx, "stop")) {
    requireActionAllowed(ctx, "stop");
  }

  // Imported lazily so this module's eval graph stays free of next-auth (pulled
  // transitively via authz) — the unit suite loads the real service module.
  const { finalizeAgentRun } = await import("@/lib/agents/launch");
  const { cleanupRunMaterializations } = await import(
    "@/lib/capabilities/cleanup"
  );

  // finalizeAgentRun flips status + nulls acpSessionId + frees the agent pool
  // slot, but it does NOT delete the supervisor session — kill it here.
  const supervisorStopped = await stopLiveSupervisorSession(ctx, deps);

  const finalize = await finalizeAgentRun(runId, "Abandoned", {
    reason: "operator",
    closeAssignments: { kind: "system", reason: "run stopped by operator" },
  });

  if (!finalize.finalized) {
    // The run reached a terminal status between auth and finalize (a lost CAS
    // race); the stop still reports ok because the outcome is identical, but
    // surface the no-op so operators can see this call was not the finalizer.
    log.info({ runId }, "agent stop finalize was a no-op (run already terminal)");
  }

  if (ctx.workspace && ctx.workspace.removedAt === null) {
    await cleanupRunMaterializations({
      runId,
      worktreePath: ctx.workspace.worktreePath,
      db: db(),
    });
  }

  return { ok: true, runId, runStatus: "Abandoned", supervisorStopped };
}

async function stopRunByKind(
  runId: string,
  ctx: LifecycleContext,
  deps: WorkbenchLifecycleDeps,
): Promise<StopWorkbenchRunResult> {
  switch (ctx.run.runKind) {
    case "flow": {
      const result = await stopFlowAfterAuth(runId, ctx, deps);

      return {
        ok: true,
        runId,
        runStatus: result.runStatus,
        supervisorStopped: result.supervisorStopped,
      };
    }
    case "scratch": {
      const { stopScratchWorkbench } = await import(
        "@/lib/scratch-runs/service"
      );
      const result = await stopScratchWorkbench(runId);

      return {
        ok: true,
        runId,
        runStatus: result.runStatus === "Review" ? "Review" : "Abandoned",
        supervisorStopped: result.supervisorStopped,
      };
    }
    case "agent":
      return stopAgentAfterAuth(runId, ctx, deps);
    default:
      throw new MaisterError(
        "PRECONDITION",
        `cannot stop run of kind ${ctx.run.runKind}: ${runId}`,
      );
  }
}

// POST /api/runs/{runId}/stop — generalized stop dispatched on run kind.
export async function stopWorkbenchRun(
  runId: string,
  options?: WorkbenchLifecycleOptions,
): Promise<StopWorkbenchRunResult> {
  const deps = depsFromOptions(options);

  await deps.requireActiveSession();

  const ctx = await deps.loadContext(runId);

  await deps.authorize(ctx.run.projectId, "recoverRun");

  return stopRunByKind(runId, ctx, deps);
}

// POST /api/runs/{runId}/stop-archive — flow + scratch. Stop commits the parked
// status first; an archive failure leaves the run in Review, retryable.
export async function stopThenArchive(
  runId: string,
  options?: WorkbenchLifecycleOptions,
): Promise<StopThenArchiveResult> {
  const deps = depsFromOptions(options);

  await deps.requireActiveSession();

  const ctx = await deps.loadContext(runId);

  await deps.authorize(ctx.run.projectId, "recoverRun");

  if (ctx.run.runKind !== "flow" && ctx.run.runKind !== "scratch") {
    throw new MaisterError(
      "PRECONDITION",
      `stop-archive supports flow and scratch runs only: ${runId}`,
    );
  }

  const stop = await stopRunByKind(runId, ctx, deps);
  const parkedCtx = await deps.loadContext(runId);
  const archive = await archiveWorkbenchForCtx(runId, parkedCtx, deps);

  return { ...archive, supervisorStopped: stop.supervisorStopped };
}

// POST /api/runs/{runId}/stop-drop — flow only. Scratch Stop & drop reuses the
// scratch /discard route.
export async function stopThenDrop(
  runId: string,
  options?: WorkbenchLifecycleOptions,
): Promise<StopThenDropResult> {
  const deps = depsFromOptions(options);

  await deps.requireActiveSession();

  const ctx = await deps.loadContext(runId);

  await deps.authorize(ctx.run.projectId, "recoverRun");

  if (ctx.run.runKind !== "flow") {
    throw new MaisterError(
      "PRECONDITION",
      `stop-drop supports flow runs only: ${runId}`,
    );
  }

  const stop = await stopFlowAfterAuth(runId, ctx, deps);
  const parkedCtx = await deps.loadContext(runId);
  const drop = await dropWorkbenchForCtx(runId, parkedCtx, deps);

  return { ...drop, supervisorStopped: stop.supervisorStopped };
}

function defaultWorkbenchLifecycleDeps(): WorkbenchLifecycleDeps {
  return {
    requireActiveSession: async () => {
      const { requireActiveSession } = await import("@/lib/authz");

      await requireActiveSession();
    },
    loadContext: loadLifecycleContext,
    authorize: async (projectId, action) => {
      const { requireProjectAction } = await import("@/lib/authz");

      await requireProjectAction(projectId, action);
    },
    listSessions,
    deleteSession,
    markStoppedAndCloseAssignments: markRunStoppedAndCloseAssignments,
    promoteNextPending: async () => {
      await promoteNextPending();
    },
    preserveWorktree,
    recordArchive,
    recordDrop,
    removeOwnedWorktree,
    worktreesRoot,
    statusPorcelain,
    snapshotDirtyWorktree,
    pushBranch,
    claimLifecycleOperation,
    finalizeLifecycleOperation,
    listRemotes,
    headCommit,
    localBranchHead,
    remoteBranchHead,
    createBranchAtHead,
  };
}

async function loadLifecycleContext(runId: string): Promise<LifecycleContext> {
  const client = db();
  const runRows = await client
    .select({
      id: runs.id,
      projectId: runs.projectId,
      runKind: runs.runKind,
      status: runs.status,
      acpSessionId: runs.acpSessionId,
      currentStepId: runs.currentStepId,
    })
    .from(runs)
    .where(eq(runs.id, runId));
  const run = runRows[0];

  if (!run) {
    throw new MaisterError("PRECONDITION", `run not found: ${runId}`);
  }

  const [projectRows, workspaceRows] = await Promise.all([
    client
      .select({
        id: projects.id,
        mainBranch: projects.mainBranch,
      })
      .from(projects)
      .where(eq(projects.id, run.projectId)),
    client
      .select({
        id: workspaces.id,
        runId: workspaces.runId,
        projectId: workspaces.projectId,
        branch: workspaces.branch,
        worktreePath: workspaces.worktreePath,
        parentRepoPath: workspaces.parentRepoPath,
        removedAt: workspaces.removedAt,
        archivedBranch: workspaces.archivedBranch,
        archivedAt: workspaces.archivedAt,
        baseBranch: workspaces.baseBranch,
        baseCommit: workspaces.baseCommit,
      })
      .from(workspaces)
      .where(eq(workspaces.runId, runId)),
  ]);
  const project = projectRows[0];

  if (!project) {
    throw new MaisterError(
      "PRECONDITION",
      `project not found for run ${runId}: ${run.projectId}`,
    );
  }

  return {
    project,
    run,
    workspace: workspaceRows[0] ?? null,
  };
}

async function recordArchive(args: RecordArchiveInput): Promise<void> {
  await db()
    .update(workspaces)
    .set({
      archivedBranch: args.archivedBranch,
      archivedAt: args.archivedAt,
    })
    .where(eq(workspaces.id, args.workspaceId));
}

export async function recordDrop(args: RecordDropInput): Promise<void> {
  await db().transaction(async (tx) => {
    const runRows = await tx
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, args.runId))
      .for("update");
    const run = runRows[0];

    if (!run) {
      throw new MaisterError(
        "PRECONDITION",
        `run not found while dropping workbench: ${args.runId}`,
      );
    }

    if (run.status !== args.expectedRunStatus) {
      log.warn(
        {
          runId: args.runId,
          expectedRunStatus: args.expectedRunStatus,
          actualRunStatus: run.status,
        },
        "[FIX:M27] workbench drop refused stale run status update",
      );

      throw new MaisterError(
        "CONFLICT",
        `run ${args.runId} changed status while dropping workbench`,
      );
    }

    const workspaceRows = await tx
      .update(workspaces)
      .set({
        removedAt: args.removedAt,
        archivedBranch: args.archivedBranch,
        archivedAt: args.archivedAt,
      })
      .where(
        and(
          eq(workspaces.id, args.workspaceId),
          eq(workspaces.runId, args.runId),
          isNull(workspaces.removedAt),
        ),
      )
      .returning({ id: workspaces.id });

    if (workspaceRows.length === 0) {
      throw new MaisterError(
        "PRECONDITION",
        `workspace not found or already removed while dropping workbench: ${args.workspaceId}`,
      );
    }

    if (args.nextRunStatus !== null) {
      const updatedRunRows = await tx
        .update(runs)
        .set({
          status: args.nextRunStatus,
          acpSessionId: null,
          currentStepId: null,
          endedAt: args.removedAt,
        })
        .where(eq(runs.id, args.runId))
        .returning({
          id: runs.id,
          projectId: runs.projectId,
          taskId: runs.taskId,
          flowId: runs.flowId,
          runKind: runs.runKind,
        });

      if (updatedRunRows.length === 0) {
        throw new MaisterError(
          "PRECONDITION",
          `run not found while updating drop status: ${args.runId}`,
        );
      }

      if (args.runKind === "scratch") {
        const scratchRows = await tx
          .update(scratchRuns)
          .set({
            dialogStatus: "Abandoned",
            supervisorSessionId: null,
            updatedAt: args.removedAt,
          })
          .where(eq(scratchRuns.runId, args.runId))
          .returning({ runId: scratchRuns.runId });

        if (scratchRows.length === 0) {
          throw new MaisterError(
            "PRECONDITION",
            `scratch run row not found while dropping workbench: ${args.runId}`,
          );
        }
      }

      if (args.nextRunStatus === "Abandoned") {
        await emitWebhookEvent({
          db: tx,
          type: "run.abandoned",
          projectId: updatedRunRows[0].projectId,
          runId: args.runId,
          data: { source: "workbench" },
        });
        await emitDomainEvent({
          db: tx,
          kind: "run.abandoned",
          projectId: updatedRunRows[0].projectId,
          runId: args.runId,
          taskId: updatedRunRows[0].taskId,
          actor: { type: "system", id: null },
          payload: {
            runId: args.runId,
            taskId: updatedRunRows[0].taskId,
            flowId: updatedRunRows[0].flowId,
            runKind: updatedRunRows[0].runKind,
            reason: "workbench",
          },
        });
      } else if (args.nextRunStatus === "Review") {
        await emitWebhookEvent({
          db: tx,
          type: "run.review",
          projectId: updatedRunRows[0].projectId,
          runId: args.runId,
          data: { source: "workbench" },
        });
      }
    }
  });
}

async function markRunStoppedAndCloseAssignments(args: {
  runId: string;
  endedAt: Date;
  reason: string;
}): Promise<void> {
  await db().transaction(async (tx) => {
    const rows = await tx
      .update(runs)
      .set({
        status: "Review",
        acpSessionId: null,
        currentStepId: null,
        endedAt: args.endedAt,
      })
      .where(and(eq(runs.id, args.runId), inArray(runs.status, STOP_STATUSES)))
      .returning({ id: runs.id, projectId: runs.projectId });

    if (rows.length === 0) {
      throw new MaisterError(
        "CONFLICT",
        `run ${args.runId} was not in a stoppable state`,
      );
    }

    await systemCloseActiveAssignmentsForRun({
      db: tx,
      runId: args.runId,
      reason: args.reason,
    });

    await emitWebhookEvent({
      db: tx,
      type: "run.review",
      projectId: rows[0].projectId,
      runId: args.runId,
      data: { source: "workbench" },
    });
  });
}

export async function claimLifecycleOperation(args: {
  runId: string;
  workspaceId: string;
  operation: LifecycleOperationName;
}): Promise<LifecycleOperationClaim> {
  return db().transaction(async (tx) => {
    const rows = await tx
      .select({
        id: workspaces.id,
        lifecycleOperationState: workspaces.lifecycleOperationState,
        lifecycleOperationClaimedAt: workspaces.lifecycleOperationClaimedAt,
      })
      .from(workspaces)
      .where(eq(workspaces.id, args.workspaceId))
      .for("update");
    const workspace = rows[0];

    if (!workspace) {
      throw new MaisterError(
        "PRECONDITION",
        `workspace not found for lifecycle operation: ${args.workspaceId}`,
      );
    }

    if (!canReclaimLifecycle(workspace)) {
      throw new MaisterError(
        "CONFLICT",
        `lifecycle operation already in progress for run ${args.runId}`,
      );
    }

    const attemptId = randomUUID();

    await tx
      .update(workspaces)
      .set({
        lifecycleOperationState: "claiming",
        lifecycleOperationClaimedAt: new Date(),
        lifecycleOperationAttemptId: attemptId,
        lifecycleOperationName: args.operation,
      })
      .where(eq(workspaces.id, args.workspaceId));

    log.debug(
      {
        runId: args.runId,
        workspaceId: args.workspaceId,
        operation: args.operation,
        attemptId,
      },
      "workbench lifecycle operation claimed",
    );

    return { attemptId };
  });
}

export async function finalizeLifecycleOperation(args: {
  workspaceId: string;
  attemptId: string;
  state: LifecycleOperationState;
}): Promise<void> {
  const update =
    args.state === "done"
      ? {
          lifecycleOperationState: "none",
          lifecycleOperationClaimedAt: null,
          lifecycleOperationAttemptId: null,
          lifecycleOperationName: null,
        }
      : {
          lifecycleOperationState: "failed",
          lifecycleOperationClaimedAt: null,
          lifecycleOperationAttemptId: args.attemptId,
          lifecycleOperationName: null,
        };

  const rows = await db()
    .update(workspaces)
    .set(update)
    .where(
      and(
        eq(workspaces.id, args.workspaceId),
        eq(workspaces.lifecycleOperationAttemptId, args.attemptId),
      ),
    )
    .returning({ id: workspaces.id });

  if (rows.length === 0) {
    throw new MaisterError(
      "CONFLICT",
      `lifecycle operation claim lost for workspace ${args.workspaceId}`,
    );
  }

  log.debug(
    {
      workspaceId: args.workspaceId,
      attemptId: args.attemptId,
      state: args.state,
    },
    "workbench lifecycle operation finalized",
  );
}
