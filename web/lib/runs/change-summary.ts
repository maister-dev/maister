import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { RunKind } from "@/lib/db/schema";
import type { DiffChangeStatEntry } from "@/lib/worktree";

import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { filterReviewableChangeEntries } from "@/lib/runs/reviewable-changes";
import { requireRunProjectId } from "@/lib/runs/run-kind-invariants";
import {
  diffChangeStats,
  diffWorkingTreeChangeStats,
  headCommit,
  repoRelPathSchema,
  resolveBaseRef,
  resolveRefSha,
} from "@/lib/worktree";

const { hitlRequests, nodeAttempts, projects, runs, scratchRuns, workspaces } =
  schema;

const log = pino({
  name: "run-change-summary",
  level: process.env.LOG_LEVEL ?? "info",
});

// FIXME(any): getDb() returns a pg|sqlite drizzle union; narrow to pg. POC = Postgres.
function db(): NodePgDatabase<typeof schema> {
  return getDb() as unknown as NodePgDatabase<typeof schema>;
}

export const RUN_CHANGE_SUMMARY_SCOPES = [
  "run",
  "since-last-review",
  "last-node",
  "uncommitted",
] as const;

export type RunChangeSummaryScope = (typeof RUN_CHANGE_SUMMARY_SCOPES)[number];

export type RunChangeSummaryScopeAvailability = Record<
  RunChangeSummaryScope,
  { available: boolean; reason?: string }
>;

