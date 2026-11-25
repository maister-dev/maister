import "server-only";

import { createHash } from "node:crypto";

import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { assertRunKnowledgeDisclosure } from "@/lib/brain/knowledge-run-disclosure";
import * as schemaModule from "@/lib/db/schema";
import { getCachedPreparedDiff, setCachedPreparedDiff } from "@/lib/diff/cache";
import {
  filterDiffByPath,
  prepareDiff,
  prepareDiffSummary,
  type DiffPrepResult,
} from "@/lib/diff/prepare";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  filterReviewableChangeEntries,
  isReviewableChangeEntry,
} from "@/lib/runs/reviewable-changes";
import {
  isRunDiffScope,
  RUN_DIFF_SCOPES,
  type RunDiffScope,
} from "@/lib/runs/diff-scopes";
import { readReviewSource } from "@/lib/runs/review-source";
import {
  type DiffFileEntry,
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

// M30 (ADR-082): the diff scope switcher. `run` stays the default
// (workspace base → branch); the other scopes resolve their base from
// server-state rows and degrade gracefully when that base does not exist
// (disabled in the availability map; a direct request gets PRECONDITION).
type DiffScope = RunDiffScope;

type ScopeAvailability = Record<
  DiffScope,
  { available: boolean; reason?: string }
>;

type PreparedDiffResult =
  | { prepared: DiffPrepResult; renderUnavailableReason: null }
  | { prepared: DiffPrepResult; renderUnavailableReason: "prepare-failed" };

type EnrichedDiffFile = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
};

function enrichDiffFiles(
  nameStatus: DiffFileEntry[],
  prepared: DiffPrepResult,
): EnrichedDiffFile[] {
  const countsByPath = new Map(prepared.files.map((f) => [f.path, f]));

  return nameStatus.map((entry) => {
    const counts = countsByPath.get(entry.path);

    return {
      path: entry.path,
      status: entry.status,
      additions: counts?.additions ?? 0,
      deletions: counts?.deletions ?? 0,
    };
  });
}

function contentCacheKey(diff: string, truncated: boolean): string {
  const digest = createHash("sha256").update(diff).digest("hex");

  return `content:${digest}:${truncated}`;
}

// Splice pre-serialized `perFile` JSON directly into the envelope so cache hits
// never re-stringify the syntax bundles (PERF-14).
function assembleDiffHttpJson(
  envelopeWithoutPerFile: Record<string, unknown>,
  perFileJson: string,
  rawDiff?: string,
): string {
  const payload =
    rawDiff !== undefined
      ? { ...envelopeWithoutPerFile, diff: rawDiff }
      : envelopeWithoutPerFile;
  const serializedEnvelope = JSON.stringify(payload);

  if (serializedEnvelope === "{}") {
    return `{"perFile":${perFileJson}}`;
  }

  return `${serializedEnvelope.slice(0, -1)},"perFile":${perFileJson}}`;
}

function readCommitRangeDiff(input: {
  scope: "run" | "since-last-review" | "last-node";
  worktreePath: string;
  base: string;
  branch: string;
}): Promise<{ text: string; truncated: boolean }> {
  return input.scope === "run"
    ? diffRunWorkspace({
        projectRepoPath: input.worktreePath,
        baseCommit: input.base,
        branch: input.branch,
      })
    : diffRange({
        worktreePath: input.worktreePath,
        baseRef: input.base,
        branch: input.branch,
      });
}

async function resolveCachedOrPrepare(input: {
  cacheKey: string;
  runId: string;
  scope: DiffScope;
  diff: string;
  truncated: boolean;
  nameStatus: DiffFileEntry[];
}): Promise<{
  files: EnrichedDiffFile[];
  prepared: DiffPrepResult;
  preparedJson: string;
  renderUnavailableReason: "prepare-failed" | null;
  cacheHit: boolean;
}> {
  const cached = getCachedPreparedDiff(input.cacheKey);

  if (cached) {
    return {
      files: enrichDiffFiles(input.nameStatus, cached.prepared),
      prepared: cached.prepared,
      preparedJson: cached.preparedJson,
      renderUnavailableReason: null,
      cacheHit: true,
    };
  }

  const { prepared, renderUnavailableReason } = await prepareDiffForResponse({
    runId: input.runId,
    scope: input.scope,
    diff: input.diff,
    truncated: input.truncated,
  });
  const files = enrichDiffFiles(input.nameStatus, prepared);
  const preparedJson = JSON.stringify(prepared.perFile);

  if (renderUnavailableReason === null) {
    setCachedPreparedDiff(input.cacheKey, {
      files,
      prepared,
      preparedJson,
      byteSize: Buffer.byteLength(preparedJson, "utf8"),
    });
  }

  return {
    files,
    prepared,
    preparedJson,
    renderUnavailableReason,
    cacheHit: false,
  };
}

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

  if (!isRunDiffScope(raw)) {
    throw new MaisterError(
      "CONFIG",
      `invalid diff scope ${JSON.stringify(raw)} — expected one of ${RUN_DIFF_SCOPES.join("|")}`,
    );
  }

  return raw;
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

