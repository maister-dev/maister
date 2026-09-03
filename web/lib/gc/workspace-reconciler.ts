import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Db as ExecutionDb } from "@/lib/execution-host/db";
import type { WorkbenchRunStatus } from "@/lib/workbench-lifecycle/policy";
import type { MaisterProvenance } from "@/lib/worktree-provenance-core";

import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  claimReconciliationFinding,
  holdReconciliationFinding,
  loadDueReconciliationFindings,
  observeReconciliationFinding,
  quarantineReconciliationFinding,
  recordReconciliationRescueEvidence,
  renewReconciliationFindingClaim,
  resolveReconciliationFinding,
  retryReconciliationFinding,
  type ReconciliationFindingClaim,
  type ReconciliationFinding,
  type ReconciliationObservation,
} from "@/lib/gc/workspace-reconciliation-findings";
import { gcAgeDays, worktreesRoot } from "@/lib/instance-config";
import {
  createExecutionHosts,
  getLatestAssignment,
  type ExecutionHosts,
  type SupervisorSessionRecord,
} from "@/lib/execution-host";
import {
  createBranchAtHead,
  headCommit,
  listWorktrees,
  localBranchHead,
  removeOwnedWorktree,
  snapshotDirtyWorktree,
} from "@/lib/worktree";
import {
  claimLifecycleOperation,
  finalizeLifecycleOperation,
  recordDrop,
} from "@/lib/workbench-lifecycle/service";
import { readWorktreeProvenanceMetadata } from "@/lib/worktree-provenance";

const { projects, runs, workspaces } = schema;

const log = pino({
  name: "gc-workspace-reconciler",
  level: process.env.LOG_LEVEL ?? "info",
});

const RECONCILIATION_BATCH_SIZE = 100;

type Database = NodePgDatabase<typeof schema>;
type Version2Provenance = MaisterProvenance & {
  version: 2;
  parentRepoPath: string;
  projectId: string;
  branch: string;
  workspaceKind: "flow" | "scratch" | "agent";
  createdAt: string;
};

type ReconciliationCandidate = {
  relativePath: string;
  worktreePath: string | null;
  provenance: Version2Provenance | null;
  reasonCode: string | null;
  workspace: MissingWorkspaceCandidate | null;
};

type MissingWorkspaceCandidate = {
  workspaceId: string;
  runId: string;
  projectId: string;
  worktreePath: string;
  parentRepoPath: string;
  branch: string;
  removedAt: Date | null;
  archivedBranch: string | null;
  archivedAt: Date | null;
  archivedCommit: string | null;
  preservationOutcome:
    | "not_needed"
    | "ref_created"
    | "snapshot_created"
    | "legacy_unknown"
    | null;
  runKind: "flow" | "scratch" | "agent";
  runStatus: WorkbenchRunStatus;
};

type OwnedWorktreeRemover = typeof removeOwnedWorktree;
type Clock = () => Date;

export type WorkspaceReconciliationSummary = {
  scanned: number;
  retained: number;
  recovered: number;
  preserved: number;
  removed: number;
  retryableFailed: number;
  quarantined: number;
  resolved: number;
};

