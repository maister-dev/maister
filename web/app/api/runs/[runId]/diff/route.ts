import "server-only";

import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import {
  filterDiffByPath,
  prepareDiff,
  prepareDiffSummary,
  type DiffPrepResult,
} from "@/lib/diff/prepare";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  filterReviewableChangeEntries,
  isReviewableChangePath,
} from "@/lib/runs/reviewable-changes";
import {
  diffNameStatus,
  diffRange,
  diffRunWorkspace,
  diffWorkingTree,
  headCommit,
  resolveBaseRef,
  resolveRefSha,
} from "@/lib/worktree";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs, scratchRuns, workspaces, projects, hitlRequests, nodeAttempts } =
  schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "api-run-diff",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ runId: string }> };
// FIXME(any): route tests use a minimal drizzle-like fake DB.
type Db = { select: any };

function httpStatusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
    case "ACCOUNT_INACTIVE":
      return 403;
    case "CONFIG":
      return 400;
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
    default:
      return 500;
  }
}

function errorResponse(err: unknown, runId: string): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: httpStatusForCode(err.code) },
    );
  }
  const message = err instanceof Error ? err.message : String(err);

  log.error({ runId, err: message }, "GET /api/runs/[runId]/diff");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

async function loadRun(db: Db, runId: string) {
  const runRows = await db.select().from(runs).where(eq(runs.id, runId));

  return runRows[0] ?? null;
}

async function loadScratchDiffRows(db: Db, runId: string) {
  const [scratchRows, workspaceRows] = await Promise.all([
    db.select().from(scratchRuns).where(eq(scratchRuns.runId, runId)),
    db.select().from(workspaces).where(eq(workspaces.runId, runId)),
  ]);
  const scratch = scratchRows[0];
  const workspace = workspaceRows[0];

  if (!scratch) {
    throw new MaisterError(
      "PRECONDITION",
      `scratch metadata not found: ${runId}`,
    );
  }
  if (!workspace) {
    throw new MaisterError("PRECONDITION", `workspace not found: ${runId}`);
  }
  if (workspace.removedAt) {
    throw new MaisterError(
      "PRECONDITION",
      `workspace already removed for run: ${runId}`,
    );
  }

  return { scratch, workspace };
}

// M30 (ADR-082): the 4-mode diff scope switcher. `run` stays the default
// (workspace base → branch); the other scopes resolve their base from
// server-state rows and degrade gracefully when that base does not exist
// (disabled in the availability map; a direct request gets PRECONDITION).
const DIFF_SCOPES = [
  "run",
  "since-last-review",
  "last-node",
  "uncommitted",
] as const;

type DiffScope = (typeof DIFF_SCOPES)[number];

type ScopeAvailability = Record<
  DiffScope,
  { available: boolean; reason?: string }
>;

type PreparedDiffResult =
  | { prepared: DiffPrepResult; renderUnavailableReason: null }
  | { prepared: DiffPrepResult; renderUnavailableReason: "prepare-failed" };

