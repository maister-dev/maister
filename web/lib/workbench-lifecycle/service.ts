import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { ZodType } from "zod";
import { RELEASED_LIFECYCLE_CLAIM } from "@/lib/runs/lifecycle-claim";
import type { Db as ExecutionDb } from "@/lib/execution-host/db";
import type { ProjectAction } from "@/lib/authz";
import type {
  WorkspacePreservationOutcome,
  WorkspaceRemovalKind,
} from "@/lib/db/schema";

import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";

import { and, eq, gt, inArray, isNull, notInArray } from "drizzle-orm";
import pino from "pino";

import { systemCloseActiveAssignmentsForRun } from "@/lib/assignments/service";
import {
  REVIEW_REWORK_CLAIM_DECISION,
  getActiveTakeover,
} from "@/lib/flows/graph/ledger";
import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { emitDelegatedReviewIfChild } from "@/lib/runs/delegated-review-emit";
import { requireRunProjectId } from "@/lib/runs/run-kind-invariants";
import { DISPOSABLE_WORKSPACE_RUN_STATUSES } from "@/lib/runs/run-status-sets";
import {
  ABANDONABLE_STATUSES,
  markAbandoned,
} from "@/lib/runs/state-transitions";
import { preserveWorktree, type PreserveResult } from "@/lib/gc/preserve";
import {
  promotionClaimTimeoutSeconds,
  worktreesRoot,
} from "@/lib/instance-config";
import { promoteNextPending } from "@/lib/scheduler";
import {
  createExecutionHosts,
  releaseAssignmentForRun,
  type ExecutionHosts,
} from "@/lib/execution-host";
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
  | "discard"
  | "retention_gc"
  | "reconciliation"
  | "exportBranch"
  | "snapshotCommit"
  | "handoffBranch"
  // ADR-141: branch sync claims the SAME workspace lifecycle slot, so it is
  // mutually exclusive with the other five (and with a concurrent sync) for free.
  | "sync";

export type LifecycleOperationClaim = {
  attemptId: string;
  leaseExpiresAt?: Date;
};

export type LifecycleProject = {
  id: string;
  mainBranch: string;
};

export type LifecycleRun = {
  id: string;
  projectId: string;
  // M37 (ADR-098): the launching task (null for scratch / as-run children) —
  // the orchestrator cascade marks un-launched as-plan child tasks Abandoned.
  taskId: string | null;
  runKind: "flow" | "scratch" | "agent";
  status: WorkbenchRunStatus;
  currentStepId: string | null;
  workspaceMode?: "own" | "shared" | null;
  agentWorkspace?: "none" | "repo_read" | "worktree" | null;
  rootRunId?: string | null;
  // ADR-163: a delegated child (set) takes the coordinator's cancel-to-Abandoned
  // path on the token surface; a top-level run (null) never does.
  parentRunId?: string | null;
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
  archivedCommit?: string | null;
  preservationOutcome?: WorkspacePreservationOutcome | null;
  removalKind?: WorkspaceRemovalKind | null;
  baseBranch: string | null;
  baseCommit: string | null;
};

export type LifecycleContext = {
  project: LifecycleProject;
  run: LifecycleRun;
  workspace: LifecycleWorkspace | null;
  // ADR-160: `owner_user_id` of an OPEN rework claim on this run
  // (`node_attempts.decision = 'review_rework_claim'`, `ended_at IS NULL`),
  // else null. An M11b takeover leaves it null and opens no carve-out.
  reworkClaimOwnerUserId?: string | null;
  // The acting user, for the owner comparison in the policy.
  viewerUserId?: string | null;
};

export type RecordArchiveInput = {
  database?: NodePgDatabase<typeof schema>;
  workspaceId: string;
  attemptId: string;
  archivedBranch: string | null;
  archivedAt: Date;
  archivedCommit: string | null;
  preservationOutcome: Exclude<WorkspacePreservationOutcome, "legacy_unknown">;
};

export type RecordDropInput = {
  database?: NodePgDatabase<typeof schema>;
  runId: string;
  runKind: "flow" | "scratch" | "agent";
  workspaceId: string;
  removedAt: Date;
  expectedRunStatus: WorkbenchRunStatus;
  nextRunStatus: WorkbenchRunStatus | null;
  archivedBranch: string | null;
  archivedAt: Date | null;
  archivedCommit: string | null;
  preservationOutcome: Exclude<WorkspacePreservationOutcome, "legacy_unknown">;
  removalKind: Exclude<WorkspaceRemovalKind, "legacy">;
  attemptId: string;
};

