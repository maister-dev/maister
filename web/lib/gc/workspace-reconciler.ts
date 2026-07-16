import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  claimReconciliationFinding,
  holdReconciliationFinding,
  observeReconciliationFinding,
  quarantineReconciliationFinding,
  renewReconciliationFindingClaim,
  resolveReconciliationFinding,
  retryReconciliationFinding,
  type ReconciliationFindingClaim,
  type ReconciliationObservation,
} from "@/lib/gc/workspace-reconciliation-findings";
import { gcAgeDays, worktreesRoot } from "@/lib/instance-config";
import { listSessions } from "@/lib/supervisor-client";
import {
  createBranchAtHead,
  headCommit,
  listWorktrees,
  localBranchHead,
  removeOwnedWorktree,
  snapshotDirtyWorktree,
} from "@/lib/worktree";
import { readWorktreeProvenanceMetadata } from "@/lib/worktree-provenance";
import type { MaisterProvenance } from "@/lib/worktree-provenance-core";

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
};

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

function provenanceFingerprint(provenance: Version2Provenance | null): string | null {
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

function candidateObservation(candidate: ReconciliationCandidate): ReconciliationObservation {
  return {
    candidateKind:
      candidate.provenance === null ? "untrusted" : "rowless_managed",
    relativePath: candidate.relativePath,
    provenanceVersion: candidate.provenance?.version ?? null,
    provenanceFingerprint: provenanceFingerprint(candidate.provenance),
    provenanceRunId: candidate.provenance?.runId ?? null,
    projectId: candidate.provenance?.projectId ?? null,
    runId: candidate.provenance?.runId ?? null,
    workspaceId: null,
  };
}

async function listCandidates(root: string): Promise<ReconciliationCandidate[]> {
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
          });
        } catch {
          candidates.push({
            relativePath,
            worktreePath: resolvedPath,
            provenance: null,
            reasonCode: "invalid_provenance",
          });
        }
      } catch (error) {
        if (isMissingPathError(error)) continue;

        candidates.push({
          relativePath,
          worktreePath: null,
          provenance: null,
          reasonCode: "filesystem_inspection_failed",
        });
      }
    }
  }

  return candidates.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
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

async function processTrustedCandidate(args: {
  database: Database;
  root: string;
  candidate: ReconciliationCandidate;
  claim: ReconciliationFindingClaim;
  now: Date;
  summary: WorkspaceReconciliationSummary;
}): Promise<void> {
  const provenance = args.candidate.provenance;
  const worktreePath = args.candidate.worktreePath;

  if (provenance === null || worktreePath === null) {
    throw new MaisterError("PRECONDITION", "candidate has no trusted provenance");
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
      now: args.now,
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
      path.resolve(workspace.parentRepoPath) === path.resolve(project.repoPath) &&
      path.resolve(workspace.worktreePath) === worktreePath;

    if (!matchesWorkspace) {
      await quarantineReconciliationFinding({
        database: args.database,
        claim: args.claim,
        errorCode: "workspace_mismatch",
        errorMessage: "candidate conflicts with existing workspace ownership",
        now: args.now,
      });
      args.summary.quarantined += 1;
      return;
    }

    if (workspace.removedAt === null) {
      await resolveReconciliationFinding({
        database: args.database,
        claim: args.claim,
        resultCode: "workspace_present",
        now: args.now,
      });
      args.summary.resolved += 1;
      return;
    }

    const renewedClaim = await renewReconciliationFindingClaim({
      database: args.database,
      claim: args.claim,
      now: args.now,
    });

    await removeOwnedWorktree({
      projectRepoPath: project.repoPath,
      worktreePath,
      allowedRoot: args.root,
      force: true,
    });
    await resolveReconciliationFinding({
      database: args.database,
      claim: renewedClaim,
      resultCode: "removed_already_removed_workspace",
      now: args.now,
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
        now: args.now,
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
      now: args.now,
    });
    args.summary.recovered += 1;
    args.summary.resolved += 1;
    return;
  }

  const liveSessions = await listSessions();

  if (liveSessions.some((session) => session.runId === provenance.runId && session.status === "live")) {
    await holdReconciliationFinding({
      database: args.database,
      claim: args.claim,
      resultCode: "live_supervisor_session",
      now: args.now,
    });
    args.summary.retained += 1;
    return;
  }

  const removalDueAt = new Date(
    Date.parse(provenance.createdAt) + gcAgeDays() * 86_400_000,
  );

  if (args.now < removalDueAt) {
    await holdReconciliationFinding({
      database: args.database,
      claim: args.claim,
      resultCode: "grace_period",
      now: args.now,
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
      now: args.now,
    });
    args.summary.quarantined += 1;
    return;
  }

  const renewedClaim = await renewReconciliationFindingClaim({
    database: args.database,
    claim: args.claim,
    now: args.now,
  });

  await removeOwnedWorktree({
    projectRepoPath: project.repoPath,
    worktreePath,
    allowedRoot: args.root,
    force: true,
  });
  await resolveReconciliationFinding({
    database: args.database,
    claim: renewedClaim,
    resultCode: "orphan_rescued_and_removed",
    rescue: { ref: rescueRef, commit: rescueCommit },
    now: args.now,
  });
  args.summary.preserved += 1;
  args.summary.removed += 1;
  args.summary.resolved += 1;
}

export async function runWorkspaceReconciliationSweep(
  options: RunWorkspaceReconciliationSweepOptions = {},
): Promise<WorkspaceReconciliationSummary> {
  const database = options.database ?? getDb();
  const root = options.root ?? worktreesRoot();
  const now = options.now?.() ?? new Date();
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
  const candidates = (await listCandidates(root)).slice(
    0,
    RECONCILIATION_BATCH_SIZE,
  );

  log.info({ scanned: candidates.length }, "workspace reconciliation sweep start");

  for (const candidate of candidates) {
    summary.scanned += 1;
    const observation = candidateObservation(candidate);
    const findingId = await observeReconciliationFinding({
      database,
      observation,
      now,
    });
    const claim = await claimReconciliationFinding({
      database,
      findingId,
      now,
    });

    if (claim === null) {
      summary.retained += 1;
      continue;
    }

    if (candidate.provenance === null) {
      await quarantineReconciliationFinding({
        database,
        claim,
        errorCode: candidate.reasonCode ?? "untrusted_candidate",
        errorMessage: "candidate is not a trusted version 2 managed worktree",
        now,
      });
      summary.quarantined += 1;
      continue;
    }

    try {
      await processTrustedCandidate({
        database,
        root,
        candidate,
        claim,
        now,
        summary,
      });
    } catch (error) {
      if (isMaisterError(error) && error.code === "PRECONDITION") {
        await quarantineReconciliationFinding({
          database,
          claim,
          errorCode: "trust_refusal",
          errorMessage: "candidate failed a reconciliation trust precondition",
          now,
        });
        summary.quarantined += 1;
      } else {
        await retryReconciliationFinding({
          database,
          claim,
          errorCode: "reconciliation_action_failed",
          errorMessage: "reconciliation action failed before durable completion",
          now,
        });
        summary.retryableFailed += 1;
      }

      log.warn(
        {
          findingId,
          relativePath: candidate.relativePath,
          errorType: error instanceof Error ? error.name : "unknown",
        },
        "workspace reconciliation candidate deferred",
      );
    }
  }

  log.info(summary, "workspace reconciliation sweep complete");

  return summary;
}