export type RunWorkspaceReconciliationSweepOptions = {
  database?: Database;
  root?: string;
  now?: () => Date;
  removeOwnedWorktree?: OwnedWorktreeRemover;
  afterOwnedWorktreeRemoval?: () => Promise<void>;
  executionHosts?: ExecutionHosts;
};

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isContainedPath(root: string, target: string): boolean {
  const relativePath = path.relative(root, target);

  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

function isSafeWorkspaceRelativePath(relativePath: string): boolean {
  const segments = relativePath.split(path.sep);

  return (
    segments.length === 2 &&
    segments.every(
      (segment) => segment.length > 0 && segment !== "." && segment !== "..",
    )
  );
}

function isVersion2Provenance(
  provenance: MaisterProvenance,
): provenance is Version2Provenance {
  return (
    provenance.version === 2 &&
    typeof provenance.parentRepoPath === "string" &&
    typeof provenance.projectId === "string" &&
    typeof provenance.branch === "string" &&
    (provenance.workspaceKind === "flow" ||
      provenance.workspaceKind === "scratch" ||
      provenance.workspaceKind === "agent") &&
    typeof provenance.createdAt === "string"
  );
}

function provenanceFingerprint(
  provenance: Version2Provenance | null,
): string | null {
  if (provenance === null) return null;

  return createHash("sha256")
    .update(
      JSON.stringify([
        provenance.version,
        provenance.runId,
        provenance.parentRepoPath,
        provenance.projectId,
        provenance.branch,
        provenance.workspaceKind,
        provenance.createdAt,
      ]),
    )
    .digest("hex");
}

function candidateObservation(
  candidate: ReconciliationCandidate,
): ReconciliationObservation {
  if (candidate.workspace !== null) {
    return {
      candidateKind:
        candidate.workspace.removedAt === null
          ? "row_missing_path"
          : "row_removed_path",
      relativePath: candidate.relativePath,
      provenanceVersion: null,
      provenanceFingerprint: null,
      provenanceRunId: candidate.workspace.runId,
      projectId: candidate.workspace.projectId,
      runId: candidate.workspace.runId,
      workspaceId: candidate.workspace.workspaceId,
    };
  }

  return {
    candidateKind:
      candidate.provenance === null ? "untrusted" : "rowless_managed",
    relativePath: candidate.relativePath,
    provenanceVersion: candidate.provenance?.version ?? null,
    provenanceFingerprint: provenanceFingerprint(candidate.provenance),
    provenanceRunId: candidate.provenance?.runId ?? null,
    // Provenance is not yet authority at observation time. Keep correlation
    // nullable until the trusted project/run checks have succeeded so a stale
    // or deleted ID cannot make the durable observation itself fail its FK.
    projectId: null,
    runId: null,
    workspaceId: null,
  };
}

async function listCandidates(
  root: string,
): Promise<ReconciliationCandidate[]> {
  let resolvedRoot: string;

  try {
    resolvedRoot = await realpath(root);
  } catch (error) {
    if (isMissingPathError(error)) return [];

    throw error;
  }

  const projectEntries = await readdir(resolvedRoot, { withFileTypes: true });
  const candidates: ReconciliationCandidate[] = [];

  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory() || projectEntry.isSymbolicLink()) continue;

    const projectDirectory = path.join(resolvedRoot, projectEntry.name);
    const worktreeEntries = await readdir(projectDirectory, {
      withFileTypes: true,
    });

    for (const worktreeEntry of worktreeEntries) {
      if (worktreeEntry.isSymbolicLink()) {
        candidates.push({
          relativePath: path.join(projectEntry.name, worktreeEntry.name),
          worktreePath: null,
          provenance: null,
          reasonCode: "symlink_escape",
          workspace: null,
        });
        continue;
      }

      if (!worktreeEntry.isDirectory()) continue;

      const candidatePath = path.join(projectDirectory, worktreeEntry.name);
      const relativePath = path.join(projectEntry.name, worktreeEntry.name);

      try {
        const candidateStat = await lstat(candidatePath);

        if (candidateStat.isSymbolicLink()) {
          candidates.push({
            relativePath,
            worktreePath: null,
            provenance: null,
            reasonCode: "symlink_escape",
            workspace: null,
          });
          continue;
        }

        const resolvedPath = await realpath(candidatePath);

        if (!isContainedPath(resolvedRoot, resolvedPath)) {
          candidates.push({
            relativePath,
            worktreePath: null,
            provenance: null,
            reasonCode: "outside_root",
            workspace: null,
          });
          continue;
        }

        try {
          const provenance = await readWorktreeProvenanceMetadata(resolvedPath);

          candidates.push({
            relativePath,
            worktreePath: resolvedPath,
            provenance: isVersion2Provenance(provenance) ? provenance : null,
            reasonCode: isVersion2Provenance(provenance)
              ? null
              : "legacy_provenance",
            workspace: null,
          });
        } catch {
          candidates.push({
            relativePath,
            worktreePath: resolvedPath,
            provenance: null,
            reasonCode: "invalid_provenance",
            workspace: null,
          });
        }
      } catch (error) {
        if (isMissingPathError(error)) continue;

        candidates.push({
          relativePath,
          worktreePath: null,
          provenance: null,
          reasonCode: "filesystem_inspection_failed",
          workspace: null,
        });
      }
    }
  }

  return candidates.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}

