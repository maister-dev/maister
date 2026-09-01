import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import {
  completeAssignment,
  ensureUserActor,
  findActiveAssignmentForRun,
} from "@/lib/assignments/service";
import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  getCurrentRequiredForGitArtifacts,
  recordArtifact,
  supersedePrior,
} from "@/lib/flows/graph/artifact-store";
import { compileManifest } from "@/lib/flows/graph/compile";
import {
  getActiveTakeover,
  getNodeAttemptsForRun,
  markDownstreamStale,
  recordTakeoverReturn,
  REVIEW_REWORK_CLAIM_DECISION,
} from "@/lib/flows/graph/ledger";
import { loadRun, loadRunProjectId } from "@/lib/flows/graph/runner-core";
import { downstreamOf } from "@/lib/flows/graph/runner-graph";
import { runFlow } from "@/lib/flows/runner";
import { countOperatorCommits } from "@/lib/runs/claim-head";
import { resolveReentryNode } from "@/lib/runs/reentry";
import { ingestForReworkReturn } from "@/lib/runs/rework-claim-ingest";
import { markReturnedToRunning } from "@/lib/runs/state-transitions";
import { loadProjectMainBranch } from "@/lib/runs/takeover-context";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";
import {
  DIFF_TRUNCATED_MARKER,
  diffRange,
  logRange,
  resolveBaseRef,
  resolveRefSha,
  statusPorcelain,
} from "@/lib/worktree";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants — Db handle.
type Db = any;

const log = pino({
  name: "api-rework-claim-return",
  level: process.env.LOG_LEVEL ?? "info",
});

// The only body field. Validated against the repo's ACTUAL remotes downstream —
// this is shape validation, the allow-list is server-state.
const bodySchema = z
  .object({ remote: z.string().min(1).max(100).optional() })
  .strict();

// return: 200 / 401 / 403 / 404 / 409 / 503. No new MaisterError code (ADR-008).
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
    case "CONFIG":
      return 400;
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
      "rework return refused",
    );

    // `details` carries the non-fast-forward evidence (failing command, both
    // SHAs, ahead/behind, copyable instructions) so the UI can render it.
    return NextResponse.json(
      {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
      { status },
    );
  }
  const message = err instanceof Error ? err.message : String(err);

  log.error({ ...ctx, err: message }, "rework return unhandled error");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

