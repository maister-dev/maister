import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import {
  claimAssignment,
  createAssignment,
  ensureUserActor,
} from "@/lib/assignments/service";
import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { compileManifest } from "@/lib/flows/graph/compile";
import {
  claimTakeover,
  getNodeAttemptsForRun,
  REVIEW_REWORK_CLAIM_DECISION,
} from "@/lib/flows/graph/ledger";
import { loadRun, loadRunProjectId } from "@/lib/flows/graph/runner-core";
import { isLaunchedLineageRun } from "@/lib/evaluations/membership";
import { resolveReentryNode } from "@/lib/runs/reentry";
import { assertReworkClaimEligible } from "@/lib/runs/rework-claim";
import { markReworkClaimFromReview } from "@/lib/runs/state-transitions";
import { countLiveRuns, maxConcurrentRunsCap } from "@/lib/scheduler";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";

// FIXME(any): dual drizzle-orm peer-dep variants — Db handle.
type Db = any;

const log = pino({
  name: "api-rework-claim-claim",
  level: process.env.LOG_LEVEL ?? "info",
});

// claim: 200 / 401 / 403 / 404 / 409. No new MaisterError code (ADR-008):
// run-not-found → 404; each eligibility term and an unresolved re-entry → 409
// PRECONDITION; a lost CAS or a full cap → 409 CONFLICT.
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
    default:
      return 500;
  }
}