async function listMissingWorkspaceCandidates(args: {
  database: Database;
  root: string;
}): Promise<ReconciliationCandidate[]> {
  try {
    await realpath(args.root);
  } catch (error) {
    if (isMissingPathError(error)) return [];

    throw error;
  }

  const configuredRoot = path.resolve(args.root);
  const rows = await args.database
    .select({
      workspaceId: workspaces.id,
      runId: workspaces.runId,
      projectId: workspaces.projectId,
      worktreePath: workspaces.worktreePath,
      parentRepoPath: workspaces.parentRepoPath,
      branch: workspaces.branch,
      removedAt: workspaces.removedAt,
      archivedBranch: workspaces.archivedBranch,
      archivedAt: workspaces.archivedAt,
      archivedCommit: workspaces.archivedCommit,
      preservationOutcome: workspaces.preservationOutcome,
      runKind: runs.runKind,
      runStatus: runs.status,
    })
    .from(workspaces)
    .innerJoin(runs, eq(workspaces.runId, runs.id));
  const candidates: ReconciliationCandidate[] = [];

  for (const row of rows) {
    const worktreePath = path.resolve(row.worktreePath);

    if (!isContainedPath(configuredRoot, worktreePath)) continue;

    const relativePath = path.relative(configuredRoot, worktreePath);

    if (!isSafeWorkspaceRelativePath(relativePath)) continue;

    try {
      await lstat(worktreePath);
    } catch (error) {
      if (!isMissingPathError(error)) continue;

      candidates.push({
        relativePath,
        worktreePath: null,
        provenance: null,
        reasonCode: "workspace_path_missing",
        workspace: {
          ...row,
          runStatus: row.runStatus as WorkbenchRunStatus,
          runKind: row.runKind as "flow" | "scratch" | "agent",
        },
      });
    }
  }

  return candidates;
}

function hasRecordedPreservationOutcome(
  value: MissingWorkspaceCandidate["preservationOutcome"],
): value is Exclude<
  MissingWorkspaceCandidate["preservationOutcome"],
  null | "legacy_unknown"
> {
  return (
    value === "not_needed" ||
    value === "ref_created" ||
    value === "snapshot_created"
  );
}