type RouteParams = { params: Promise<{ runId: string }> };

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    const user = await requireActiveSession();

    // Parse the body as an explicit step so malformed JSON maps to the
    // documented CONFIG family rather than an unhandled throw.
    let rawBody: unknown = {};

    const text = await req.text();

    if (text.trim().length > 0) {
      try {
        rawBody = JSON.parse(text);
      } catch {
        throw new MaisterError("CONFIG", "request body is not valid JSON");
      }
    }

    const parsed = bodySchema.safeParse(rawBody);

    if (!parsed.success) {
      throw new MaisterError(
        "CONFIG",
        `invalid body: ${parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ")}`,
      );
    }

    const db = getDb() as Db;
    const projectId = await loadRunProjectId(db, runId);

    if (!projectId) {
      return NextResponse.json(
        { code: "PRECONDITION", message: `run not found: ${runId}` },
        { status: 404 },
      );
    }

    await requireProjectAction(projectId, "answerHitl");

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

    // ---- Phase 1: intent read (no AFTER-side marker) -----------------------
    const intent = await db.transaction(async (tx: Db) => {
      const rows = await tx
        .select()
        .from(runs)
        .where(eq(runs.id, runId))
        .for("update");
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
          `run ${runId} has no open rework claim to return`,
        );
      }
      if (active.ownerUserId !== user.id) {
        throw new MaisterError(
          "UNAUTHORIZED",
          `run ${runId} rework claim is owned by another user; return is owner-only`,
        );
      }
      // An ADR-030 takeover must keep using its own route: its re-entry comes
      // from the parked node's `transitions.takeover`, not the ADR-160 chain.
      if (active.decision !== REVIEW_REWORK_CLAIM_DECISION) {
        throw new MaisterError(
          "PRECONDITION",
          `run ${runId} holds a manual takeover, not a rework claim — return it through /takeover/return`,
        );
      }

      return {
        nodeId: active.nodeId,
        nodeAttemptId: active.id,
        attempt: active.attempt,
        claimHeadSha: active.claimHeadSha ?? null,
      };
    });

    const { nodeId, nodeAttemptId, attempt } = intent;
    const { worktreePath, branch, parentRepoPath } = loaded.workspace;

    // Re-entry from the ADR-160 chain (server-state only, never body-derived).
    const graph = compileManifest(loaded.manifest);
    const ledger = await getNodeAttemptsForRun(runId, db);
    const reentry = resolveReentryNode(graph, ledger);

    if (!reentry.ok) {
      throw new MaisterError(
        "PRECONDITION",
        `run ${runId} has no re-entry node to return to — launch a new run from this branch instead`,
      );
    }

    const reentryNode = reentry.nodeId;

    log.info(
      {
        runId,
        nodeId,
        reentryNode,
        reentrySource: reentry.source,
        ownerUserId: user.id,
      },
      "rework return phase 1 — intent verified",
    );

    // ---- Phase 2a: git only, every refusal before any ledger write ---------
    // Ingest FIRST so work pushed from another machine is admitted before the
    // dirty/empty checks judge the tree.
    const ingest = await ingestForReworkReturn({
      runId,
      worktreePath,
      parentRepoPath,
      branch,
      remote: parsed.data.remote ?? null,
    });

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
    const returnedDiff = returnedRange.truncated
      ? returnedRange.text + DIFF_TRUNCATED_MARKER
      : returnedRange.text;

    let headRef = branch;

    try {
      headRef = await resolveRefSha(worktreePath, branch);
    } catch (err) {
      log.warn(
        { runId, nodeId, branch, err: (err as Error).message },
        "resolveRefSha failed — storing mutable branch headRef",
      );
    }

    // The merge-base range is the REVIEW evidence — the reviewer wants the whole
    // branch — but it cannot answer "did the operator commit anything", because
    // a run that reached Review already carries every commit its flow made.
    // That question is answered from the claim-time HEAD.
    const branchCommitCount = returnedCommits
      .split("\n")
      .filter((l) => l.length > 0).length;
    const operatorCommitCount = await countOperatorCommits({
      worktreePath,
      branch,
      claimHeadSha: intent.claimHeadSha,
      runId,
    });
    const commitCount = operatorCommitCount ?? branchCommitCount;

    if (commitCount === 0) {
      throw new MaisterError(
        "CONFLICT",
        `run ${runId} has no commits to return — release the claim instead`,
      );
    }

    log.info(
      {
        runId,
        nodeId,
        baseRef,
        commitCount,
        branchCommitCount,
        claimHeadSha: intent.claimHeadSha,
        fastForwarded: ingest.fastForwarded,
      },
      "rework return phase 2a — ingest + git evidence captured",
    );

    // ---- Phase 2b: ledger + AFTER-side flip (ONE transaction) --------------
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

        await recordArtifact(
          {
            id: `run:${nodeAttemptId}:rework:commit_set`,
            runId,
            nodeAttemptId,
            nodeId,
            attempt,
            artifactDefId: `rework:${nodeId}:commit_set`,
            kind: "commit_set",
            producer: "takeover",
            locator: { kind: "git-log", baseRef, headRef },
          },
          tx,
        );

        await recordArtifact(
          {
            id: `run:${nodeAttemptId}:rework:diff`,
            runId,
            nodeAttemptId,
            nodeId,
            attempt,
            artifactDefId: `rework:${nodeId}:diff`,
            kind: "diff",
            producer: "takeover",
            locator: { kind: "git-range", baseCommit: baseRef, headRef },
          },
          tx,
        );

        // downstreamOf excludes its start node, so include the gate-bearing
        // re-entry explicitly. Task 11A is what makes this call correct: the
        // claim row no longer shields the anchor node's real last execution.
        await markDownstreamStale(
          runId,
          [reentryNode, ...downstreamOf(graph, reentryNode)],
          tx,
        );

        const toRefresh = await getCurrentRequiredForGitArtifacts(runId, tx);

        for (const art of toRefresh) {
          const refreshedLocator =
            art.kind === "commit_set"
              ? { kind: "git-log" as const, baseRef, headRef }
              : { kind: "git-range" as const, baseCommit: baseRef, headRef };

          const { id: refreshedId } = await recordArtifact(
            {
              id: `${art.id}:rwc:${nodeAttemptId}`,
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
        const claimAssignment = await findActiveAssignmentForRun({
          db: tx,
          runId,
          actionKinds: ["manual_takeover"],
        });

        if (claimAssignment) {
          await completeAssignment({
            db: tx,
            assignmentId: claimAssignment.id,
            actorId: actor.id,
            eventKind: "returned",
            payload: {
              nodeId,
              nodeAttemptId,
              reentryNode,
              reentrySource: reentry.source,
              baseRef,
              headRef,
              returnedCommitCount: commitCount,
              fastForwarded: ingest.fastForwarded,
            },
          });
        }

        // ADR-086 exactly-once: same transaction as the domain write.
        await emitDomainEvent({
          db: tx,
          kind: "run.rework_returned",
          projectId: run.projectId,
          runId,
          taskId: run.taskId,
          actor: { type: "user", id: user.id },
          payload: {
            runId,
            ownerUserId: user.id,
            reentryNodeId: reentryNode,
            returnedCommitCount: commitCount,
            fastForwarded: ingest.fastForwarded,
            remote: ingest.remote,
          },
        });
        await emitWebhookEvent({
          db: tx,
          type: "run.rework_returned",
          projectId: run.projectId,
          runId,
          data: {
            ownerUserId: user.id,
            reentryNodeId: reentryNode,
            returnedCommitCount: commitCount,
            fastForwarded: ingest.fastForwarded,
            remote: ingest.remote,
          },
        });
      });
    } catch (err) {
      if (isMaisterError(err)) throw err;
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        `rework return ledger write failed for run ${runId}: ${(err as Error).message}`,
        { cause: err as Error },
      );
    }

    log.info(
      { runId, nodeId, reentryNode },
      "rework return phase 2b — recorded, staled, flipped Running, parked at re-entry",
    );

    // ---- Phase 3: resume ---------------------------------------------------
    // A process death here is recovered by the EXISTING
    // runTakeoverReturnRecoverySweep — its hasPendingTakeoverResume probe is
    // agnostic to the takeover row's own node, so it reaches this provenance
    // unchanged. No new sweep.
    queueMicrotask(
      () =>
        void runFlow(runId).catch((err: unknown) =>
          log.error(
            { runId, err: err instanceof Error ? err.message : String(err) },
            "background runFlow on rework return failed",
          ),
        ),
    );

    return NextResponse.json(
      {
        ok: true,
        runStatus: "Running",
        returnedCommitCount: commitCount,
        fastForwarded: ingest.fastForwarded,
      },
      { status: 200 },
    );
  } catch (err) {
    return errorResponse(err, { runId });
  }
}
