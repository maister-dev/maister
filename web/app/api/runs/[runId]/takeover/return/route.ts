import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import {
  completeAssignment,
  ensureUserActor,
  findActiveAssignmentForRun,
} from "@/lib/assignments/service";
import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { compileManifest } from "@/lib/flows/graph/compile";
import {
  getActiveTakeover,
  markDownstreamStale,
  recordTakeoverReturn,
} from "@/lib/flows/graph/ledger";
import {
  getCurrentRequiredForGitArtifacts,
  recordArtifact,
  supersedePrior,
} from "@/lib/flows/graph/artifact-store";
import { downstreamOf } from "@/lib/flows/graph/runner-graph";
import { loadRun } from "@/lib/flows/graph/runner-core";
import { runFlow } from "@/lib/flows/runner";
import { loadProjectMainBranch } from "@/lib/runs/takeover-context";
import { markReturnedToRunning } from "@/lib/runs/state-transitions";
import {
  DIFF_TRUNCATED_MARKER,
  diffRange,
  logRange,
  resolveBaseRef,
  resolveRefSha,
  statusPorcelain,
} from "@/lib/worktree";
import * as schemaModule from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants — Db handle.
type Db = any;

const log = pino({
  name: "api-takeover-return",
  level: process.env.LOG_LEVEL ?? "info",
});

// return: 200 / 401 / 403 / 404 / 409 / 503. No new MaisterError code (ADR-008):
// not-HumanWorking → 409 PRECONDITION; non-owner → 403 UNAUTHORIZED; git op fails
// → 409 CONFLICT (no ledger write, no flip); ledger/stale throw mid-side-effect
// → 503 EXECUTOR_UNAVAILABLE (stays HumanWorking).
function httpStatusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
    case "ACCOUNT_INACTIVE":
      return 403;
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
    case "EXECUTOR_UNAVAILABLE":
      return 503;
    default:
      return 500;
  }
}