async function loadTrustedProject(args: {
  database: Database;
  candidate: ReconciliationCandidate;
}): Promise<{ id: string; repoPath: string } | null> {
  const provenance = args.candidate.provenance;

  if (provenance === null || args.candidate.worktreePath === null) return null;

  const rows = await args.database
    .select({ id: projects.id, repoPath: projects.repoPath })
    .from(projects)
    .where(eq(projects.id, provenance.projectId));
  const project = rows[0];

  if (
    !project ||
    path.resolve(project.repoPath) !== path.resolve(provenance.parentRepoPath)
  ) {
    return null;
  }

  const registeredWorktrees = await listWorktrees(project.repoPath);

  for (const registered of registeredWorktrees) {
    try {
      if ((await realpath(registered.path)) === args.candidate.worktreePath) {
        return project;
      }
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
  }

  return null;
}

type FinalOrphanRemovalCheck =
  | "safe"
  | "trust_lost"
  | "ownership_reappeared"
  | "live_session";

// ADR-165 D7: after the worktree is gone, release the run's adopted handle on
// the host — a driverless `workspace.release` under the run's newest
// assignment (released included). Best-effort: a stopped host leaves the
// command queued for recovery to re-deliver; a run that never adopted (or
// whose rows are gone) has nothing to release.
async function releaseAdoptedWorkspace(
  hosts: ExecutionHosts,
  database: Database,
  runId: string,
): Promise<void> {
  try {
    const latest = await getLatestAssignment(
      database as unknown as ExecutionDb,
      runId,
    );

    if (!latest?.executionWorkspaceId) return;

    const client = await hosts.forAssignment(latest);

    await client.releaseWorkspace(latest.executionWorkspaceId);
  } catch (error) {
    log.warn(
      { runId, err: error instanceof Error ? error.message : String(error) },
      "adopted workspace release deferred",
    );
  }
}

async function checkFinalOrphanRemovalPreconditions(args: {
  database: Database;
  candidate: ReconciliationCandidate;
  liveSessions: readonly SupervisorSessionRecord[];
}): Promise<FinalOrphanRemovalCheck> {
  const provenance = args.candidate.provenance;

  if (provenance === null) return "trust_lost";

  const project = await loadTrustedProject(args);

  if (project === null) return "trust_lost";

  const liveSessions = args.liveSessions;
  const [workspaceRows, runRows] = await Promise.all([
    args.database
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.runId, provenance.runId)),
    args.database
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.id, provenance.runId)),
  ]);

  if (workspaceRows.length > 0 || runRows.length > 0) {
    return "ownership_reappeared";
  }

  if (
    liveSessions.some(
      (session) =>
        session.runId === provenance.runId && session.status === "live",
    )
  ) {
    return "live_session";
  }

  return "safe";
}