export interface RunChangeSummaryFile {
  path: string;
  oldPath?: string;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface RunChangeSummaryResponse {
  runId: string;
  scope: RunChangeSummaryScope;
  scopes: RunChangeSummaryScopeAvailability;
  baseCommit: string;
  sourceBranch: string;
  targetBranch: string;
  fileCount: number;
  additions: number;
  deletions: number;
  dirty: boolean;
  truncated: boolean;
  unavailable: boolean;
  unavailableReason?: string;
  files: RunChangeSummaryFile[];
}

export interface RunChangeSummaryAccess {
  runId: string;
  // ADR-097: null for a project-less local-package assistant run. The route
  // rejects such runs (the project workspace-diff summary does not apply; the
  // Studio editor renders its own git-working-tree diff).
  projectId: string | null;
  runKind: RunKind;
}

type LoadedRun = {
  id: string;
  projectId: string | null;
  runKind: RunKind;
};

// The project-narrowed run handed to the workspace-diff helpers (after
// getRunChangeSummary rejects the project-less local-package variant, ADR-097).
type LoadedRunWithProject = LoadedRun & { projectId: string };

type LoadedWorkspace = {
  branch: string;
  worktreePath: string;
  parentRepoPath: string;
  baseBranch: string | null;
  baseCommit: string | null;
  targetBranch: string | null;
  removedAt: Date | null;
};

type LoadedProject = {
  id: string;
  mainBranch: string;
  repoPath: string;
};

type LoadedScratch = {
  baseBranch: string;
  baseCommit: string;
  targetBranch: string | null;
};

export function parseRunChangeSummaryScope(
  raw: string | null,
): RunChangeSummaryScope {
  const value = raw ?? "run";

  if (!(RUN_CHANGE_SUMMARY_SCOPES as readonly string[]).includes(value)) {
    throw new MaisterError(
      "CONFIG",
      `invalid change-summary scope ${JSON.stringify(value)} — expected one of ${RUN_CHANGE_SUMMARY_SCOPES.join("|")}`,
    );
  }

  return value as RunChangeSummaryScope;
}

export async function loadRunChangeSummaryAccess(
  runId: string,
): Promise<RunChangeSummaryAccess | null> {
  const rows = await db()
    .select({
      runId: runs.id,
      projectId: runs.projectId,
      runKind: runs.runKind,
    })
    .from(runs)
    .where(eq(runs.id, runId));
  const row = rows[0];

  return row
    ? {
        runId: row.runId,
        projectId: row.projectId,
        runKind: row.runKind,
      }
    : null;
}

async function loadRun(client: NodePgDatabase<typeof schema>, runId: string) {
  const rows = await client
    .select({
      id: runs.id,
      projectId: runs.projectId,
      runKind: runs.runKind,
    })
    .from(runs)
    .where(eq(runs.id, runId));

  return rows[0] ?? null;
}

async function loadWorkspaceProject(
  client: NodePgDatabase<typeof schema>,
  run: LoadedRunWithProject,
): Promise<{ workspace: LoadedWorkspace; project: LoadedProject }> {
  const [workspaceRows, projectRows] = await Promise.all([
    client
      .select({
        branch: workspaces.branch,
        worktreePath: workspaces.worktreePath,
        parentRepoPath: workspaces.parentRepoPath,
        baseBranch: workspaces.baseBranch,
        baseCommit: workspaces.baseCommit,
        targetBranch: workspaces.targetBranch,
        removedAt: workspaces.removedAt,
      })
      .from(workspaces)
      .where(eq(workspaces.runId, run.id)),
    client
      .select({
        id: projects.id,
        mainBranch: projects.mainBranch,
        repoPath: projects.repoPath,
      })
      .from(projects)
      .where(eq(projects.id, run.projectId)),
  ]);
  const workspace = workspaceRows[0];
  const project = projectRows[0];

  if (!workspace) {
    throw new MaisterError("PRECONDITION", `workspace not found: ${run.id}`);
  }
  if (workspace.removedAt) {
    throw new MaisterError(
      "PRECONDITION",
      `workspace already removed for run: ${run.id}`,
    );
  }
  if (!project) {
    throw new MaisterError("PRECONDITION", `project not found: ${run.id}`);
  }

  return { workspace, project };
}

async function loadScratch(
  client: NodePgDatabase<typeof schema>,
  runId: string,
): Promise<LoadedScratch> {
  const rows = await client
    .select({
      baseBranch: scratchRuns.baseBranch,
      baseCommit: scratchRuns.baseCommit,
      targetBranch: scratchRuns.targetBranch,
    })
    .from(scratchRuns)
    .where(eq(scratchRuns.runId, runId));
  const scratch = rows[0];

  if (!scratch) {
    throw new MaisterError(
      "PRECONDITION",
      `scratch metadata not found: ${runId}`,
    );
  }

  return scratch;
}

async function loadPriorReviewTipSha(
  client: NodePgDatabase<typeof schema>,
  runId: string,
): Promise<string | null> {
  const rows = await client
    .select({ reviewTipSha: hitlRequests.reviewTipSha })
    .from(hitlRequests)
    .where(
      and(
        eq(hitlRequests.runId, runId),
        eq(hitlRequests.kind, "human"),
        isNotNull(hitlRequests.respondedAt),
        isNotNull(hitlRequests.reviewTipSha),
      ),
    )
    .orderBy(desc(hitlRequests.createdAt))
    .limit(1);

  return rows[0]?.reviewTipSha ?? null;
}

async function loadLastNodeCheckpointRef(
  client: NodePgDatabase<typeof schema>,
  runId: string,
): Promise<string | null> {
  const rows = await client
    .select({ checkpointRef: nodeAttempts.checkpointRef })
    .from(nodeAttempts)
    .where(
      and(
        eq(nodeAttempts.runId, runId),
        inArray(nodeAttempts.nodeType, ["ai_coding", "cli"]),
        inArray(nodeAttempts.status, ["Succeeded", "Reworked", "Failed"]),
        isNotNull(nodeAttempts.checkpointRef),
      ),
    )
    .orderBy(desc(nodeAttempts.startedAt))
    .limit(1);

  return rows[0]?.checkpointRef ?? null;
}

function scratchScopeAvailability(): RunChangeSummaryScopeAvailability {
  return {
    run: { available: true },
    "since-last-review": {
      available: false,
      reason: "scratch runs do not have review visits",
    },
    "last-node": {
      available: false,
      reason: "scratch runs do not have flow node checkpoints",
    },
    uncommitted: { available: true },
  };
}

async function flowScopeAvailability(
  client: NodePgDatabase<typeof schema>,
  runId: string,
  worktreePath: string,
): Promise<{
  scopes: RunChangeSummaryScopeAvailability;
  priorReviewTipSha: string | null;
  lastNodeBaseSha: string | null;
}> {
  const priorReviewTipSha = await loadPriorReviewTipSha(client, runId);
  const lastNodeRef = await loadLastNodeCheckpointRef(client, runId);
  const lastNodeBaseSha = lastNodeRef
    ? await resolveRefSha(worktreePath, lastNodeRef).catch(() => null)
    : null;

  return {
    priorReviewTipSha,
    lastNodeBaseSha,
    scopes: {
      run: { available: true },
      "since-last-review": priorReviewTipSha
        ? { available: true }
        : { available: false, reason: "no prior review visit recorded" },
      "last-node": lastNodeBaseSha
        ? { available: true }
        : {
            available: false,
            reason: lastNodeRef
              ? "checkpoint ref no longer resolvable"
              : "no agent attempt with a checkpoint",
          },
      uncommitted: { available: true },
    },
  };
}

function assertScopeAvailable(
  scope: RunChangeSummaryScope,
  scopes: RunChangeSummaryScopeAvailability,
): void {
  if (scopes[scope].available) return;

  throw new MaisterError(
    "PRECONDITION",
    `change-summary scope "${scope}" unavailable: ${scopes[scope].reason}`,
  );
}

function validateRepoRelativePath(
  pathValue: string,
  fieldName: string,
): string {
  const parsed = repoRelPathSchema.safeParse(pathValue);

  if (!parsed.success) {
    const msg = parsed.error.issues.map((issue) => issue.message).join("; ");

    throw new MaisterError(
      "CONFLICT",
      `git change summary returned invalid ${fieldName}: ${msg}`,
    );
  }

  return parsed.data;
}

function toSummaryFile(entry: DiffChangeStatEntry): RunChangeSummaryFile {
  const file = {
    path: validateRepoRelativePath(entry.path, "path"),
    status: entry.status,
    additions: entry.additions,
    deletions: entry.deletions,
    binary: entry.binary,
  };

  return entry.oldPath
    ? {
        ...file,
        oldPath: validateRepoRelativePath(entry.oldPath, "oldPath"),
      }
    : file;
}

function buildResponse(input: {
  runId: string;
  scope: RunChangeSummaryScope;
  scopes: RunChangeSummaryScopeAvailability;
  baseCommit: string;
  sourceBranch: string;
  targetBranch: string;
  files: DiffChangeStatEntry[];
}): RunChangeSummaryResponse {
  const files = input.files.map(toSummaryFile);
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);