export type WorkbenchLifecycleDeps = {
  // Returns the authenticated user when the binding has one. ADR-160 uses it
  // as the `viewerUserId` for the lifecycle owner carve-out, so the session is
  // read exactly once, at the boundary that already authenticates.
  requireActiveSession: () => Promise<{ id: string } | void>;
  loadContext: (runId: string) => Promise<LifecycleContext>;
  authorize: (projectId: string, action: LifecycleAction) => Promise<void>;
  // ADR-164: the host the stop tears live sessions down through (a fenced
  // `session.delete` under the run's newest assignment).
  executionHosts: ExecutionHosts;
  markStoppedAndCloseAssignments: (args: {
    runId: string;
    endedAt: Date;
    reason: string;
  }) => Promise<void>;
  promoteNextPending: () => Promise<void>;
  finalizeAgentRun: (args: {
    runId: string;
    reason: string;
  }) => Promise<{ finalized: boolean }>;
  cleanupAgentMaterializations: (args: {
    runId: string;
    worktreePath: string;
  }) => Promise<void>;
  stopScratchWorkbench: (runId: string) => Promise<{
    runStatus: WorkbenchRunStatus;
    supervisorStopped: boolean;
  }>;
  assertWorkspaceRemovalAllowed: (args: {
    run: LifecycleRun;
    workspace: LifecycleWorkspace;
  }) => Promise<void>;
  preserveWorktree: (args: {
    worktreePath: string;
    parentRepoPath: string;
    branch: string;
    baseRef: string;
    runId: string;
  }) => Promise<PreserveResult>;
  worktreeExists: (worktreePath: string) => Promise<boolean>;
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
    expectedRunStatus: WorkbenchRunStatus;
  }) => Promise<LifecycleOperationClaim>;
  renewLifecycleOperationLease: (args: {
    workspaceId: string;
    attemptId: string;
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
  // M37 (ADR-098) T7.4: when the run is a flow orchestrator (WaitingOnChildren
  // OR with run-tree children), abandon its sub-tree before the orchestrator
  // itself is stopped/dropped. Injectable so the unit suite (DB-less, dep-mocked)
  // never reaches the real run-tree query.
  cascadeOrchestratorIfNeeded: (run: LifecycleRun) => Promise<void>;
};

export type WorkbenchLifecycleOptions = {
  deps?: WorkbenchLifecycleDeps;
  allowPausedBudgetRun?: boolean;
};

export type ArchiveWorkbenchResult = {
  ok: true;
  runId: string;
  operation: "archive";
  runStatus: WorkbenchRunStatus;
  workspaceRemoved: true;
  idempotent: boolean;
  preservationOutcome: Exclude<WorkspacePreservationOutcome, "legacy_unknown">;
  archived: boolean;
  archivedBranch: string | null;
  snapshotted: boolean;
};

export type DropWorkbenchResult = {
  ok: true;
  runId: string;
  operation: "drop" | "discard";
  runStatus: WorkbenchRunStatus;
  workspaceRemoved: true;
  idempotent: boolean;
  preservationOutcome: Exclude<WorkspacePreservationOutcome, "legacy_unknown">;
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

export function isCleanWorkbenchPrecondition(err: unknown): boolean {
  return (
    err instanceof MaisterError &&
    err.code === "PRECONDITION" &&
    err.details?.reason === "clean_worktree"
  );
}

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
    claimOwnerUserId: ctx.reworkClaimOwnerUserId ?? null,
    viewerUserId: ctx.viewerUserId ?? null,
  }).find((candidate) => candidate.id === id);

  return action?.enabled === true;
}

function requireActionAllowed(
  ctx: LifecycleContext,
  id: WorkbenchLifecycleActionId,
  options?: { allowPausedBudgetRun?: boolean },
): void {
  const action = deriveWorkbenchLifecycleActions({
    runKind: ctx.run.runKind,
    runStatus: ctx.run.status,
    scratchDialogStatus: null,
    hasWorkspace: ctx.workspace !== null,
    workspaceRemoved: ctx.workspace?.removedAt !== null,
    workspaceArchived: ctx.workspace?.archivedBranch !== null,
    claimOwnerUserId: ctx.reworkClaimOwnerUserId ?? null,
    viewerUserId: ctx.viewerUserId ?? null,
  }).find((candidate) => candidate.id === id);

  if (action?.enabled) return;

  if (
    options?.allowPausedBudgetRun === true &&
    (ctx.run.status === "NeedsInput" || ctx.run.status === "NeedsInputIdle") &&
    id !== "stop" &&
    ctx.workspace !== null &&
    ctx.workspace.removedAt === null
  ) {
    return;
  }

  throw new MaisterError(
    "PRECONDITION",
    `workbench action ${id} is not allowed for run ${ctx.run.id}: ${action?.disabledReason ?? "unknown"}`,
  );
}

function requireWorkspaceRecord(ctx: LifecycleContext): LifecycleWorkspace {
  if (ctx.workspace === null) {
    throw new MaisterError(
      "PRECONDITION",
      `workbench run ${ctx.run.id} has no workspace`,
    );
  }

  return ctx.workspace;
}

function requireWorkspace(ctx: LifecycleContext): LifecycleWorkspace {
  const workspace = requireWorkspaceRecord(ctx);

  if (workspace.removedAt !== null) {
    throw new MaisterError(
      "PRECONDITION",
      `workbench run ${ctx.run.id} workspace was already removed`,
    );
  }

  return workspace;
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
  lifecycleOperationLeaseExpiresAt?: Date | null;
}): boolean {
  const state = workspace.lifecycleOperationState ?? "none";

  if (LIFECYCLE_RECLAIMABLE_STATES.has(state)) return true;

  if (state === "claiming") {
    const leaseExpiresAt = workspace.lifecycleOperationLeaseExpiresAt
      ? new Date(workspace.lifecycleOperationLeaseExpiresAt)
      : null;

    if (!leaseExpiresAt) return true;

    return leaseExpiresAt.getTime() <= Date.now();
  }

  return false;
}

function baseRefFor(
  ctx: LifecycleContext,
  workspace: LifecycleWorkspace,
): string {
  return workspace.baseCommit ?? workspace.baseBranch ?? ctx.project.mainBranch;
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function worktreeExists(worktreePath: string): Promise<boolean> {
  try {
    await access(worktreePath);

    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;

    throw error;
  }
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

function requirePreservationOutcome(
  result: PreserveResult,
): Exclude<WorkspacePreservationOutcome, "legacy_unknown"> {
  if (result.preservationOutcome !== undefined) {
    return result.preservationOutcome;
  }

  if (result.snapshotted === true) return "snapshot_created";

  if (result.archivedBranch !== undefined) return "ref_created";

  return "not_needed";
}

type PersistedPreservation = {
  archivedAt: Date;
  archivedBranch: string | null;
  archivedCommit: string | null;
  preservationOutcome: Exclude<WorkspacePreservationOutcome, "legacy_unknown">;
};

function requirePersistedPreservation(
  workspace: LifecycleWorkspace,
): PersistedPreservation {
  if (
    workspace.archivedAt === null ||
    workspace.preservationOutcome === null ||
    workspace.preservationOutcome === undefined ||
    workspace.preservationOutcome === "legacy_unknown"
  ) {
    throw new MaisterError(
      "CONFLICT",
      `missing worktree cannot be finalized without durable preservation evidence: ${workspace.id}`,
    );
  }

  return {
    archivedAt: workspace.archivedAt,
    archivedBranch: workspace.archivedBranch,
    archivedCommit: workspace.archivedCommit ?? null,
    preservationOutcome: workspace.preservationOutcome,
  };
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
        errorCode:
          finalizeErr instanceof MaisterError ? finalizeErr.code : "unknown",
      },
      "workbench lifecycle failure finalization failed",
    );
  }
}