async function processTrustedCandidate(args: {
  database: Database;
  root: string;
  candidate: ReconciliationCandidate;
  claim: ReconciliationFindingClaim;
  now: Clock;
  summary: WorkspaceReconciliationSummary;
  remove: OwnedWorktreeRemover;
  afterOwnedWorktreeRemoval?: () => Promise<void>;
  liveSessions: readonly SupervisorSessionRecord[];
  hosts: ExecutionHosts;
}): Promise<void> {
  const provenance = args.candidate.provenance;
  const worktreePath = args.candidate.worktreePath;

  if (provenance === null || worktreePath === null) {
    throw new MaisterError(
      "PRECONDITION",
      "candidate has no trusted provenance",
    );
  }

  const project = await loadTrustedProject({
    database: args.database,
    candidate: args.candidate,
  });

  if (project === null) {
    await quarantineReconciliationFinding({
      database: args.database,
      claim: args.claim,
      errorCode: "git_or_project_mismatch",
      errorMessage: "candidate failed project and Git registry verification",
      now: args.now(),
    });
    args.summary.quarantined += 1;

    return;
  }

  const workspaceRows = await args.database
    .select({
      id: workspaces.id,
      runId: workspaces.runId,
      projectId: workspaces.projectId,
      branch: workspaces.branch,
      worktreePath: workspaces.worktreePath,
      parentRepoPath: workspaces.parentRepoPath,
      removedAt: workspaces.removedAt,
    })
    .from(workspaces)
    .where(eq(workspaces.runId, provenance.runId));
  const workspace = workspaceRows[0] ?? null;

  if (workspace !== null) {
    const matchesWorkspace =
      workspace.projectId === provenance.projectId &&
      workspace.branch === provenance.branch &&
      path.resolve(workspace.parentRepoPath) ===
        path.resolve(project.repoPath) &&
      path.resolve(workspace.worktreePath) === worktreePath;

    if (!matchesWorkspace) {
      await quarantineReconciliationFinding({
        database: args.database,
        claim: args.claim,
        errorCode: "workspace_mismatch",
        errorMessage: "candidate conflicts with existing workspace ownership",
        now: args.now(),
      });
      args.summary.quarantined += 1;

      return;
    }

    if (workspace.removedAt === null) {
      await resolveReconciliationFinding({
        database: args.database,
        claim: args.claim,
        resultCode: "workspace_present",
        now: args.now(),
      });
      args.summary.resolved += 1;

      return;
    }

    const renewedClaim = await renewReconciliationFindingClaim({
      database: args.database,
      claim: args.claim,
      now: args.now(),
    });

    await args.remove({
      projectRepoPath: project.repoPath,
      worktreePath,
      allowedRoot: args.root,
      force: true,
    });
    await args.afterOwnedWorktreeRemoval?.();
    await releaseAdoptedWorkspace(args.hosts, args.database, provenance.runId);
    await resolveReconciliationFinding({
      database: args.database,
      claim: renewedClaim,
      resultCode: "removed_already_removed_workspace",
      now: args.now(),
    });
    args.summary.removed += 1;
    args.summary.resolved += 1;

    return;
  }

  const runRows = await args.database
    .select({ id: runs.id, projectId: runs.projectId })
    .from(runs)
    .where(eq(runs.id, provenance.runId));
  const run = runRows[0] ?? null;

  if (run !== null) {
    if (run.projectId !== provenance.projectId) {
      await quarantineReconciliationFinding({
        database: args.database,
        claim: args.claim,
        errorCode: "run_project_mismatch",
        errorMessage: "candidate run does not belong to provenance project",
        now: args.now(),
      });
      args.summary.quarantined += 1;

      return;
    }

    await args.database.insert(workspaces).values({
      id: randomUUID(),
      runId: provenance.runId,
      projectId: provenance.projectId,
      branch: provenance.branch,
      worktreePath,
      parentRepoPath: project.repoPath,
    });
    await resolveReconciliationFinding({
      database: args.database,
      claim: args.claim,
      resultCode: "workspace_reconstructed",
      now: args.now(),
    });
    args.summary.recovered += 1;
    args.summary.resolved += 1;

    return;
  }

  const liveSessions = args.liveSessions;

  if (
    liveSessions.some(
      (session) =>
        session.runId === provenance.runId && session.status === "live",
    )
  ) {
    await holdReconciliationFinding({
      database: args.database,
      claim: args.claim,
      resultCode: "live_supervisor_session",
      now: args.now(),
    });
    args.summary.retained += 1;

    return;
  }

  const removalDueAt = new Date(
    Date.parse(provenance.createdAt) + gcAgeDays() * 86_400_000,
  );

  if (args.now() < removalDueAt) {
    await holdReconciliationFinding({
      database: args.database,
      claim: args.claim,
      resultCode: "grace_period",
      now: args.now(),
      retryAt: removalDueAt,
    });
    args.summary.retained += 1;

    return;
  }

  const rescueRef = `maister/orphan/${args.claim.id}/${provenance.runId}`;

  await snapshotDirtyWorktree({
    worktreePath,
    commitMessage: `chore: rescue orphan ${args.claim.id}`,
  });
  const rescueCommit = await headCommit({ worktreePath });
  const existingRescueCommit = await localBranchHead({
    projectRepoPath: project.repoPath,
    branch: rescueRef,
  });

  if (existingRescueCommit === null) {
    await createBranchAtHead({ worktreePath, branch: rescueRef });
  } else if (existingRescueCommit !== rescueCommit) {
    await quarantineReconciliationFinding({
      database: args.database,
      claim: args.claim,
      errorCode: "rescue_ref_conflict",
      errorMessage: "rescue ref exists at a different commit",
      now: args.now(),
    });
    args.summary.quarantined += 1;

    return;
  }

  const claimWithRescueEvidence = await renewReconciliationFindingClaim({
    database: args.database,
    claim: args.claim,
    now: args.now(),
  });

  await recordReconciliationRescueEvidence({
    database: args.database,
    claim: claimWithRescueEvidence,
    rescue: { ref: rescueRef, commit: rescueCommit },
    now: args.now(),
  });

  const finalRemovalCheck = await checkFinalOrphanRemovalPreconditions({
    database: args.database,
    candidate: args.candidate,
    liveSessions: args.liveSessions,
  });

  if (finalRemovalCheck === "trust_lost") {
    await quarantineReconciliationFinding({
      database: args.database,
      claim: claimWithRescueEvidence,
      errorCode: "final_trust_check_failed",
      errorMessage: "candidate failed the final Git and project verification",
      now: args.now(),
    });
    args.summary.quarantined += 1;

    return;
  }

  if (finalRemovalCheck === "ownership_reappeared") {
    await resolveReconciliationFinding({
      database: args.database,
      claim: claimWithRescueEvidence,
      resultCode: "ownership_reappeared",
      now: args.now(),
    });
    args.summary.resolved += 1;

    return;
  }

  if (finalRemovalCheck === "live_session") {
    await holdReconciliationFinding({
      database: args.database,
      claim: claimWithRescueEvidence,
      resultCode: "live_supervisor_session",
      now: args.now(),
    });
    args.summary.retained += 1;

    return;
  }

  const renewedClaim = await renewReconciliationFindingClaim({
    database: args.database,
    claim: claimWithRescueEvidence,
    now: args.now(),
  });

  await args.remove({
    projectRepoPath: project.repoPath,
    worktreePath,
    allowedRoot: args.root,
    force: true,
  });
  await args.afterOwnedWorktreeRemoval?.();
  await releaseAdoptedWorkspace(args.hosts, args.database, provenance.runId);
  await resolveReconciliationFinding({
    database: args.database,
    claim: renewedClaim,
    resultCode: "orphan_rescued_and_removed",
    now: args.now(),
  });
  args.summary.preserved += 1;
  args.summary.removed += 1;
  args.summary.resolved += 1;
}