  return {
    runId: input.runId,
    scope: input.scope,
    scopes: input.scopes,
    baseCommit: input.baseCommit,
    sourceBranch: input.sourceBranch,
    targetBranch: input.targetBranch,
    fileCount: files.length,
    additions,
    deletions,
    dirty: input.scope === "uncommitted" && files.length > 0,
    truncated: false,
    unavailable: false,
    files,
  };
}

async function getScratchChangeSummary(input: {
  client: NodePgDatabase<typeof schema>;
  run: LoadedRunWithProject;
  scope: RunChangeSummaryScope;
}): Promise<RunChangeSummaryResponse> {
  const { workspace } = await loadWorkspaceProject(input.client, input.run);
  const scratch = await loadScratch(input.client, input.run.id);
  const scopes = scratchScopeAvailability();

  assertScopeAvailable(input.scope, scopes);

  if (input.scope === "uncommitted") {
    const [baseCommit, rawFiles] = await Promise.all([
      headCommit({ worktreePath: workspace.worktreePath }),
      diffWorkingTreeChangeStats(workspace.worktreePath),
    ]);
    const files = filterReviewableChangeEntries(rawFiles);

    return buildResponse({
      runId: input.run.id,
      scope: input.scope,
      scopes,
      baseCommit,
      sourceBranch: workspace.branch,
      targetBranch: scratch.targetBranch ?? scratch.baseBranch,
      files,
    });
  }

  // The default `run` scope diffs the launch base commit against the WORKING
  // TREE (committed + uncommitted + untracked) rather than `base..branch` — a
  // scratch agent edits files without committing, so the commit-range diff is
  // empty even though the worktree has changes. Untracked files render as
  // additions via the intent-to-add temp index (respects .gitignore).
  const files = filterReviewableChangeEntries(
    await diffWorkingTreeChangeStats(
      workspace.worktreePath,
      scratch.baseCommit,
    ),
  );

  return buildResponse({
    runId: input.run.id,
    scope: input.scope,
    scopes,
    baseCommit: scratch.baseCommit,
    sourceBranch: workspace.branch,
    targetBranch: scratch.targetBranch ?? scratch.baseBranch,
    files,
  });
}

