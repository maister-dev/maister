import "server-only";

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { prepareDiff } from "@/lib/diff/prepare";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  diffNameStatus,
  diffRunWorkspace,
  resolveBaseRef,
} from "@/lib/worktree";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs, scratchRuns, workspaces, projects } =
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
  _req: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    await requireActiveSession();

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

      return NextResponse.json({
        runId,
        baseCommit: scratch.baseCommit,
        sourceBranch: workspace.branch,
        targetBranch,
        diff,
        truncated,
      });
    }

    await requireProjectAction(run.projectId, "readBoard");

    const { workspace, project } = await loadFlowDiffRows(db, run);

    const base =
      workspace.baseCommit ??
      (await resolveBaseRef({
        worktreePath: workspace.worktreePath,
        branch: workspace.branch,
        mainBranch: project.mainBranch,
      }));
    const { text: diff, truncated } = await diffRunWorkspace({
      projectRepoPath: workspace.worktreePath,
      baseCommit: base,
      branch: workspace.branch,
    });
    const nameStatus = await diffNameStatus({
      worktreePath: workspace.worktreePath,
      baseRef: base,
      branch: workspace.branch,
    });
    const prepared = await prepareDiff(diff, truncated);
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
      baseCommit: base,
      sourceBranch: workspace.branch,
      targetBranch:
        workspace.targetBranch ?? workspace.baseBranch ?? project.mainBranch,
      diff,
      truncated: prepared.truncated,
      files,
      perFile: prepared.perFile,
    });
  } catch (err) {
    return errorResponse(err, runId);
  }
}
