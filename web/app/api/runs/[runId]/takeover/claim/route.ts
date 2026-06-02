import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import {
  claimAssignment,
  completeAssignment,
  createAssignment,
  ensureUserActor,
  findActiveAssignmentForRun,
  takeOverAssignment,
} from "@/lib/assignments/service";
import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { claimTakeover } from "@/lib/flows/graph/ledger";
import { compileManifest } from "@/lib/flows/graph/compile";
import { loadRun } from "@/lib/flows/graph/runner-core";
import { markHumanWorking } from "@/lib/runs/state-transitions";

// FIXME(any): dual drizzle-orm peer-dep variants — Db handle.
type Db = any;

const log = pino({
  name: "api-takeover-claim",
  level: process.env.LOG_LEVEL ?? "info",
});

// claim: 200 / 401 / 403 / 404 / 409. No new MaisterError code (ADR-008):
// run-not-found → 404; wrong-state / non-human_review node → 409 PRECONDITION;
// concurrent claim (CAS lost) → 409 CONFLICT.
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
    default:
      return 500;
  }
}

function errorResponse(err: unknown, ctx: { runId: string }): NextResponse {
  if (isMaisterError(err)) {
    const status = httpStatusForCode(err.code);

    log.warn(
      { ...ctx, code: err.code, message: err.message, status },
      "takeover claim error",
    );

    return NextResponse.json(
      { code: err.code, message: err.message },
      { status },
    );
  }
  const message = err instanceof Error ? err.message : String(err);

  log.error({ ...ctx, err: message }, "takeover claim unhandled error");

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
    // Auth-first: authenticate + clear the forced-password-change gate before
    // any resource lookup so a must-change account cannot probe run existence.
    const user = await requireActiveSession();

    const db = getDb() as Db;

    // Run-not-found (loadRun throws PRECONDITION) → 404, distinct from a
    // wrong-state precondition (409).
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

    // RBAC: projectId is server-state (the run row), never body-supplied.
    await requireProjectAction(run.projectId, "answerHitl");

    if (run.status !== "NeedsInput") {
      throw new MaisterError(
        "PRECONDITION",
        `run ${runId} is not NeedsInput (got ${run.status}); cannot claim takeover`,
      );
    }

    const nodeId = run.currentStepId;

    if (!nodeId) {
      throw new MaisterError(
        "PRECONDITION",
        `run ${runId} has no current node to claim`,
      );
    }

    // Server-state: the current node must be a human_review node whose pinned
    // manifest decisions include `takeover`.
    const graph = compileManifest(loaded.manifest);
    const node = graph.nodes.get(nodeId);

    if (
      !node ||
      node.source.kind !== "node" ||
      node.source.node.type !== "human" ||
      !(node.finishHuman?.decisions ?? []).includes("takeover")
    ) {
      throw new MaisterError(
        "PRECONDITION",
        `node ${nodeId} of run ${runId} does not offer the takeover decision`,
      );
    }

    // Claim under one transaction. The status-guarded CAS (NeedsInput →
    // HumanWorking) runs FIRST: only the CAS winner then appends the takeover
    // node_attempts row. Ordering the CAS before claimTakeover is load-bearing —
    // node_attempts has UNIQUE(run_id, node_id, attempt) and claimTakeover
    // computes attempt=max+1, so two concurrent claims would compute the SAME
    // attempt and the loser's INSERT would raise a raw Postgres duplicate-key
    // (23505) — a non-MaisterError → 500. With the CAS first, the loser's CAS
    // returns {ok:false} → deterministic 409 CONFLICT and it never reaches the
    // unique-violating INSERT.
    const claimed: { ok: boolean; assignmentId: string | null } =
      await db.transaction(async (tx: Db) => {
        const cas = await markHumanWorking(runId, user.id, { db: tx });

        if (!cas.ok) {
          // Lost the CAS to a concurrent claim → abort with 409 CONFLICT.
          throw new MaisterError(
            "CONFLICT",
            `concurrent takeover claim won the CAS for run ${runId}`,
          );
        }

        const actor = await ensureUserActor({
          db: tx,
          projectId: run.projectId,
          userId: user.id,
          label: user.name ?? user.email ?? user.id,
        });
        const reviewAssignment = await findActiveAssignmentForRun({
          db: tx,
          runId,
          actionKinds: ["human_review"],
        });

        if (reviewAssignment) {
          if (reviewAssignment.status === "open") {
            await claimAssignment({
              db: tx,
              assignmentId: reviewAssignment.id,
              actorId: actor.id,
            });
          } else if (reviewAssignment.assigneeActorId !== actor.id) {
            await takeOverAssignment({
              db: tx,
              assignmentId: reviewAssignment.id,
              actorId: actor.id,
              reason: "manual takeover claim",
            });
          }

          await completeAssignment({
            db: tx,
            assignmentId: reviewAssignment.id,
            actorId: actor.id,
            eventKind: "completed",
            payload: { action: "manual_takeover_claim", nodeId },
          });
        }

        const takeover = await claimTakeover({
          runId,
          nodeId,
          userId: user.id,
          db: tx,
        });
        const manualAssignment = await createAssignment({
          db: tx,
          projectId: run.projectId,
          runId,
          taskId: run.taskId ?? null,
          nodeId,
          nodeAttemptId: takeover.id,
          actionKind: "manual_takeover",
          title: `Manual takeover for ${nodeId}`,
          createdByActorId: actor.id,
          branch: loaded.workspace.branch,
        });

        await claimAssignment({
          db: tx,
          assignmentId: manualAssignment.id,
          actorId: actor.id,
        });

        return { ok: true, assignmentId: manualAssignment.id };
      });

    log.info(
      {
        runId,
        nodeId,
        ownerUserId: user.id,
        assignmentId: claimed.assignmentId,
        claimed: claimed.ok,
      },
      "takeover claimed",
    );

    return NextResponse.json(
      {
        worktreePath: loaded.workspace.worktreePath,
        branch: loaded.workspace.branch,
        ownerUserId: user.id,
      },
      { status: 200 },
    );
  } catch (err) {
    return errorResponse(err, { runId });
  }
}