// M37 (ADR-102): resolve the shared TREE workspace for a writable shared child
// (READ path). A shared writable tree is ONE git worktree owned by the ALLOCATOR
// child's `workspaces` row; a REUSER child of the same tree (`root_run_id`)
// carries NO row of its own. Find the allocator's row by joining `runs` on
// `(root_run_id, workspace_mode='shared', agent_workspace='worktree')` so every
// shared child renders the one shared diff. No FOR UPDATE — read-only.
async function resolveSharedTreeWorkspaceForRead(
  db: Db,
  run: { rootRunId?: string | null },
) {
  if (!run.rootRunId) {
    throw new MaisterError(
      "PRECONDITION",
      "shared-tree diff: run has no root_run_id",
    );
  }

  const rows = await db
    .select()
    .from(workspaces)
    .innerJoin(runs, eq(runs.id, workspaces.runId))
    .where(
      and(
        eq(runs.rootRunId, run.rootRunId),
        eq(runs.workspaceMode, "shared"),
        eq(runs.agentWorkspace, "worktree"),
      ),
    );

  return rows[0]?.workspaces ?? null;
}

// The run is already loaded + authorized by the caller; this only fetches the
// workspace + project (no redundant run round-trip).
async function loadFlowDiffRows(
  db: Db,
  run: {
    id: string;
    projectId: string;
    runKind?: string;
    workspaceMode?: string | null;
    agentWorkspace?: string | null;
    rootRunId?: string | null;
  },
) {
  const isSharedTreeChild =
    run.runKind === "agent" &&
    run.workspaceMode === "shared" &&
    run.agentWorkspace === "worktree" &&
    run.rootRunId != null;

  const [workspace, projectRows] = await Promise.all([
    isSharedTreeChild
      ? resolveSharedTreeWorkspaceForRead(db, run)
      : db
          .select()
          .from(workspaces)
          .where(eq(workspaces.runId, run.id))
          .then((rows: any[]) => rows[0] ?? null),
    db.select().from(projects).where(eq(projects.id, run.projectId)),
  ]);
  const project = projectRows[0];

  if (!workspace) {
    throw new MaisterError("PRECONDITION", `workspace not found: ${run.id}`);
  }
  if (isSharedTreeChild) {
    log.debug(
      {
        runId: run.id,
        rootRunId: run.rootRunId,
        workspaceId: workspace.id,
        worktreePath: workspace.worktreePath,
      },
      "[diff] resolved shared tree workspace for reuser child",
    );
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
  const startedAt = performance.now();
  const { runId } = await params;

  try {
    const user = await requireActiveSession();
    const recipient = { kind: "user" as const, userId: user.id };

    const scope = parseScope(req);
    const includeRaw = new URL(req.url).searchParams.get("raw") === "1";

    const db = getDb() as unknown as Db;
    const run = await loadRun(db, runId);

    if (!run) {
      return NextResponse.json({ message: "not found" }, { status: 404 });
    }

    if (run.runKind === "scratch") {
      if (scope === "review") {
        throw new MaisterError(
          "PRECONDITION",
          "review diff scope is available only for Flow runs",
        );
      }

      const { scratch, workspace } = await loadScratchDiffRows(db, runId);

      await requireProjectAction(run.projectId, "readScratchRun");
      await assertRunKnowledgeDisclosure(getDb(), recipient, runId);

      const targetBranch = scratch.targetBranch ?? scratch.baseBranch;
      // The scratch agent edits files without committing, so the diff must be
      // base commit → WORKING TREE (committed + uncommitted + untracked), not
      // the commit-range `base..branch` (which is empty until a commit lands).
      // Untracked files render as additions via the intent-to-add temp index.
      const {
        text: diff,
        truncated,
        nameStatus,
      } = await diffWorkingTree(workspace.worktreePath, scratch.baseCommit);
      const {
        files,
        prepared,
        preparedJson,
        renderUnavailableReason,
        cacheHit,
      } = await resolveCachedOrPrepare({
        cacheKey: contentCacheKey(diff, truncated),
        runId,
        scope: "run",
        diff,
        truncated,
        nameStatus,
      });

      await assertRunKnowledgeDisclosure(getDb(), recipient, runId);

      const bodyJson = assembleDiffHttpJson(
        {
          runId,
          scope: "run",
          scopes: { run: { available: true } },
          baseCommit: scratch.baseCommit,
          sourceBranch: workspace.branch,
          targetBranch,
          truncated: prepared.truncated,
          files,
          renderUnavailableReason,
        },
        preparedJson,
        includeRaw ? diff : undefined,
      );
      const responseBytes = Buffer.byteLength(bodyJson, "utf8");

      log.debug(
        {
          runId,
          scope: "run",
          base: scratch.baseCommit,
          headSha: null,
          cacheHit,
          includeRaw,
          fileCount: files.length,
          responseBytes,
          durationMs: Math.round(performance.now() - startedAt),
        },
        "[diff-scope] resolved",
      );

      return new NextResponse(bodyJson, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    await requireProjectAction(run.projectId, "readBoard");
    await assertRunKnowledgeDisclosure(getDb(), recipient, runId);

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
      review: { available: true },
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
    let headSha: string | null = null;
    let reviewSourceFingerprint: string | null = null;
    let files: EnrichedDiffFile[];
    let prepared: DiffPrepResult;
    let preparedJson: string;
    let renderUnavailableReason: "prepare-failed" | null;
    let cacheHit = false;
    let rawDiff: string | undefined;

    if (scope === "review") {
      base =
        workspace.baseCommit ??
        (await resolveBaseRef({
          worktreePath: workspace.worktreePath,
          branch: workspace.branch,
          mainBranch: project.mainBranch,
        }));
      const source = await readReviewSource({
        worktreePath: workspace.worktreePath,
        baseCommit: base,
      });

      reviewSourceFingerprint = source.fingerprint;
      const resolved = await resolveCachedOrPrepare({
        cacheKey: `review:${source.fingerprint}`,
        runId,
        scope,
        diff: source.diff,
        truncated: source.truncated,
        nameStatus: source.nameStatus,
      });

      files = resolved.files;
      prepared = resolved.prepared;
      preparedJson = resolved.preparedJson;
      renderUnavailableReason = resolved.renderUnavailableReason;
      cacheHit = resolved.cacheHit;
      rawDiff = includeRaw ? source.diff : undefined;
    } else if (scope === "uncommitted") {
      base = await headCommit({ worktreePath: workspace.worktreePath });
      const wtDiff = await diffWorkingTree(workspace.worktreePath);
      const diff = filterDiffByPath(wtDiff.text, (path, oldPath) =>
        isReviewableChangeEntry({ path, oldPath }),
      );
      const nameStatus = filterReviewableChangeEntries(wtDiff.nameStatus);
      const resolved = await resolveCachedOrPrepare({
        cacheKey: contentCacheKey(diff, wtDiff.truncated),
        runId,
        scope,
        diff,
        truncated: wtDiff.truncated,
        nameStatus,
      });

      files = resolved.files;
      prepared = resolved.prepared;
      preparedJson = resolved.preparedJson;
      renderUnavailableReason = resolved.renderUnavailableReason;
      cacheHit = resolved.cacheHit;
      rawDiff = includeRaw ? diff : undefined;
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

      headSha = await resolveRefSha(
        workspace.worktreePath,
        workspace.branch,
      ).catch(() => null);
      const cacheKey = headSha
        ? `sha:${workspace.worktreePath}:${base}:${headSha}`
        : null;
      const cached = cacheKey ? getCachedPreparedDiff(cacheKey) : undefined;

      if (cached) {
        cacheHit = true;
        prepared = cached.prepared;
        preparedJson = cached.preparedJson;
        files = enrichDiffFiles(cached.files, cached.prepared);
        renderUnavailableReason = null;

        if (includeRaw) {
          const ranged = await readCommitRangeDiff({
            scope,
            worktreePath: workspace.worktreePath,
            base,
            branch: workspace.branch,
          });

          rawDiff = ranged.text;
        }
      } else {
        const ranged = await readCommitRangeDiff({
          scope,
          worktreePath: workspace.worktreePath,
          base,
          branch: workspace.branch,
        });
        const nameStatus = await diffNameStatus({
          worktreePath: workspace.worktreePath,
          baseRef: base,
          branch: workspace.branch,
        });
        const prep = await prepareDiffForResponse({
          runId,
          scope,
          diff: ranged.text,
          truncated: ranged.truncated,
        });

        prepared = prep.prepared;
        renderUnavailableReason = prep.renderUnavailableReason;
        files = enrichDiffFiles(nameStatus, prepared);
        preparedJson = JSON.stringify(prepared.perFile);
        rawDiff = includeRaw ? ranged.text : undefined;

        if (cacheKey && renderUnavailableReason === null) {
          setCachedPreparedDiff(cacheKey, {
            files,
            prepared,
            preparedJson,
            byteSize: Buffer.byteLength(preparedJson, "utf8"),
          });
        }
      }
    }

    await assertRunKnowledgeDisclosure(getDb(), recipient, runId);

    const bodyJson = assembleDiffHttpJson(
      {
        runId,
        scope,
        scopes,
        baseCommit: base,
        sourceBranch: workspace.branch,
        targetBranch:
          workspace.targetBranch ?? workspace.baseBranch ?? project.mainBranch,
        reviewSourceFingerprint,
        truncated: prepared.truncated,
        files,
        renderUnavailableReason,
      },
      preparedJson,
      rawDiff,
    );
    const responseBytes = Buffer.byteLength(bodyJson, "utf8");

    log.debug(
      {
        runId,
        scope,
        base,
        headSha,
        cacheHit,
        includeRaw,
        fileCount: files.length,
        responseBytes,
        durationMs: Math.round(performance.now() - startedAt),
        reviewSourceFingerprint,
      },
      "[diff-scope] resolved",
    );

    return new NextResponse(bodyJson, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return errorResponse(err, runId);
  }
}
