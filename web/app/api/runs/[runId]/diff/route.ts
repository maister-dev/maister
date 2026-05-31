import "server-only";

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { diffRunWorkspace } from "@/lib/worktree";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs, scratchRuns, workspaces } = schemaModule as unknown as Record<
  string,
  any
>;

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

async function loadScratchDiffRows(db: Db, runId: string) {
  const runRows = await db.select().from(runs).where(eq(runs.id, runId));
  const run = runRows[0];

  if (!run) {
    throw new MaisterError("PRECONDITION", `run not found: ${runId}`);
  }
  if (run.runKind !== "scratch") {
    throw new MaisterError("PRECONDITION", `run is not scratch: ${runId}`);
  }

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

  return { run, scratch, workspace };
}

export async function GET(
  _req: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    await requireActiveSession();

    const db = getDb() as unknown as Db;
    const { run, scratch, workspace } = await loadScratchDiffRows(db, runId);

    await requireProjectAction(run.projectId, "readScratchRun");

    const targetBranch = scratch.targetBranch ?? scratch.baseBranch;
    const diff = await diffRunWorkspace({
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
    });
  } catch (err) {
    return errorResponse(err, runId);
  }
}