async function prepareDiffForResponse(input: {
  runId: string;
  scope: DiffScope;
  diff: string;
  truncated: boolean;
}): Promise<PreparedDiffResult> {
  try {
    return {
      prepared: await prepareDiff(input.diff, input.truncated),
      renderUnavailableReason: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const summary = prepareDiffSummary(input.diff, input.truncated);

    log.warn(
      {
        runId: input.runId,
        scope: input.scope,
        err: message,
        fileCount: summary.files.length,
      },
      "diff render preparation failed",
    );

    return {
      prepared: {
        files: summary.files,
        perFile: [],
        truncated: summary.truncated,
      },
      renderUnavailableReason: "prepare-failed",
    };
  }
}

function parseScope(req: Request): DiffScope {
  const raw = new URL(req.url).searchParams.get("scope") ?? "run";

  if (!(DIFF_SCOPES as readonly string[]).includes(raw)) {
    throw new MaisterError(
      "CONFIG",
      `invalid diff scope ${JSON.stringify(raw)} — expected one of ${DIFF_SCOPES.join("|")}`,
    );
  }

  return raw as DiffScope;
}

// Prior review visit = the most recent RESPONDED human HITL carrying a
// review_tip_sha. The currently-open visit has responded_at NULL, so it is
// excluded by construction.
async function loadPriorReviewTipSha(
  db: Db,
  runId: string,
): Promise<string | null> {
  const rows = await db
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

// Latest completed agent attempt carrying a checkpoint ref — the `last-node`
// base (exact even with zero/many agent commits, ADR-079/082).
async function loadLastNodeCheckpointRef(
  db: Db,
  runId: string,
): Promise<string | null> {
  const rows = await db
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

// The run is already loaded + authorized by the caller; this only fetches the
// workspace + project (no redundant run round-trip).
async function loadFlowDiffRows(
  db: Db,
  run: { id: string; projectId: string },
) {
  const [workspaceRows, projectRows] = await Promise.all([
    db.select().from(workspaces).where(eq(workspaces.runId, run.id)),
    db.select().from(projects).where(eq(projects.id, run.projectId)),
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

export async function GET(
  req: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    await requireActiveSession();

    const scope = parseScope(req);

    const db = getDb() as unknown as Db;
    const run = await loadRun(db, runId);

    if (!run) {
      return NextResponse.json({ message: "not found" }, { status: 404 });
    }

    if (run.runKind === "scratch") {
      const { scratch, workspace } = await loadScratchDiffRows(db, runId);

      await requireProjectAction(run.projectId, "readScratchRun");

      const targetBranch = scratch.targetBranch ?? scratch.baseBranch;
      const { text: diff, truncated } = await diffRunWorkspace({
        projectRepoPath: workspace.parentRepoPath,
        baseCommit: scratch.baseCommit,
        branch: workspace.branch,
      });
      // M35 (T3.3): scratch diffs now ride the prepared `files`/`perFile` shape
      // the shared <RunDiff> consumes, while keeping the raw `diff` string for
      // backward compatibility. Scratch has a single `run` scope (workspace
      // base -> branch) — the flow multi-scope base resolution does not apply.
      // The name-status runs in the parent repo, the same tree as the diff.
      const nameStatus = await diffNameStatus({
        worktreePath: workspace.parentRepoPath,
        baseRef: scratch.baseCommit,
        branch: workspace.branch,
      });
      const { prepared, renderUnavailableReason } =
        await prepareDiffForResponse({ runId, scope: "run", diff, truncated });
      const countsByPath = new Map(prepared.files.map((f) => [f.path, f]));
      const files = nameStatus.map((entry) => {
        const counts = countsByPath.get(entry.path);

        return {
          path: entry.path,
          status: entry.status,
          additions: counts?.additions ?? 0,
          deletions: counts?.deletions ?? 0,
        };
      });

      return NextResponse.json({
        runId,
        scope: "run",
        scopes: { run: { available: true } },
        baseCommit: scratch.baseCommit,
        sourceBranch: workspace.branch,
        targetBranch,
        diff,
        truncated: prepared.truncated,
        files,
        perFile: prepared.perFile,
        renderUnavailableReason,
      });
    }

    await requireProjectAction(run.projectId, "readBoard");

    const { workspace, project } = await loadFlowDiffRows(db, run);

    // Availability map (graceful degrade, ADR-082): resolve each scope's base
    // precondition once; the UI disables unavailable scopes with the reason.
    const priorReviewTipSha = await loadPriorReviewTipSha(db, runId);
    const lastNodeRef = await loadLastNodeCheckpointRef(db, runId);
    let lastNodeBaseSha: string | null = null;

    if (lastNodeRef) {
      // An orphaned/GC'd ref degrades the scope instead of erroring.
      lastNodeBaseSha = await resolveRefSha(
        workspace.worktreePath,
        lastNodeRef,
      ).catch(() => null);
    }

    const scopes: ScopeAvailability = {
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
    };

    if (!scopes[scope].available) {
      throw new MaisterError(
        "PRECONDITION",
        `diff scope "${scope}" unavailable: ${scopes[scope].reason}`,
      );
    }

    let base: string;
    let diff: string;
    let truncated: boolean;
    let nameStatus: Array<{ path: string; status: string }>;

    if (scope === "uncommitted") {
      base = await headCommit({ worktreePath: workspace.worktreePath });
      const wtDiff = await diffWorkingTree(workspace.worktreePath);

      diff = filterDiffByPath(wtDiff.text, isReviewableChangePath);
      truncated = wtDiff.truncated;
      nameStatus = filterReviewableChangeEntries(wtDiff.nameStatus);
    } else {
      if (scope === "since-last-review") {
        base = priorReviewTipSha as string;
      } else if (scope === "last-node") {
        base = lastNodeBaseSha as string;
      } else {
        base =
          workspace.baseCommit ??
          (await resolveBaseRef({
            worktreePath: workspace.worktreePath,
            branch: workspace.branch,
            mainBranch: project.mainBranch,
          }));
      }

      const ranged =
        scope === "run"
          ? await diffRunWorkspace({
              projectRepoPath: workspace.worktreePath,
              baseCommit: base,
              branch: workspace.branch,
            })
          : await diffRange({
              worktreePath: workspace.worktreePath,
              baseRef: base,
              branch: workspace.branch,
            });

      diff = ranged.text;
      truncated = ranged.truncated;
      nameStatus = await diffNameStatus({
        worktreePath: workspace.worktreePath,
        baseRef: base,
        branch: workspace.branch,
      });
    }

    const { prepared, renderUnavailableReason } = await prepareDiffForResponse({
      runId,
      scope,
      diff,
      truncated,
    });
    const countsByPath = new Map(prepared.files.map((f) => [f.path, f]));
    const files = nameStatus.map((entry) => {
      const counts = countsByPath.get(entry.path);

      return {
        path: entry.path,
        status: entry.status,
        additions: counts?.additions ?? 0,
        deletions: counts?.deletions ?? 0,
      };
    });

    log.debug({ runId, scope, base }, "[diff-scope] resolved");

    return NextResponse.json({
      runId,
      scope,
      scopes,
      baseCommit: base,
      sourceBranch: workspace.branch,
      targetBranch:
        workspace.targetBranch ?? workspace.baseBranch ?? project.mainBranch,
      diff,
      truncated: prepared.truncated,
      files,
      perFile: prepared.perFile,
      renderUnavailableReason,
    });
  } catch (err) {
    return errorResponse(err, runId);
  }
}