async function processMissingWorkspaceCandidate(args: {
  database: Database;
  candidate: ReconciliationCandidate;
  claim: ReconciliationFindingClaim;
  now: Clock;
  summary: WorkspaceReconciliationSummary;
  liveSessions: readonly SupervisorSessionRecord[];
}): Promise<void> {
  const workspace = args.candidate.workspace;

  if (workspace === null) {
    throw new MaisterError(
      "PRECONDITION",
      "candidate has no missing-workspace evidence",
    );
  }

  if (workspace.removedAt !== null) {
    await resolveReconciliationFinding({
      database: args.database,
      claim: args.claim,
      resultCode: "removed_workspace_path_absent",
      now: args.now(),
    });
    args.summary.resolved += 1;

    return;
  }

  const liveSessions = args.liveSessions;

  if (
    liveSessions.some(
      (session) =>
        session.runId === workspace.runId && session.status === "live",
    )
  ) {
    await holdReconciliationFinding({
      database: args.database,
      claim: args.claim,
      resultCode: "live_supervisor_session",
      now: args.now(),
    });
    args.summary.retained += 1;

    return;
  }

  if (!hasRecordedPreservationOutcome(workspace.preservationOutcome)) {
    await quarantineReconciliationFinding({
      database: args.database,
      claim: args.claim,
      errorCode: "missing_workspace_preservation_evidence",
      errorMessage:
        "workspace path is absent without a durable preservation result",
      now: args.now(),
    });
    args.summary.quarantined += 1;

    return;
  }

  let lifecycleAttemptId: string | null = null;

  try {
    const lifecycleClaim = await claimLifecycleOperation({
      database: args.database,
      runId: workspace.runId,
      workspaceId: workspace.workspaceId,
      operation: "reconciliation",
      expectedRunStatus: workspace.runStatus,
    });

    lifecycleAttemptId = lifecycleClaim.attemptId;

    await recordDrop({
      database: args.database,
      runId: workspace.runId,
      runKind: workspace.runKind,
      workspaceId: workspace.workspaceId,
      removedAt: args.now(),
      expectedRunStatus: workspace.runStatus,
      nextRunStatus: null,
      archivedBranch: workspace.archivedBranch,
      archivedAt: workspace.archivedAt,
      archivedCommit: workspace.archivedCommit,
      preservationOutcome: workspace.preservationOutcome,
      removalKind: "reconciliation",
      attemptId: lifecycleAttemptId,
    });
  } catch (error) {
    if (lifecycleAttemptId !== null) {
      try {
        await finalizeLifecycleOperation({
          database: args.database,
          workspaceId: workspace.workspaceId,
          attemptId: lifecycleAttemptId,
          state: "failed",
        });
      } catch (finalizeError) {
        log.warn(
          {
            findingId: args.claim.id,
            errorType:
              finalizeError instanceof Error ? finalizeError.name : "unknown",
          },
          "workspace reconciliation row recovery could not persist lifecycle retry state",
        );
      }
    }

    throw error;
  }

  await resolveReconciliationFinding({
    database: args.database,
    claim: args.claim,
    resultCode: "missing_workspace_recovered",
    now: args.now(),
  });
  args.summary.removed += 1;
  args.summary.resolved += 1;
}