function errorResponse(err: unknown, ctx: { runId: string }): NextResponse {
  if (isMaisterError(err)) {
    const status = httpStatusForCode(err.code);

    log.warn(
      { ...ctx, code: err.code, message: err.message, status },
      "rework claim refused",
    );

    return NextResponse.json(
      { code: err.code, message: err.message },
      { status },
    );
  }
  const message = err instanceof Error ? err.message : String(err);

  log.error({ ...ctx, err: message }, "rework claim unhandled error");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

type RouteParams = { params: Promise<{ runId: string }> };

export async function POST(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    // Auth-first: authenticate and clear the forced-password-change gate before
    // any resource lookup, so a must-change account cannot probe run existence.
    const user = await requireActiveSession();

    const db = getDb() as Db;

    const projectId = await loadRunProjectId(db, runId);

    if (!projectId) {
      return NextResponse.json(
        { code: "PRECONDITION", message: `run not found: ${runId}` },
        { status: 404 },
      );
    }

    // Authorize BEFORE `loadRun` parses the pinned manifest, so a malformed
    // stored revision stays invisible to non-members.
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
    const isLaunchedLineage = await isLaunchedLineageRun(db, runId);

    log.debug(
      {
        runId,
        status: run.status,
        runKind: run.runKind,
        parentRunId: run.parentRunId ?? null,
        workspaceMode: run.workspaceMode ?? null,
        isLaunchedLineage,
        workspaceRemovedAt: loaded.workspace.removedAt,
      },
      "[rework-claim] eligibility inputs",
    );

    assertReworkClaimEligible(
      {
        status: run.status,
        runKind: run.runKind,
        parentRunId: run.parentRunId ?? null,
        workspaceMode: run.workspaceMode ?? null,
        isLaunchedLineage,
      },
      // loadRun guarantees a workspace row (it throws PRECONDITION otherwise,
      // mapped to 404 above). The predicate still carries the null arm for the
      // read-model caller in Task 13, which derives availability without it.
      { removedAt: loaded.workspace.removedAt },
    );

    // Re-entry is resolved from server state ONLY — never from the body.
    const graph = compileManifest(loaded.manifest);
    const ledger = await getNodeAttemptsForRun(runId, db);
    const reentry = resolveReentryNode(graph, ledger);

    if (!reentry.ok) {
      throw new MaisterError(
        "PRECONDITION",
        `run ${runId} has no re-entry node: this flow declares no \`reentry\` and no executed human node offers a takeover transition — launch a new run from this branch instead`,
      );
    }

    // The claim row anchors on the LAST EXECUTED node. `runs.current_step_id` is
    // NULL in Review, so the anchor is ledger-derived like the re-entry node.
    const anchor = ledger.length > 0 ? ledger[ledger.length - 1] : null;

    if (!anchor) {
      throw new MaisterError(
        "PRECONDITION",
        `run ${runId} has no executed node to anchor a rework claim on`,
      );
    }

    const anchorNode = graph.nodes.get(anchor.nodeId);

    const claimed: { assignmentId: string; nodeAttemptId: string } =
      await db.transaction(async (tx: Db) => {
        // Cap gate INSIDE the transaction. Review is slot-free while
        // HumanWorking is not, so this claim ACQUIRES a slot and can be refused
        // when the host is saturated. A pre-check outside the lock would be a
        // TOCTOU; queueing is meaningless because the scheduler cannot start a
        // human, so a full cap is a CONFLICT, never `Pending`.
        const cap = maxConcurrentRunsCap();
        const liveCount = await countLiveRuns(tx, "flow");

        log.debug({ runId, liveCount, cap }, "[rework-claim] cap recheck");

        if (liveCount >= cap) {
          throw new MaisterError(
            "CONFLICT",
            `concurrency cap full (${liveCount}/${cap}) — free a slot or stop another run`,
          );
        }

        // CAS FIRST. node_attempts has UNIQUE(run_id, node_id, attempt) and
        // claimTakeover computes attempt=max+1, so two concurrent claims would
        // compute the SAME attempt and the loser's INSERT would raise a raw
        // 23505 → 500. With the CAS first the loser is refused here with a
        // deterministic 409 and never reaches the insert.
        const cas = await markReworkClaimFromReview(runId, user.id, { db: tx });

        if (!cas.ok) {
          throw new MaisterError(
            "CONFLICT",
            `concurrent rework claim won the CAS for run ${runId}`,
          );
        }

        const takeover = await claimTakeover({
          runId,
          nodeId: anchor.nodeId,
          userId: user.id,
          nodeType: anchorNode?.nodeType ?? anchor.nodeType,
          decision: REVIEW_REWORK_CLAIM_DECISION,
          db: tx,
        });

        const actor = await ensureUserActor({
          db: tx,
          projectId: run.projectId,
          userId: user.id,
          label: user.name ?? user.email ?? user.id,
        });
        const assignment = await createAssignment({
          db: tx,
          projectId: run.projectId,
          runId,
          taskId: run.taskId ?? null,
          nodeId: anchor.nodeId,
          nodeAttemptId: takeover.id,
          actionKind: "manual_takeover",
          title: `Rework claim from Review (re-entry at ${reentry.nodeId})`,
          createdByActorId: actor.id,
          branch: loaded.workspace.branch,
        });

        await claimAssignment({
          db: tx,
          assignmentId: assignment.id,
          actorId: actor.id,
        });

        // ADR-086 exactly-once: the outbox rows are durable writes and belong
        // in the SAME transaction as the domain write, never in a
        // "notify after commit" bucket. Actor is the claiming USER — this is an
        // operator action, not a system one.
        await emitDomainEvent({
          db: tx,
          kind: "run.rework_claimed",
          projectId: run.projectId,
          runId,
          taskId: run.taskId,
          actor: { type: "user", id: user.id },
          payload: {
            runId,
            ownerUserId: user.id,
            anchorNodeId: anchor.nodeId,
            reentryNodeId: reentry.nodeId,
            reentrySource: reentry.source,
          },
        });
        await emitWebhookEvent({
          db: tx,
          type: "run.rework_claimed",
          projectId: run.projectId,
          runId,
          data: {
            ownerUserId: user.id,
            anchorNodeId: anchor.nodeId,
            reentryNodeId: reentry.nodeId,
            reentrySource: reentry.source,
          },
        });

        return { assignmentId: assignment.id, nodeAttemptId: takeover.id };
      });

    log.info(
      {
        runId,
        ownerUserId: user.id,
        anchorNodeId: anchor.nodeId,
        reentryNodeId: reentry.nodeId,
        reentrySource: reentry.source,
        assignmentId: claimed.assignmentId,
      },
      "rework claim taken",
    );

    return NextResponse.json(
      {
        worktreePath: loaded.workspace.worktreePath,
        branch: loaded.workspace.branch,
        ownerUserId: user.id,
        reentryNodeId: reentry.nodeId,
        reentrySource: reentry.source,
      },
      { status: 200 },
    );
  } catch (err) {
    return errorResponse(err, { runId });
  }
}