async function recordPreservation(
  workspace: LifecycleWorkspace,
  result: PreserveResult,
  attemptId: string,
  deps: WorkbenchLifecycleDeps,
): Promise<PersistedPreservation> {
  const archivedAt = result.archivedAt ?? new Date();
  const archivedBranch = result.archivedBranch ?? workspace.archivedBranch;
  const archivedCommit =
    result.archivedCommit ?? workspace.archivedCommit ?? null;
  const preservationOutcome = requirePreservationOutcome(result);

  await deps.recordArchive({
    workspaceId: workspace.id,
    attemptId,
    archivedBranch,
    archivedAt,
    archivedCommit,
    preservationOutcome,
  });

  return {
    archivedAt,
    archivedBranch,
    archivedCommit,
    preservationOutcome,
  };
}

async function prepareWorkspaceRemoval(args: {
  runId: string;
  ctx: LifecycleContext;
  workspace: LifecycleWorkspace;
  attemptId: string;
  deps: WorkbenchLifecycleDeps;
}): Promise<{
  worktreePresent: boolean;
  preservation: PersistedPreservation;
}> {
  const worktreePresent = await args.deps.worktreeExists(
    args.workspace.worktreePath,
  );

  if (!worktreePresent) {
    return {
      worktreePresent: false,
      preservation: requirePersistedPreservation(args.workspace),
    };
  }

  const preserveResult = await preservePresentWorkspace(
    args.runId,
    args.ctx,
    args.deps,
  );
  const preservation = await recordPreservation(
    args.workspace,
    preserveResult,
    args.attemptId,
    args.deps,
  );

  return { worktreePresent: true, preservation };
}

async function assertWorkspaceRemovalAllowed(args: {
  run: LifecycleRun;
  workspace: LifecycleWorkspace;
}): Promise<void> {
  if (
    args.run.runKind !== "agent" ||
    args.run.workspaceMode !== "shared" ||
    args.run.agentWorkspace !== "worktree" ||
    !args.run.rootRunId
  ) {
    return;
  }

  const blockingSiblings = await db()
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.rootRunId, args.run.rootRunId),
        eq(runs.workspaceMode, "shared"),
        eq(runs.agentWorkspace, "worktree"),
        notInArray(runs.status, [...DISPOSABLE_WORKSPACE_RUN_STATUSES]),
      ),
    );

  const otherBlockingSiblings = blockingSiblings.filter(
    (sibling) => sibling.id !== args.run.id,
  );

  if (otherBlockingSiblings.length === 0) return;

  log.warn(
    {
      runId: args.run.id,
      rootRunId: args.run.rootRunId,
      workspaceId: args.workspace.id,
      blockingSiblingCount: otherBlockingSiblings.length,
    },
    "workbench lifecycle shared workspace removal blocked by actionable siblings",
  );

  throw new MaisterError(
    "CONFLICT",
    `shared workspace has ${otherBlockingSiblings.length} actionable sibling run(s)`,
  );
}

function isReplayableRemoval(
  workspace: LifecycleWorkspace,
  expectedRemovalKind: "archive" | "drop" | "discard",
): workspace is LifecycleWorkspace & {
  preservationOutcome: Exclude<WorkspacePreservationOutcome, "legacy_unknown">;
} {
  return (
    workspace.removedAt !== null &&
    workspace.removalKind === expectedRemovalKind &&
    (workspace.preservationOutcome === "not_needed" ||
      workspace.preservationOutcome === "ref_created" ||
      workspace.preservationOutcome === "snapshot_created")
  );
}

function throwRemovedWorkspaceConflict(workspace: LifecycleWorkspace): never {
  throw new MaisterError(
    "CONFLICT",
    `workbench workspace already removed with a different lifecycle intent: ${workspace.id}`,
  );
}

export async function archiveWorkbench(
  runId: string,
  options?: WorkbenchLifecycleOptions,
): Promise<ArchiveWorkbenchResult> {
  const deps = depsFromOptions(options);

  const sessionUser = await deps.requireActiveSession();

  const ctx = await deps.loadContext(runId);

  ctx.viewerUserId = sessionUser?.id ?? null;

  await deps.authorize(ctx.run.projectId, "recoverRun");

  return archiveWorkbenchForCtx(runId, ctx, deps, {
    allowPausedBudgetRun: options?.allowPausedBudgetRun,
  });
}