async function processAbsentFinding(args: {
  database: Database;
  finding: ReconciliationFinding;
  claim: ReconciliationFindingClaim;
  candidateAtRelativePath: ReconciliationCandidate | null;
  now: Clock;
  summary: WorkspaceReconciliationSummary;
}): Promise<void> {
  if (
    args.finding.candidateKind === "row_missing_path" &&
    args.candidateAtRelativePath?.workspace?.workspaceId ===
      args.finding.workspaceId &&
    args.candidateAtRelativePath.workspace.removedAt !== null
  ) {
    await resolveReconciliationFinding({
      database: args.database,
      claim: args.claim,
      resultCode: "workspace_marked_removed",
      now: args.now(),
    });
    args.summary.resolved += 1;

    return;
  }

  if (args.candidateAtRelativePath !== null) {
    await holdReconciliationFinding({
      database: args.database,
      claim: args.claim,
      resultCode: "candidate_identity_replaced",
      now: args.now(),
    });
    args.summary.retained += 1;

    return;
  }

  if (
    args.finding.candidateKind === "rowless_managed" &&
    args.finding.rescueRef !== null &&
    args.finding.rescueCommit !== null
  ) {
    await resolveReconciliationFinding({
      database: args.database,
      claim: args.claim,
      resultCode: "orphan_rescued_and_removed",
      rescue: {
        ref: args.finding.rescueRef,
        commit: args.finding.rescueCommit,
      },
      now: args.now(),
    });
    args.summary.resolved += 1;

    return;
  }

  if (args.finding.candidateKind === "rowless_managed") {
    await quarantineReconciliationFinding({
      database: args.database,
      claim: args.claim,
      errorCode: "missing_candidate_without_rescue_evidence",
      errorMessage:
        "managed orphan disappeared before durable rescue evidence was recorded",
      now: args.now(),
    });
    args.summary.quarantined += 1;

    return;
  }

  await resolveReconciliationFinding({
    database: args.database,
    claim: args.claim,
    resultCode: "candidate_absent",
    now: args.now(),
  });
  args.summary.resolved += 1;
}

