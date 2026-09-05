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
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  endActiveTakeover,
  getActiveTakeover,
  REVIEW_REWORK_CLAIM_DECISION,
} from "@/lib/flows/graph/ledger";
import { loadRunProjectId } from "@/lib/flows/graph/runner-core";
import { markReviewFromReworkClaim } from "@/lib/runs/state-transitions";
import { promoteNextPending } from "@/lib/scheduler";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants — Db handle.
type Db = any;

const log = pino({
  name: "api-rework-claim-release",
  level: process.env.LOG_LEVEL ?? "info",
});

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
      "rework release refused",
    );

    return NextResponse.json(
      { code: err.code, message: err.message },
      { status },
    );
  }
  const message = err instanceof Error ? err.message : String(err);

  log.error({ ...ctx, err: message }, "rework release unhandled error");

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
    // Auth-first. Body is EMPTY — the owner and the target status are
    // server-state.
    const user = await requireActiveSession();

    const db = getDb() as Db;
    const projectId = await loadRunProjectId(db, runId);

    if (!projectId) {
      return NextResponse.json(
        { code: "PRECONDITION", message: `run not found: ${runId}` },
        { status: 404 },
      );
    }

    await requireProjectAction(projectId, "answerHitl");

    await db.transaction(async (tx: Db) => {
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
          `run ${runId} is not HumanWorking (got ${fresh.status}); nothing to release`,
        );
      }

      const active = await getActiveTakeover(runId, tx);

      if (!active) {
        throw new MaisterError(
          "PRECONDITION",
          `run ${runId} has no open rework claim to release`,
        );
      }
      if (active.ownerUserId !== user.id) {
        throw new MaisterError(
          "UNAUTHORIZED",
          `run ${runId} rework claim is owned by another user; release is owner-only`,
        );
      }
      if (active.decision !== REVIEW_REWORK_CLAIM_DECISION) {
        throw new MaisterError(
          "PRECONDITION",
          `run ${runId} holds a manual takeover, not a rework claim — release it through /takeover/release`,
        );
      }

      // Back to Review, NOT NeedsInput: this provenance has no review HITL to
      // re-open — the run had already finished its graph when it was claimed.
      const released = await markReviewFromReworkClaim(runId, { db: tx });

      if (!released.ok) {
        throw new MaisterError(
          "CONFLICT",
          `run ${runId} was already returned or released by a concurrent request`,
        );
      }

      await endActiveTakeover(runId, tx);

      const actor = await ensureUserActor({
        db: tx,
        projectId: fresh.projectId,
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
          eventKind: "completed",
          payload: { action: "rework_claim_release", nodeId: active.nodeId },
        });
      }
    });

    // The claim held a real slot (Review is slot-free, HumanWorking is not), so
    // releasing frees one — hand it to the queue.
    await promoteNextPending();

    log.info(
      { runId, ownerUserId: user.id },
      "rework claim released to Review",
    );

    return NextResponse.json(
      { ok: true, runStatus: "Review" },
      { status: 200 },
    );
  } catch (err) {
    return errorResponse(err, { runId });
  }
}