async function archiveWorkbenchForCtx(
  runId: string,
  ctx: LifecycleContext,
  deps: WorkbenchLifecycleDeps,
  options?: { allowPausedBudgetRun?: boolean },
): Promise<ArchiveWorkbenchResult> {
  const workspaceRecord = requireWorkspaceRecord(ctx);

  if (workspaceRecord.removedAt !== null) {
    if (isReplayableRemoval(workspaceRecord, "archive")) {
      return {
        ok: true,
        runId,
        operation: "archive",
        runStatus: ctx.run.status,
        workspaceRemoved: true,
        idempotent: true,
        preservationOutcome: workspaceRecord.preservationOutcome,
        archived: workspaceRecord.preservationOutcome !== "not_needed",
        archivedBranch: workspaceRecord.archivedBranch,
        snapshotted: workspaceRecord.preservationOutcome === "snapshot_created",
      };
    }

    return throwRemovedWorkspaceConflict(workspaceRecord);
  }

  requireActionAllowed(ctx, "archive", options);

  const workspace = workspaceRecord;

  log.info(
    {
      runId,
      workspaceId: workspace.id,
      operation: "archive",
      expectedRunStatus: ctx.run.status,
    },
    "workbench lifecycle removal started",
  );
  const claim = await deps.claimLifecycleOperation({
    runId,
    workspaceId: workspace.id,
    operation: "archive",
    expectedRunStatus: ctx.run.status,
  });

  try {
    const removal = await prepareWorkspaceRemoval({
      runId,
      ctx,
      workspace,
      attemptId: claim.attemptId,
      deps,
    });

    await deps.assertWorkspaceRemovalAllowed({
      run: ctx.run,
      workspace,
    });

    await deps.renewLifecycleOperationLease({
      workspaceId: workspace.id,
      attemptId: claim.attemptId,
    });

    if (removal.worktreePresent) {
      await deps.removeOwnedWorktree({
        projectRepoPath: workspace.parentRepoPath,
        worktreePath: workspace.worktreePath,
        allowedRoot: deps.worktreesRoot(),
        force: true,
      });
    } else {
      log.info(
        { runId, workspaceId: workspace.id, operation: "archive" },
        "workbench lifecycle finalized removal after filesystem recovery",
      );
    }

    const removedAt = new Date();

    await deps.recordDrop({
      runId,
      runKind: ctx.run.runKind,
      workspaceId: workspace.id,
      removedAt,
      expectedRunStatus: ctx.run.status,
      nextRunStatus: null,
      archivedBranch: removal.preservation.archivedBranch,
      archivedAt: removal.preservation.archivedAt,
      archivedCommit: removal.preservation.archivedCommit,
      preservationOutcome: removal.preservation.preservationOutcome,
      removalKind: "archive",
      attemptId: claim.attemptId,
    });

    log.info(
      {
        runId,
        workspaceId: workspace.id,
        operation: "archive",
        attemptId: claim.attemptId,
        preservationOutcome: removal.preservation.preservationOutcome,
      },
      "workbench lifecycle removal completed",
    );

    return {
      ok: true,
      runId,
      operation: "archive",
      runStatus: ctx.run.status,
      workspaceRemoved: true,
      idempotent: false,
      preservationOutcome: removal.preservation.preservationOutcome,
      archived: removal.preservation.preservationOutcome !== "not_needed",
      archivedBranch: removal.preservation.archivedBranch,
      snapshotted:
        removal.preservation.preservationOutcome === "snapshot_created",
    };
  } catch (err) {
    log.warn(
      {
        runId,
        workspaceId: workspace.id,
        operation: "archive",
        attemptId: claim.attemptId,
        errorCode: err instanceof MaisterError ? err.code : "unknown",
      },
      "workbench lifecycle removal failed",
    );
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

  const sessionUser = await deps.requireActiveSession();

  const ctx = await deps.loadContext(runId);

  ctx.viewerUserId = sessionUser?.id ?? null;

  await deps.authorize(ctx.run.projectId, "promoteRun");
  requireActionAllowed(ctx, "exportBranch", {
    allowPausedBudgetRun: options?.allowPausedBudgetRun,
  });

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

  const sessionUser = await deps.requireActiveSession();

  const ctx = await deps.loadContext(runId);

  ctx.viewerUserId = sessionUser?.id ?? null;

  await deps.authorize(ctx.run.projectId, "promoteRun");
  requireActionAllowed(ctx, "exportBranch", {
    allowPausedBudgetRun: args.allowPausedBudgetRun,
  });

  const workspace = requireWorkspace(ctx);
  const commitMessage = requireCommitMessage(args.commitMessage);
  const dirty = await dirtyState(workspace, deps);

  if (!dirty) {
    throw new MaisterError(
      "PRECONDITION",
      `worktree is clean for run ${runId}`,
      { details: { reason: "clean_worktree", runId } },
    );
  }

  const claim = await deps.claimLifecycleOperation({
    runId,
    workspaceId: workspace.id,
    operation: "snapshotCommit",
    expectedRunStatus: ctx.run.status,
  });

  try {
    const snapshotCreated = await deps.snapshotDirtyWorktree({
      worktreePath: workspace.worktreePath,
      commitMessage,
    });
    const commit = await deps.headCommit({
      worktreePath: workspace.worktreePath,
    });

    await deps.renewLifecycleOperationLease({
      workspaceId: workspace.id,
      attemptId: claim.attemptId,
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

  const sessionUser = await deps.requireActiveSession();

  const ctx = await deps.loadContext(runId);

  ctx.viewerUserId = sessionUser?.id ?? null;

  await deps.authorize(ctx.run.projectId, "promoteRun");
  requireActionAllowed(ctx, "exportBranch", {
    allowPausedBudgetRun: args.allowPausedBudgetRun,
  });

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
    expectedRunStatus: ctx.run.status,
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

    await deps.renewLifecycleOperationLease({
      workspaceId: workspace.id,
      attemptId: claim.attemptId,
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
  return removeWorkbench(runId, "drop", options);
}

export async function discardWorkbench(
  runId: string,
  options?: WorkbenchLifecycleOptions,
): Promise<DropWorkbenchResult> {
  return removeWorkbench(runId, "discard", options);
}

async function removeWorkbench(
  runId: string,
  operation: "drop" | "discard",
  options?: WorkbenchLifecycleOptions,
): Promise<DropWorkbenchResult> {
  const deps = depsFromOptions(options);

  const sessionUser = await deps.requireActiveSession();

  const ctx = await deps.loadContext(runId);

  ctx.viewerUserId = sessionUser?.id ?? null;

  await deps.authorize(ctx.run.projectId, "recoverRun");

  return removeWorkbenchForCtx(runId, ctx, deps, operation);
}

async function removeWorkbenchForCtx(
  runId: string,
  ctx: LifecycleContext,
  deps: WorkbenchLifecycleDeps,
  operation: "drop" | "discard",
): Promise<DropWorkbenchResult> {
  const workspaceRecord = requireWorkspaceRecord(ctx);

  if (workspaceRecord.removedAt !== null) {
    if (isReplayableRemoval(workspaceRecord, operation)) {
      return {
        ok: true,
        runId,
        operation,
        runStatus: ctx.run.status,
        workspaceRemoved: true,
        idempotent: true,
        preservationOutcome: workspaceRecord.preservationOutcome,
        archivedBranch: workspaceRecord.archivedBranch,
      };
    }

    return throwRemovedWorkspaceConflict(workspaceRecord);
  }

  requireActionAllowed(ctx, "drop");

  // T7.4: a direct drop of a flow orchestrator (no preceding stop) cascades the
  // sub-tree first. After a stop (stopThenDrop) this is an idempotent no-op.
  await deps.cascadeOrchestratorIfNeeded(ctx.run);

  const workspace = workspaceRecord;

  log.info(
    {
      runId,
      workspaceId: workspace.id,
      operation,
      expectedRunStatus: ctx.run.status,
    },
    "workbench lifecycle removal started",
  );
  const claim = await deps.claimLifecycleOperation({
    runId,
    workspaceId: workspace.id,
    operation,
    expectedRunStatus: ctx.run.status,
  });

  try {
    const removal = await prepareWorkspaceRemoval({
      runId,
      ctx,
      workspace,
      attemptId: claim.attemptId,
      deps,
    });

    await deps.assertWorkspaceRemovalAllowed({
      run: ctx.run,
      workspace,
    });

    await deps.renewLifecycleOperationLease({
      workspaceId: workspace.id,
      attemptId: claim.attemptId,
    });

    if (removal.worktreePresent) {
      await deps.removeOwnedWorktree({
        projectRepoPath: workspace.parentRepoPath,
        worktreePath: workspace.worktreePath,
        allowedRoot: deps.worktreesRoot(),
        force: true,
      });
    } else {
      log.info(
        { runId, workspaceId: workspace.id, operation },
        "workbench lifecycle finalized removal after filesystem recovery",
      );
    }

    const nextRunStatus = ctx.run.status === "Done" ? null : "Abandoned";
    const removedAt = new Date();

    await deps.recordDrop({
      runId,
      runKind: ctx.run.runKind,
      workspaceId: workspace.id,
      removedAt,
      expectedRunStatus: ctx.run.status,
      nextRunStatus,
      archivedBranch: removal.preservation.archivedBranch,
      archivedAt: removal.preservation.archivedAt,
      archivedCommit: removal.preservation.archivedCommit,
      preservationOutcome: removal.preservation.preservationOutcome,
      removalKind: operation,
      attemptId: claim.attemptId,
    });

    log.info(
      {
        runId,
        workspaceId: workspace.id,
        operation,
        attemptId: claim.attemptId,
        preservationOutcome: removal.preservation.preservationOutcome,
      },
      "workbench lifecycle removal completed",
    );

    return {
      ok: true,
      runId,
      operation,
      runStatus: nextRunStatus ?? ctx.run.status,
      workspaceRemoved: true,
      idempotent: false,
      preservationOutcome: removal.preservation.preservationOutcome,
      archivedBranch: removal.preservation.archivedBranch,
    };
  } catch (err) {
    log.warn(
      {
        runId,
        workspaceId: workspace.id,
        operation,
        attemptId: claim.attemptId,
        errorCode: err instanceof MaisterError ? err.code : "unknown",
      },
      "workbench lifecycle removal failed",
    );
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

  const sessionUser = await deps.requireActiveSession();

  const ctx = await deps.loadContext(runId);

  ctx.viewerUserId = sessionUser?.id ?? null;

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
    expectedRunStatus: ctx.run.status,
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
    await deps.renewLifecycleOperationLease({
      workspaceId: workspace.id,
      attemptId: claim.attemptId,
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

  const sessionUser = await deps.requireActiveSession();

  const ctx = await deps.loadContext(runId);

  ctx.viewerUserId = sessionUser?.id ?? null;

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
  // Match the run's live supervisor sessions by the server-owned runId, NOT by
  // run_sessions.acp_session_id: the graph runner persists acp_session_id only
  // AFTER a node's prompt returns (runner-graph.ts), so a node still mid-prompt
  // has a null column while its agent session is live. Matching on acp ids there
  // finds nothing and the caller parks the run terminal while the agent keeps
  // mutating the worktree (split-brain). runId is always present on the
  // supervisor record and is the correct boundary — the same idiom the keepalive
  // watchdog uses (keepalive-sweeper.ts). A run may hold N logical sessions
  // (sequential, but stop EVERY live one); never narrow by stepId, which would
  // spare a live session of a different node.
  const client = await deps.executionHosts.forRun(ctx.run.id, {
    teardown: true,
  });
  const sessions = await client.sessionsForRun();
  let stoppedAny = false;

  for (const session of sessions) {
    if (session.status !== "live") continue;

    await client.deleteSession(session.sessionId);
    stoppedAny = true;

    log.info(
      { runId: ctx.run.id, supervisorSessionId: session.sessionId },
      "workbench stop — live supervisor session killed",
    );
  }

  return stoppedAny;
}

// M37 (ADR-098) T7.4: when a FLOW run being stopped/dropped is an orchestrator
// (status WaitingOnChildren OR it has run-tree children), abandon its whole
// sub-tree FIRST (children-first ordering) AND stop every cascaded
// descendant's live session — the cascade flips rows only, and a grandchild
// left live keeps spending under its terminal row — so no in-flight or queued
// child outlives the cancelled coordinator. Idempotent — a second call (e.g.
// the drop after a stop in stopThenDrop) finds every descendant already
// terminal and cascades nothing. Lazy imports keep the cascade's
// scheduler/query graph out of this module's static eval graph (mirrors the
// agent/scratch service imports). The default WorkbenchLifecycleDeps wires this
// as cascadeOrchestratorIfNeeded.
async function cascadeOrchestratorIfNeeded(run: LifecycleRun): Promise<void> {
  if (run.runKind !== "flow") return;

  const { getChildRuns } = await import("@/lib/queries/run");
  const hasChildren =
    run.status === "WaitingOnChildren"
      ? true
      : (await getChildRuns(run.id)).length > 0;

  if (!hasChildren) return;

  const { cascadeAbandonRunTreeAndStopSessions } = await import(
    "@/lib/orchestrator/cascade"
  );

  await cascadeAbandonRunTreeAndStopSessions(
    run.id,
    run.taskId,
    "user_stopped",
    { db: db(), logLabel: "[workbench.cascade]" },
  );
}

async function stopFlowAfterAuth(
  runId: string,
  ctx: LifecycleContext,
  deps: WorkbenchLifecycleDeps,
): Promise<StopFlowWorkbenchResult> {
  if (!isEnabled(ctx, "stop")) {
    requireActionAllowed(ctx, "stop");
  }

  await deps.cascadeOrchestratorIfNeeded(ctx.run);

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

  // finalizeAgentRun flips status + nulls acpSessionId + frees the agent pool
  // slot, but it does NOT delete the supervisor session — kill it here.
  const supervisorStopped = await stopLiveSupervisorSession(ctx, deps);

  const finalize = await deps.finalizeAgentRun({
    runId,
    reason: "operator",
  });

  if (!finalize.finalized) {
    // The run reached a terminal status between auth and finalize (a lost CAS
    // race); the stop still reports ok because the outcome is identical, but
    // surface the no-op so operators can see this call was not the finalizer.
    log.info(
      { runId },
      "agent stop finalize was a no-op (run already terminal)",
    );
  }

  if (ctx.workspace && ctx.workspace.removedAt === null) {
    await deps.cleanupAgentMaterializations({
      runId,
      worktreePath: ctx.workspace.worktreePath,
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
      const result = await deps.stopScratchWorkbench(runId);

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

  const sessionUser = await deps.requireActiveSession();

  const ctx = await deps.loadContext(runId);

  ctx.viewerUserId = sessionUser?.id ?? null;

  await deps.authorize(ctx.run.projectId, "recoverRun");

  return stopRunByKind(runId, ctx, deps);
}

// ADR-163 (owner decision Q1-A): the coordinator's `run_cancel` ENDS a
// delegated flow child. The operator stop keeps its stop-to-Review semantic for
// humans, but a child the coordinator cancels is not reviewable work, and a
// child parked in Review still counts as LIVE for the shared fan-out cap while
// run_rework / run_message are refused for flow children — cancel-to-Review left
// the coordinator no way to reclaim capacity except promoting a half-done diff.
// Gated on the abandonable set rather than the workbench "stop" policy so a
// child a human already parked in Review can still be cancelled; a terminal
// child refuses CONFLICT like the agent arm. `markAbandoned` emits run.abandoned
// with parent_run_id (the parent wake) and stamps the GC deadline; assignments
// close in the same transaction.
async function cancelDelegatedFlowChild(
  runId: string,
  ctx: LifecycleContext,
  deps: WorkbenchLifecycleDeps,
): Promise<StopWorkbenchRunResult> {
  if (!(ABANDONABLE_STATUSES as readonly string[]).includes(ctx.run.status)) {
    throw new MaisterError(
      "CONFLICT",
      `run ${runId} is ${ctx.run.status} and cannot be cancelled`,
    );
  }

  // A flow child may itself coordinate a sub-tree: children first.
  await deps.cascadeOrchestratorIfNeeded(ctx.run);

  const supervisorStopped = await stopLiveSupervisorSession(ctx, deps);

  await db().transaction(async (tx) => {
    const abandoned = await markAbandoned(runId, { db: tx });

    if (!abandoned.ok) {
      // Lost the CAS to a concurrent terminal write — the outcome is identical;
      // surface that this call was not the finalizer (agent-arm parity).
      log.info(
        { runId, reason: abandoned.reason },
        "delegated flow child cancel was a no-op (run already terminal)",
      );

      return;
    }

    await systemCloseActiveAssignmentsForRun({
      db: tx,
      runId,
      reason: "run cancelled by orchestrator",
    });
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
      "promoteNextPending after delegated child cancel failed",
    );
  }

  log.info(
    { runId, parentRunId: ctx.run.parentRunId, supervisorStopped },
    "[delegation.cancel] delegated flow child abandoned by its coordinator",
  );

  return { ok: true, runId, runStatus: "Abandoned", supervisorStopped };
}

// M37 (ADR-098): the same generalized stop, reached from the /api/v1/ext token
// surface (run_cancel). There is no browser session here — authority is the
// run-bound token, so the session check is skipped and authorization is the
// caller's already-derived project (the run must belong to the token's
// project). The run-kind dispatch and supervisor teardown are identical.
export async function stopWorkbenchRunForToken(
  runId: string,
  args: { projectId: string },
  options?: WorkbenchLifecycleOptions,
): Promise<StopWorkbenchRunResult> {
  const deps = depsFromOptions(options);
  const ctx = await deps.loadContext(runId);

  // Token authority, no browser session: there is no viewer, so the ADR-160
  // owner carve-out can never open for this path.
  ctx.viewerUserId = null;

  if (ctx.run.projectId !== args.projectId) {
    throw new MaisterError("PRECONDITION", `run not found: ${runId}`);
  }

  if (ctx.run.runKind === "flow" && ctx.run.parentRunId) {
    return cancelDelegatedFlowChild(runId, ctx, deps);
  }

  return stopRunByKind(runId, ctx, deps);
}

// POST /api/runs/{runId}/stop-archive — all workspace-backed run kinds. Stop
// commits the parked status first; an archive failure leaves the run retryable.
export async function stopThenArchive(
  runId: string,
  options?: WorkbenchLifecycleOptions,
): Promise<StopThenArchiveResult> {
  const deps = depsFromOptions(options);

  const sessionUser = await deps.requireActiveSession();

  const ctx = await deps.loadContext(runId);

  ctx.viewerUserId = sessionUser?.id ?? null;

  await deps.authorize(ctx.run.projectId, "recoverRun");

  const stop = await stopRunByKind(runId, ctx, deps);
  const parkedCtx = await deps.loadContext(runId);
  const archive = await archiveWorkbenchForCtx(runId, parkedCtx, deps);

  return { ...archive, supervisorStopped: stop.supervisorStopped };
}

// POST /api/runs/{runId}/stop-drop — all workspace-backed run kinds.
export async function stopThenDrop(
  runId: string,
  options?: WorkbenchLifecycleOptions,
): Promise<StopThenDropResult> {
  const deps = depsFromOptions(options);

  const sessionUser = await deps.requireActiveSession();

  const ctx = await deps.loadContext(runId);

  ctx.viewerUserId = sessionUser?.id ?? null;

  await deps.authorize(ctx.run.projectId, "recoverRun");

  const stop = await stopRunByKind(runId, ctx, deps);
  const parkedCtx = await deps.loadContext(runId);
  const drop = await removeWorkbenchForCtx(runId, parkedCtx, deps, "drop");

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
    executionHosts: createExecutionHosts({
      db: db() as unknown as ExecutionDb,
    }),
    markStoppedAndCloseAssignments: markRunStoppedAndCloseAssignments,
    promoteNextPending: async () => {
      await promoteNextPending();
    },
    finalizeAgentRun: async ({ runId, reason }) => {
      const { finalizeAgentRun } = await import("@/lib/agents/launch");
      const result = await finalizeAgentRun(runId, "Abandoned", {
        reason,
        closeAssignments: { kind: "system", reason: "run stopped by operator" },
      });

      return { finalized: result.finalized };
    },
    cleanupAgentMaterializations: async ({ runId, worktreePath }) => {
      const { cleanupRunMaterializations } = await import(
        "@/lib/capabilities/cleanup"
      );

      await cleanupRunMaterializations({
        runId,
        worktreePath,
        db: db(),
      });
    },
    stopScratchWorkbench: async (runId) => {
      const { stopScratchWorkbench } = await import(
        "@/lib/scratch-runs/service"
      );
      const result = await stopScratchWorkbench(runId);

      return {
        runStatus: result.runStatus === "Review" ? "Review" : "Abandoned",
        supervisorStopped: result.supervisorStopped,
      };
    },
    assertWorkspaceRemovalAllowed,
    preserveWorktree,
    worktreeExists,
    recordArchive,
    recordDrop,
    removeOwnedWorktree,
    worktreesRoot,
    statusPorcelain,
    snapshotDirtyWorktree,
    pushBranch,
    claimLifecycleOperation,
    renewLifecycleOperationLease,
    finalizeLifecycleOperation,
    listRemotes,
    headCommit,
    localBranchHead,
    remoteBranchHead,
    createBranchAtHead,
    cascadeOrchestratorIfNeeded,
  };
}

async function loadLifecycleContext(runId: string): Promise<LifecycleContext> {
  const client = db();
  const runRows = await client
    .select({
      id: runs.id,
      projectId: runs.projectId,
      taskId: runs.taskId,
      runKind: runs.runKind,
      status: runs.status,
      currentStepId: runs.currentStepId,
      workspaceMode: runs.workspaceMode,
      agentWorkspace: runs.agentWorkspace,
      rootRunId: runs.rootRunId,
      parentRunId: runs.parentRunId,
    })
    .from(runs)
    .where(eq(runs.id, runId));
  const run = runRows[0];

  if (!run) {
    throw new MaisterError("PRECONDITION", `run not found: ${runId}`);
  }
  // Workbench lifecycle ops act on a project worktree; a project-less
  // local-package assistant run (ADR-097) has none and is not a valid target.
  const projectId = requireRunProjectId(run.projectId, runId);

  const [projectRows, workspaceRows] = await Promise.all([
    client
      .select({
        id: projects.id,
        mainBranch: projects.mainBranch,
      })
      .from(projects)
      .where(eq(projects.id, projectId)),
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
        archivedCommit: workspaces.archivedCommit,
        preservationOutcome: workspaces.preservationOutcome,
        removalKind: workspaces.removalKind,
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

  // ADR-160: an OPEN rework claim opens the owner carve-out in the policy. An
  // ADR-030 takeover writes no `decision`, so it never matches and keeps
  // today's all-actions-disabled behaviour.
  const activeClaim = await getActiveTakeover(runId, client);
  const reworkClaimOwnerUserId =
    activeClaim?.decision === REVIEW_REWORK_CLAIM_DECISION
      ? activeClaim.ownerUserId
      : null;
  // `viewerUserId` is deliberately NOT read here: a DB loader must not reach
  // for the request session. Entry points attach it from the user their own
  // `requireActiveSession()` already authenticated.
  return {
    project,
    run: { ...run, projectId },
    workspace: workspaceRows[0] ?? null,
    reworkClaimOwnerUserId,
  };
}

export async function recordArchive(args: RecordArchiveInput): Promise<void> {
  const client = args.database ?? db();
  const rows = await client
    .update(workspaces)
    .set({
      archivedBranch: args.archivedBranch,
      archivedAt: args.archivedAt,
      archivedCommit: args.archivedCommit,
      preservationOutcome: args.preservationOutcome,
    })
    .where(
      and(
        eq(workspaces.id, args.workspaceId),
        eq(workspaces.lifecycleOperationAttemptId, args.attemptId),
        eq(workspaces.lifecycleOperationState, "claiming"),
        gt(workspaces.lifecycleOperationLeaseExpiresAt, new Date()),
      ),
    )
    .returning({ id: workspaces.id });

  if (rows.length === 0) {
    throw new MaisterError(
      "CONFLICT",
      `lifecycle operation claim lost before preservation recording: ${args.workspaceId}`,
    );
  }
}

export async function recordDrop(args: RecordDropInput): Promise<void> {
  const client = args.database ?? db();

  await client.transaction(async (tx) => {
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
        archivedCommit: args.archivedCommit,
        preservationOutcome: args.preservationOutcome,
        removalKind: args.removalKind,
        ...RELEASED_LIFECYCLE_CLAIM,
      })
      .where(
        and(
          eq(workspaces.id, args.workspaceId),
          eq(workspaces.runId, args.runId),
          isNull(workspaces.removedAt),
          eq(workspaces.lifecycleOperationState, "claiming"),
          eq(workspaces.lifecycleOperationAttemptId, args.attemptId),
          gt(workspaces.lifecycleOperationLeaseExpiresAt, new Date()),
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
          parentRunId: runs.parentRunId,
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

      // Workbench targets always carry a project (ADR-097); narrow for emit.
      const eventProjectId = requireRunProjectId(
        updatedRunRows[0].projectId,
        args.runId,
      );

      if (args.nextRunStatus === "Abandoned") {
        await emitWebhookEvent({
          db: tx,
          type: "run.abandoned",
          projectId: eventProjectId,
          runId: args.runId,
          data: { source: "workbench" },
        });
        await emitDomainEvent({
          db: tx,
          kind: "run.abandoned",
          projectId: eventProjectId,
          runId: args.runId,
          taskId: updatedRunRows[0].taskId,
          actor: { type: "system", id: null },
          parentRunId: updatedRunRows[0].parentRunId,
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
          projectId: eventProjectId,
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
        currentStepId: null,
        endedAt: args.endedAt,
        // ADR-126 T8: a manual-takeover return is a fresh Review entry — restart
        // the auto-promotion grace window.
        reviewEnteredAt: args.endedAt,
      })
      .where(and(eq(runs.id, args.runId), inArray(runs.status, STOP_STATUSES)))
      .returning({
        id: runs.id,
        projectId: runs.projectId,
        taskId: runs.taskId,
        flowId: runs.flowId,
        runKind: runs.runKind,
        parentRunId: runs.parentRunId,
      });

    if (rows.length === 0) {
      throw new MaisterError(
        "CONFLICT",
        `run ${args.runId} was not in a stoppable state`,
      );
    }

    // ADR-164 D7: the stop ends the run's driver generation.
    await releaseAssignmentForRun(
      tx as unknown as ExecutionDb,
      args.runId,
      "stopped",
    );

    await systemCloseActiveAssignmentsForRun({
      db: tx,
      runId: args.runId,
      reason: args.reason,
    });

    await emitWebhookEvent({
      db: tx,
      type: "run.review",
      projectId: requireRunProjectId(rows[0].projectId, args.runId),
      runId: args.runId,
      data: { source: "workbench" },
    });
    // ADR-163: an operator stop parks a delegated child in Review too, and a
    // Review nothing announces leaves its parent waiting forever. The cause
    // keeps the as-plan auto-promote from reading the stop as a completion.
    await emitDelegatedReviewIfChild(tx, {
      runId: args.runId,
      projectId: requireRunProjectId(rows[0].projectId, args.runId),
      taskId: rows[0].taskId,
      flowId: rows[0].flowId,
      runKind: rows[0].runKind,
      parentRunId: rows[0].parentRunId,
      cause: "operator_stop",
    });
  });
}

export async function claimLifecycleOperation(args: {
  database?: NodePgDatabase<typeof schema>;
  runId: string;
  workspaceId: string;
  operation: LifecycleOperationName;
  expectedRunStatus: WorkbenchRunStatus;
}): Promise<LifecycleOperationClaim> {
  const client = args.database ?? db();

  return client.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: workspaces.id,
        lifecycleOperationState: workspaces.lifecycleOperationState,
        lifecycleOperationLeaseExpiresAt:
          workspaces.lifecycleOperationLeaseExpiresAt,
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
    const claimedAt = new Date();
    const leaseExpiresAt = new Date(
      claimedAt.getTime() + promotionClaimTimeoutSeconds() * 1000,
    );

    await tx
      .update(workspaces)
      .set({
        lifecycleOperationState: "claiming",
        lifecycleOperationClaimedAt: claimedAt,
        lifecycleOperationLeaseExpiresAt: leaseExpiresAt,
        lifecycleOperationAttemptId: attemptId,
        lifecycleOperationName: args.operation,
        lifecycleOperationExpectedRunStatus: args.expectedRunStatus,
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

    return { attemptId, leaseExpiresAt };
  });
}

export async function renewLifecycleOperationLease(args: {
  database?: NodePgDatabase<typeof schema>;
  workspaceId: string;
  attemptId: string;
}): Promise<LifecycleOperationClaim> {
  const client = args.database ?? db();
  const leaseExpiresAt = new Date(
    Date.now() + promotionClaimTimeoutSeconds() * 1000,
  );
  const rows = await client
    .update(workspaces)
    .set({ lifecycleOperationLeaseExpiresAt: leaseExpiresAt })
    .where(
      and(
        eq(workspaces.id, args.workspaceId),
        eq(workspaces.lifecycleOperationState, "claiming"),
        eq(workspaces.lifecycleOperationAttemptId, args.attemptId),
        gt(workspaces.lifecycleOperationLeaseExpiresAt, new Date()),
      ),
    )
    .returning({ id: workspaces.id });

  if (rows.length === 0) {
    throw new MaisterError(
      "CONFLICT",
      `lifecycle operation lease lost for workspace ${args.workspaceId}`,
    );
  }

  return { attemptId: args.attemptId, leaseExpiresAt };
}

export async function finalizeLifecycleOperation(args: {
  database?: NodePgDatabase<typeof schema>;
  workspaceId: string;
  attemptId: string;
  state: LifecycleOperationState;
}): Promise<void> {
  const client = args.database ?? db();
  const update =
    args.state === "done"
      ? {
          ...RELEASED_LIFECYCLE_CLAIM,
        }
      : {
          lifecycleOperationState: "failed",
          lifecycleOperationClaimedAt: null,
          lifecycleOperationLeaseExpiresAt: null,
          lifecycleOperationAttemptId: args.attemptId,
        };

  const rows = await client
    .update(workspaces)
    .set(update)
    .where(
      and(
        eq(workspaces.id, args.workspaceId),
        eq(workspaces.lifecycleOperationAttemptId, args.attemptId),
        ...(args.state === "done"
          ? [
              eq(workspaces.lifecycleOperationState, "claiming"),
              gt(workspaces.lifecycleOperationLeaseExpiresAt, new Date()),
            ]
          : []),
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