export async function runWorkspaceReconciliationSweep(
  options: RunWorkspaceReconciliationSweepOptions = {},
): Promise<WorkspaceReconciliationSummary> {
  const database = options.database ?? getDb();
  const root = options.root ?? worktreesRoot();
  const clock: Clock = options.now ?? (() => new Date());
  const summary: WorkspaceReconciliationSummary = {
    scanned: 0,
    retained: 0,
    recovered: 0,
    preserved: 0,
    removed: 0,
    retryableFailed: 0,
    quarantined: 0,
    resolved: 0,
  };
  const [filesystemCandidates, missingWorkspaceCandidates] = await Promise.all([
    listCandidates(root),
    listMissingWorkspaceCandidates({ database, root }),
  ]);
  let removalRoot = root;

  try {
    removalRoot = await realpath(root);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  const candidates = [...filesystemCandidates, ...missingWorkspaceCandidates];
  const candidatesByFindingId = new Map<string, ReconciliationCandidate>();
  const candidatesByRelativePath = new Map<string, ReconciliationCandidate>();

  for (const candidate of candidates) {
    const observation = candidateObservation(candidate);
    const findingId = await observeReconciliationFinding({
      database,
      observation,
      now: clock(),
    });

    candidatesByFindingId.set(findingId, candidate);
    candidatesByRelativePath.set(candidate.relativePath, candidate);
  }

  const dueFindings = await loadDueReconciliationFindings({
    database,
    now: clock(),
    limit: RECONCILIATION_BATCH_SIZE,
  });

  // ADR-165: ONE session listing per sweep (was one per candidate action) —
  // and never act on a transient host outage: a failed listing skips the tick.
  const hosts =
    options.executionHosts ??
    createExecutionHosts({ db: database as unknown as ExecutionDb });
  let liveSessions: SupervisorSessionRecord[] = [];

  if (dueFindings.length > 0) {
    try {
      liveSessions = await hosts.local().listSessions();
    } catch (error) {
      log.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "workspace reconciliation sweep: session listing failed — skipping tick",
      );

      return summary;
    }
  }

  log.info(
    {
      filesystemCandidates: filesystemCandidates.length,
      missingWorkspaceCandidates: missingWorkspaceCandidates.length,
      due: dueFindings.length,
    },
    "workspace reconciliation sweep start",
  );

  for (const finding of dueFindings) {
    summary.scanned += 1;
    const claim = await claimReconciliationFinding({
      database,
      findingId: finding.id,
      now: clock(),
    });

    if (claim === null) {
      summary.retained += 1;
      continue;
    }

    const candidate = candidatesByFindingId.get(finding.id) ?? null;

    try {
      if (candidate === null) {
        await processAbsentFinding({
          database,
          finding,
          claim,
          candidateAtRelativePath:
            candidatesByRelativePath.get(finding.relativePath) ?? null,
          now: clock,
          summary,
        });
        continue;
      }

      if (candidate.workspace !== null) {
        await processMissingWorkspaceCandidate({
          database,
          candidate,
          claim,
          now: clock,
          summary,
          liveSessions,
        });
        continue;
      }

      if (candidate.provenance === null) {
        await quarantineReconciliationFinding({
          database,
          claim,
          errorCode: candidate.reasonCode ?? "untrusted_candidate",
          errorMessage: "candidate is not a trusted version 2 managed worktree",
          now: clock(),
        });
        summary.quarantined += 1;
        continue;
      }

      await processTrustedCandidate({
        database,
        root: removalRoot,
        candidate,
        claim,
        now: clock,
        summary,
        remove: options.removeOwnedWorktree ?? removeOwnedWorktree,
        afterOwnedWorktreeRemoval: options.afterOwnedWorktreeRemoval,
        liveSessions,
        hosts,
      });
    } catch (error) {
      if (isMaisterError(error) && error.code === "CONFLICT") {
        // A concurrent owner or expired lease is authoritative. Do not mutate
        // a finding after losing its claim; the next due sweep may reclaim it.
        summary.retained += 1;
      } else if (isMaisterError(error) && error.code === "PRECONDITION") {
        await quarantineReconciliationFinding({
          database,
          claim,
          errorCode: "trust_refusal",
          errorMessage: "candidate failed a reconciliation trust precondition",
          now: clock(),
        });
        summary.quarantined += 1;
      } else {
        await retryReconciliationFinding({
          database,
          claim,
          errorCode: "reconciliation_action_failed",
          errorMessage:
            "reconciliation action failed before durable completion",
          now: clock(),
        });
        summary.retryableFailed += 1;
      }

      log.warn(
        {
          findingId: finding.id,
          relativePath: finding.relativePath,
          errorType: error instanceof Error ? error.name : "unknown",
        },
        "workspace reconciliation candidate deferred",
      );
    }
  }

  log.info(summary, "workspace reconciliation sweep complete");

  return summary;
}