function errorResponse(err: unknown, ctx: { runId: string }): NextResponse {
  if (isMaisterError(err)) {
    const status = httpStatusForCode(err.code);

    log.warn(
      { ...ctx, code: err.code, message: err.message, status },
      "takeover return error",
    );

    return NextResponse.json(
      { code: err.code, message: err.message },
      { status },
    );
  }
  const message = err instanceof Error ? err.message : String(err);

  log.error({ ...ctx, err: message }, "takeover return unhandled error");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

function isPostgres(): boolean {
  const url = process.env.DB_URL ?? "";

  return url.startsWith("postgres://") || url.startsWith("postgresql://");
}

type RouteParams = { params: Promise<{ runId: string }> };

export async function POST(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    // Auth-first. Body is EMPTY — every ref/path/owner is server-state.
    const user = await requireActiveSession();

    const db = getDb() as Db;

    let loaded;

    try {
      loaded = await loadRun(db, runId);
    } catch (err) {
      if (isMaisterError(err) && err.code === "PRECONDITION") {
        return NextResponse.json(
          { code: "PRECONDITION", message: `run not found: ${runId}` },
          { status: 404 },
        );
      }
      throw err;
    }

    const run = loaded.run;

    await requireProjectAction(run.projectId, "answerHitl");

    // ---- Phase 1: intent read (no AFTER-side marker yet) -------------------
    // FOR UPDATE on the run row: assert HumanWorking AND owner == session user.
    // The owner is the recorded `owner_user_id` on the active takeover row.
    const intent = await db.transaction(async (tx: Db) => {
      const rows = isPostgres()
        ? await tx.select().from(runs).where(eq(runs.id, runId)).for("update")
        : await tx.select().from(runs).where(eq(runs.id, runId));
      const fresh = rows[0];

      if (!fresh) {
        throw new MaisterError("PRECONDITION", `run not found: ${runId}`);
      }
      if (fresh.status !== "HumanWorking") {
        throw new MaisterError(
          "PRECONDITION",
          `run ${runId} is not HumanWorking (got ${fresh.status}); nothing to return`,
        );
      }

      const active = await getActiveTakeover(runId, tx);

      if (!active) {
        throw new MaisterError(
          "PRECONDITION",
          `run ${runId} has no active takeover to return`,
        );
      }
      if (active.ownerUserId !== user.id) {
        throw new MaisterError(
          "UNAUTHORIZED",
          `run ${runId} takeover is owned by another user; return is owner-only`,
        );
      }

      return {
        nodeId: active.nodeId,
        nodeAttemptId: active.id,
        attempt: active.attempt,
      };
    });

    const nodeId = intent.nodeId;
    const nodeAttemptId = intent.nodeAttemptId;
    const attempt = intent.attempt;
    const { worktreePath, branch } = loaded.workspace;

    // Resolve the validation re-entry from the human_review node's
    // transitions.takeover target (server-state; NOT body-controlled).
    const graph = compileManifest(loaded.manifest);
    const reviewNode = graph.nodes.get(nodeId);
    const reentryNode = reviewNode?.transitions.takeover;

    if (!reentryNode) {
      throw new MaisterError(
        "PRECONDITION",
        `node ${nodeId} of run ${runId} declares no transitions.takeover re-entry`,
      );
    }

    log.info(
      { runId, nodeId, reentryNode, ownerUserId: user.id },
      "takeover return phase 1 — intent verified",
    );

    // ---- Phase 2a: git side-effect (read-only) ----------------------------
    // A git failure leaves the run HumanWorking with NO ledger write, NO status
    // flip → 409 CONFLICT (worktree.ts throws CONFLICT on git failure). This is
    // BEFORE any ledger mutation so the failure table's "git op fails" row holds.
    //
    // The recorded return is the COMMIT-ref-only `base..branch` log/diff:
    // uncommitted tracked edits + untracked files are NOT captured. Refuse a
    // dirty worktree (the reviewer would silently lose work + get misleading
    // evidence) and refuse an empty (zero-commit) return BEFORE any ledger
    // write, so both stay in the "no state change, retryable" failure class.
    const porcelain = await statusPorcelain({ worktreePath });

    if (porcelain.trim().length > 0) {
      throw new MaisterError(
        "CONFLICT",
        `run ${runId} worktree has uncommitted changes — commit or discard before returning`,
      );
    }

    const mainBranch = await loadProjectMainBranch(run.projectId, db);
    const baseRef = await resolveBaseRef({ worktreePath, branch, mainBranch });
    const returnedCommits = await logRange({ worktreePath, baseRef, branch });
    const returnedRange = await diffRange({ worktreePath, baseRef, branch });
    // An oversized returned diff keeps its in-band marker so the stored evidence
    // text still flags the cut (this surface has no structured channel).
    const returnedDiff = returnedRange.truncated
      ? returnedRange.text + DIFF_TRUNCATED_MARKER
      : returnedRange.text;

    // F3: store the immutable head SHA in the git artifact locators so their
    // payloads render the returned range, not the live branch tip. Branch-name
    // fallback for parity with the runner (git is available here in practice).
    let headRef = branch;

    try {
      headRef = await resolveRefSha(worktreePath, branch);
    } catch (err) {
      // keep the branch name when git cannot resolve the SHA
      log.warn(
        { runId, nodeId, branch, err: (err as Error).message },
        "resolveRefSha failed — storing mutable branch headRef",
      );
    }

    const commitCountPre = returnedCommits
      .split("\n")
      .filter((l) => l.length > 0).length;

    if (commitCountPre === 0) {
      throw new MaisterError(
        "CONFLICT",
        `run ${runId} has no commits to return — release or commit first`,
      );
    }

    log.info(
      { runId, nodeId, baseRef, commitCount: commitCountPre },
      "takeover return phase 2a — git log/diff captured",
    );

    // ---- Phase 2b: ledger + AFTER-side flip (single transaction) ----------
    // All FOUR post-return writes commit atomically so there is NO observable
    // intermediate state a crash or 503-retry could strand on:
    //   1. recordTakeoverReturn   — end the takeover row (endedAt + diff).
    //   2. markDownstreamStale    — stale the re-entry node + its gates.
    //   3. markReturnedToRunning  — CAS HumanWorking → Running.
    //   4. cursor write           — park current_step_id at the re-entry.
    // Two crash windows the bare two-step (tx then bare 3+4) left open are now
    // closed: (a) tx committed but the run never flipped Running → permanently
    // stranded (getActiveTakeover filters endedAt IS NULL → null on retry, and
    // the F3 sweep filters status='Running'); (b) flipped Running but cursor
    // still at the REVIEW node → F3 re-dispatches at the wrong node. Folding 3+4
    // into the same tx means whenever status is Running the cursor is correct.
    // A non-MaisterError throw inside the tx → 503 EXECUTOR_UNAVAILABLE (run
    // stays HumanWorking, tx rolled back, retryable). A MaisterError (the lost
    // CAS) re-throws as 409 PRECONDITION.
    //
    // N2: the status-guarded CAS (HumanWorking → Running) — NOT the released
    // Phase-1 FOR UPDATE lock — is the serialization point for concurrent
    // duplicate returns: the Phase-1 lock is released when its tx commits, so a
    // second request can pass Phase 1; the loser is caught here when the CAS
    // finds the row already Running ({ok:false} → PRECONDITION → 409).
    try {
      await db.transaction(async (tx: Db) => {
        await recordTakeoverReturn({
          runId,
          nodeId,
          baseRef,
          returnedCommits,
          returnedDiff,
          db: tx,
        });

        // Record commit_set and diff artifacts for this takeover return.
        // Both store the immutable head SHA (F3) so evidence consumers resolve
        // the exact commits the human reviewer produced, regardless of later
        // branch advances.
        await recordArtifact(
          {
            id: `run:${nodeAttemptId}:takeover:commit_set`,
            runId,
            nodeAttemptId,
            nodeId,
            attempt,
            artifactDefId: `takeover:${nodeId}:commit_set`,
            kind: "commit_set",
            producer: "takeover",
            locator: { kind: "git-log", baseRef, headRef },
          },
          tx,
        );

        await recordArtifact(
          {
            id: `run:${nodeAttemptId}:takeover:diff`,
            runId,
            nodeAttemptId,
            nodeId,
            attempt,
            artifactDefId: `takeover:${nodeId}:diff`,
            kind: "diff",
            producer: "takeover",
            locator: {
              kind: "git-range",
              baseCommit: baseRef,
              headRef,
            },
          },
          tx,
        );

        // Stale the re-entry node AND its downstream. downstreamOf excludes its
        // start node, so include the gate-bearing re-entry explicitly.
        await markDownstreamStale(
          runId,
          [reentryNode, ...downstreamOf(graph, reentryNode)],
          tx,
        );

        // C2: re-pin every STILL-current requiredFor:[review|merge] git artifact
        // (the upstream `impl-diff` etc.) to the post-takeover branch tip, so the
        // review/merge evidence reflects the FULL cumulative diff base..tip —
        // including the reviewer's takeover commits — not the pre-takeover range
        // frozen when the producing node ran. Runs AFTER markDownstreamStale, so
        // downstream requiredFor artifacts (already staled, to be re-produced by
        // the re-run) are excluded; only upstream ones that will NOT be
        // re-produced are refreshed. Each refresh supersedes the stale-pinned row
        // in the same transaction (atomic).
        const toRefresh = await getCurrentRequiredForGitArtifacts(runId, tx);

        for (const art of toRefresh) {
          const refreshedLocator =
            art.kind === "commit_set"
              ? { kind: "git-log" as const, baseRef, headRef }
              : { kind: "git-range" as const, baseCommit: baseRef, headRef };

          const { id: refreshedId } = await recordArtifact(
            {
              id: `${art.id}:rt:${nodeAttemptId}`,
              runId,
              nodeAttemptId: art.nodeAttemptId,
              nodeId: art.nodeId,
              attempt: art.attempt,
              artifactDefId: art.artifactDefId,
              kind: art.kind,
              producer: "takeover",
              locator: refreshedLocator,
              validity: "current",
              requiredFor: art.requiredFor,
              visibility: art.visibility,
              retention: art.retention,
            },
            tx,
          );

          await supersedePrior(
            runId,
            art.nodeId as string,
            art.artifactDefId as string,
            refreshedId,
            tx,
          );
        }

        const flipped = await markReturnedToRunning(runId, { db: tx });

        if (!flipped.ok) {
          // Lost the AFTER-side CAS (a concurrent return already flipped it).
          // Throwing a MaisterError rolls the whole tx back and re-throws as a
          // 409 PRECONDITION (the side-effects of the winning return already
          // committed; this duplicate is a no-op).
          throw new MaisterError(
            "PRECONDITION",
            `run ${runId} was already returned by a concurrent request`,
          );
        }

        await tx
          .update(runs)
          .set({ currentStepId: reentryNode })
          .where(eq(runs.id, runId));

        const actor = await ensureUserActor({
          db: tx,
          projectId: run.projectId,
          userId: user.id,
          label: user.name ?? user.email ?? user.id,
        });
        const manualAssignment = await findActiveAssignmentForRun({
          db: tx,
          runId,
          actionKinds: ["manual_takeover"],
        });

        if (manualAssignment) {
          await completeAssignment({
            db: tx,
            assignmentId: manualAssignment.id,
            actorId: actor.id,
            eventKind: "returned",
            payload: {
              nodeId,
              nodeAttemptId,
              reentryNode,
              baseRef,
              headRef,
              returnedCommitCount: commitCountPre,
            },
          });
        }
      });
    } catch (err) {
      if (isMaisterError(err)) throw err;
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        `takeover return ledger write failed for run ${runId}: ${
          (err as Error).message
        }`,
        { cause: err as Error },
      );
    }

    log.info(
      { runId, nodeId, reentryNode },
      "takeover return phase 2b — return recorded, downstream staled, flipped Running, parked at re-entry",
    );

    // ---- Phase 3: resume ---------------------------------------------------
    // The post-return state is fully committed. Queue the live resume; a process
    // death before it runs is recovered by the F3 startup sweep
    // (runTakeoverReturnRecoverySweep), which reliably sees Running +
    // current_step_id=reentry + stale re-entry gates.
    queueMicrotask(
      () =>
        void runFlow(runId).catch((err: unknown) =>
          log.error(
            { runId, err: err instanceof Error ? err.message : String(err) },
            "background runFlow on takeover return failed",
          ),
        ),
    );

    return NextResponse.json(
      { ok: true, runStatus: "Running", returnedCommitCount: commitCountPre },
      { status: 200 },
    );
  } catch (err) {
    return errorResponse(err, { runId });
  }
}