async function getFlowChangeSummary(input: {
  client: NodePgDatabase<typeof schema>;
  run: LoadedRunWithProject;
  scope: RunChangeSummaryScope;
}): Promise<RunChangeSummaryResponse> {
  const { workspace, project } = await loadWorkspaceProject(
    input.client,
    input.run,
  );
  const availability = await flowScopeAvailability(
    input.client,
    input.run.id,
    workspace.worktreePath,
  );

  assertScopeAvailable(input.scope, availability.scopes);

  if (input.scope === "uncommitted") {
    const [baseCommit, rawFiles] = await Promise.all([
      headCommit({ worktreePath: workspace.worktreePath }),
      diffWorkingTreeChangeStats(workspace.worktreePath),
    ]);
    const files = filterReviewableChangeEntries(rawFiles);

    return buildResponse({
      runId: input.run.id,
      scope: input.scope,
      scopes: availability.scopes,
      baseCommit,
      sourceBranch: workspace.branch,
      targetBranch:
        workspace.targetBranch ?? workspace.baseBranch ?? project.mainBranch,
      files,
    });
  }

  const baseCommit =
    input.scope === "since-last-review"
      ? (availability.priorReviewTipSha as string)
      : input.scope === "last-node"
        ? (availability.lastNodeBaseSha as string)
        : (workspace.baseCommit ??
          (await resolveBaseRef({
            worktreePath: workspace.worktreePath,
            branch: workspace.branch,
            mainBranch: project.mainBranch,
          })));
  const files = await diffChangeStats({
    worktreePath: workspace.worktreePath,
    baseRef: baseCommit,
    branch: workspace.branch,
  });

  return buildResponse({
    runId: input.run.id,
    scope: input.scope,
    scopes: availability.scopes,
    baseCommit,
    sourceBranch: workspace.branch,
    targetBranch:
      workspace.targetBranch ?? workspace.baseBranch ?? project.mainBranch,
    files,
  });
}

export async function getRunChangeSummary(input: {
  runId: string;
  scope: RunChangeSummaryScope;
}): Promise<RunChangeSummaryResponse | null> {
  const client = db();
  const run = await loadRun(client, input.runId);

  if (!run) return null;
  // A project-less local-package run has no project workspace to summarize.
  const projectId = requireRunProjectId(run.projectId, run.id);
  const runWithProject = { ...run, projectId };

  try {
    const summary =
      run.runKind === "scratch"
        ? await getScratchChangeSummary({
            client,
            run: runWithProject,
            scope: input.scope,
          })
        : await getFlowChangeSummary({
            client,
            run: runWithProject,
            scope: input.scope,
          });

    log.info(
      {
        runId: run.id,
        projectId: run.projectId,
        scope: input.scope,
        fileCount: summary.fileCount,
        additions: summary.additions,
        deletions: summary.deletions,
      },
      "run change summary read",
    );

    return summary;
  } catch (err) {
    log.warn(
      {
        runId: run.id,
        projectId: run.projectId,
        scope: input.scope,
        code: err instanceof MaisterError ? err.code : "CRASH",
      },
      "run change summary failed",
    );

    throw err;
  }
}
