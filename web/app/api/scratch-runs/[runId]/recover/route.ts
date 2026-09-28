import "server-only";

import type { Db as ExecutionDb } from "@/lib/execution-host/db";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { assertCurrentSessionBinding } from "@/lib/execution-host/session-binding";
import { PromptIncarnationPending } from "@/lib/execution-host/prompt-incarnation";
import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  classifyScratchRecovery,
  liveScratchHostSessionIds,
} from "@/lib/scratch-runs/recovery";
import {
  normalizeScratchPrompt,
  sendScratchPromptAndProjectEvents,
} from "@/lib/scratch-runs/events";
import { scratchStepId } from "@/lib/scratch-runs/launch";
import { appendScratchMessage } from "@/lib/scratch-runs/messages";
import {
  isYieldedScratchTurn,
  ScratchPromptContinuationPending,
} from "@/lib/scratch-runs/prompt-owner";
import {
  loadScratchRecoveryRows,
  respawnScratchSession,
} from "@/lib/scratch-runs/respawn";
import { workbenchClaimHoldsTree } from "@/lib/runs/lifecycle-claim";
import {
  assertLocalPackageAssistantActor,
  markScratchCrashed,
  markScratchPromptRetryable,
  noteScratchAdmissionYield,
  queueScratchRecoverMessageBehind,
  wakeQueuedScratchDispatch,
} from "@/lib/scratch-runs/service";
import { readScratchDialogStatus } from "@/lib/scratch-runs/turn-completion";
import {
  createExecutionHosts,
  localHost,
  mintPlacement,
} from "@/lib/execution-host";

const { runs, scratchRuns, workspaces } = schemaModule as unknown as Record<
  string,
  any
>;

const log = pino({
  name: "api-scratch-recover",
  level: process.env.LOG_LEVEL ?? "info",
});

const recoverBodySchema = z
  .object({
    prompt: z.string().min(1).max(60_000).optional(),
  })
  .strict();

type RecoverBody = z.infer<typeof recoverBodySchema>;
type RouteParams = { params: Promise<{ runId: string }> };
type Db = {
  select: any;
  update: any;
  transaction: any;
};

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
    case "EXECUTOR_UNAVAILABLE":
      return 503;
    default:
      return 500;
  }
}

// The reason tokens this route's body carries, each with the closed set of
// detail keys it may forward: `busy` (ADR-181 C26, a live workbench claim owns
// the worktree) and `scratch_not_recoverable` (the run is not `Crashed`). Every
// other typed error keeps the documented `{code, message}` body.
const FORWARDED_DETAILS: Readonly<Record<string, readonly string[]>> = {
  busy: [],
  scratch_not_recoverable: ["status", "next"],
};

function errorResponse(err: unknown, runId: string): NextResponse {
  if (isMaisterError(err)) {
    const details = err.details as Record<string, unknown> | undefined;
    const reason = details?.reason;
    const forwarded =
      typeof reason === "string" ? FORWARDED_DETAILS[reason] : undefined;

    return NextResponse.json(
      {
        code: err.code,
        message: err.message,
        ...(forwarded
          ? {
              details: {
                reason,
                ...Object.fromEntries(
                  forwarded
                    .filter((key) => typeof details?.[key] === "string")
                    .map((key) => [key, details?.[key]]),
                ),
              },
            }
          : {}),
      },
      { status: httpStatusForCode(err.code) },
    );
  }
  const message = err instanceof Error ? err.message : String(err);

  log.error({ runId, err: message }, "POST /api/scratch-runs/[runId]/recover");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

function notRecoverable(
  runId: string,
  status: string,
  next?: "respond",
): MaisterError {
  return new MaisterError(
    "CONFLICT",
    `scratch run ${runId} is not recoverable (status ${status})`,
    {
      details: {
        reason: "scratch_not_recoverable",
        status,
        ...(next ? { next } : {}),
      },
    },
  );
}

// ADR-166: the recover re-enters the run under a new driver generation
// (`scratch_recover`) minted inside the Running flip; the resumed session is
// created through the client bound to that assignment (an unavailable host
// refuses the recover before the claim).
export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    // Auth-first: before the body is parsed or any row is read, so an
    // unauthenticated caller learns neither the body schema nor the run.
    const user = await requireActiveSession();
    let body: RecoverBody;

    try {
      body = recoverBodySchema.parse(await req.json());
    } catch (err) {
      return errorResponse(
        new MaisterError(
          "CONFIG",
          `invalid POST body: ${(err as Error).message}`,
        ),
        runId,
      );
    }

    const db = getDb() as unknown as Db;
    // Authorized on the one lookup that names the run's owner, before the
    // full load can refuse with anything about the run's state.
    const [owner] = await db
      .select({
        runKind: runs.runKind,
        projectId: runs.projectId,
        createdByUserId: runs.createdByUserId,
        localPackageId: runs.localPackageId,
      })
      .from(runs)
      .where(eq(runs.id, runId));

    if (!owner || owner.runKind !== "scratch")
      throw new MaisterError("PRECONDITION", `run not found: ${runId}`);
    // ADR-097: project scratch runs keep the project-scoped operate gate; a
    // project-less assistant run is bound to its launching user AND a live
    // working-dir lock — driving a resume writes into the locked dir.
    if (owner.projectId) {
      await requireProjectAction(owner.projectId, "operateScratchRun");
    } else {
      await assertLocalPackageAssistantActor(owner, user.id, {
        requireLock: true,
      });
    }
    const rows = await loadScratchRecoveryRows(db, runId);
    const { run, scratch, workspaceRemoved, acpSessionId, hostSessionId } =
      rows;

    const hosts = createExecutionHosts({ db: db as unknown as ExecutionDb });
    const placementHost = await localHost({
      db: db as unknown as ExecutionDb,
      transport: hosts.transport,
    });

    // The logical run session is the association authority. A targeted host
    // listing only diagnoses whether that already-associated host session is
    // still live; it must never discover a session for this run by scanning.
    let liveSessionIds = new Set<string>();

    if (hostSessionId) {
      try {
        const activeExecution = await hosts.executionFor(runId);

        liveSessionIds = liveScratchHostSessionIds(
          await activeExecution.admin.listSessions(),
        );
      } catch (err) {
        // The preceding crash/release can legitimately leave no active
        // assignment. Canonical state already selected the host session; a
        // diagnostic probe must not block same-host checkpoint recovery.
        log.info(
          {
            runId,
            hostSessionId,
            reason: isMaisterError(err) ? err.code : "diagnostic_unavailable",
          },
          "scratch-recover-host-diagnostic-unavailable",
        );
      }
    }
    const decision = classifyScratchRecovery({
      runStatus: run.status,
      dialogStatus: scratch.dialogStatus,
      acpSessionId,
      hostSessionId,
      workspaceRemoved,
      liveHostSessionIds: liveSessionIds,
    });
    const { action } = decision;

    if (action === "open") {
      return NextResponse.json({
        runId,
        action,
        dialogStatus: scratch.dialogStatus,
      });
    }
    if (decision.action === "refuse") {
      log.info(
        { runId, status: decision.status, next: decision.next ?? null },
        "scratch-recover-refused",
      );
      throw notRecoverable(runId, decision.status, decision.next);
    }
    if (action !== "recover") {
      throw new MaisterError(
        "PRECONDITION",
        `scratch run cannot be recovered; action=${action}`,
      );
    }
    if (!body.prompt) {
      throw new MaisterError(
        "CONFIG",
        "prompt is required to recover a scratch session",
      );
    }
    if (!acpSessionId) {
      throw new MaisterError(
        "PRECONDITION",
        `scratch run has no ACP resume session: ${runId}`,
      );
    }

    // Claim first: CAS `Crashed → Running` and mint the `scratch_recover`
    // generation in the same tx (a concurrent recover loses the CAS → 409).
    // The CAS is the literal `Crashed`, never the status this request read: a
    // budget-`Failed` or a parked `NeedsInputIdle` run is not recoverable. The
    // create then rides the client bound to that generation; a create failure
    // rolls the claim back. The ADR-097 working-dir confinement rides the
    // adopted handle (directory adoption of the package dir), no longer a wire
    // field.
    const observed = {
      status: "Crashed",
      currentStepId: (run.currentStepId ?? null) as string | null,
    };
    const claimed = await db.transaction(async (tx: Db) => {
      const claimedRows = await tx
        .update(runs)
        .set({
          status: "Running",
          currentStepId: scratchStepId(),
          resumeStartedAt: new Date(),
        })
        .where(and(eq(runs.id, runId), eq(runs.status, observed.status)))
        .returning({ id: runs.id });

      if (claimedRows.length === 0) return null;

      // The dialog is part of the CAS: read under the run lock (the run row is
      // locked first on every scratch path), refuse without a trace.
      const [dialog] = await tx
        .select({ dialogStatus: scratchRuns.dialogStatus })
        .from(scratchRuns)
        .where(eq(scratchRuns.runId, runId))
        .for("update");

      if (dialog?.dialogStatus !== "Crashed")
        throw notRecoverable(runId, observed.status);

      // ADR-181 C26, the recover direction: one writer per worktree. The CAS
      // above holds the run row, so a workbench claim committed before it is
      // visible here, and one still in flight waits for this transaction and
      // then sees `Running`. Throwing rolls the flip back.
      const [workspace] = await tx
        .select({
          lifecycleOperationState: workspaces.lifecycleOperationState,
          lifecycleOperationLeaseExpiresAt:
            workspaces.lifecycleOperationLeaseExpiresAt,
          promotionState: workspaces.promotionState,
          promotionClaimedAt: workspaces.promotionClaimedAt,
        })
        .from(workspaces)
        .where(eq(workspaces.runId, runId));

      if (workspace && workbenchClaimHoldsTree(workspace)) {
        throw new MaisterError(
          "CONFLICT",
          `a workbench operation owns scratch run ${runId}'s worktree — retry once it finishes`,
          { details: { reason: "busy" } },
        );
      }

      return mintPlacement(tx as unknown as ExecutionDb, {
        runId,
        reason: "scratch_recover",
        host: placementHost,
      });
    });

    if (!claimed) {
      throw new MaisterError(
        "CONFLICT",
        `scratch run ${runId} left ${observed.status} concurrently — recover refused`,
      );
    }

    const { execution, session } = await respawnScratchSession({
      db,
      hosts,
      runId,
      assignmentId: claimed.id,
      acpSessionId,
      rows,
      observed,
      releaseReason: "scratch_recover_rollback",
    });
    const now = new Date();
    const prompt = body.prompt;
    const persisted = await db.transaction(async (tx: Db) => {
      await assertCurrentSessionBinding(tx, {
        runId,
        sessionName: "default",
        assignmentId: claimed.id,
        hostSessionId: session.sessionId,
        acpSessionId: session.acpSessionId,
      });
      const queued = await queueScratchRecoverMessageBehind(tx, runId, prompt);
      // The operator's text is a transcript row before it is a prompt, so the
      // transcript shows it and a yield can return it to the queue (A4).
      const message = queued
        ? null
        : await appendScratchMessage(tx as unknown as ExecutionDb, {
            runId,
            role: "user",
            content: prompt,
            delivery: "prompted",
          });

      await tx
        .update(scratchRuns)
        .set({
          dialogStatus: queued ? "WaitingForUser" : "Running",
          errorCode: null,
          errorMessage: null,
          errorMetadata: null,
          ...(queued ? {} : { lastUserMessageAt: now }),
          updatedAt: now,
        })
        .where(eq(scratchRuns.runId, runId));

      return { queued, messageId: message?.id ?? null };
    });

    if (persisted.queued) {
      wakeQueuedScratchDispatch(db as never, runId, hosts);

      return NextResponse.json(
        {
          runId,
          action,
          dialogStatus: "WaitingForUser",
          delivery: "queued",
        },
        { status: 202 },
      );
    }

    try {
      const promptResult = await sendScratchPromptAndProjectEvents({
        runId,
        sessionId: session.sessionId,
        stepId: scratchStepId(),
        prompt: normalizeScratchPrompt(prompt, rows.executor.agent, { runId }),
        execution,
        owner: { variant: "recovery" },
      });

      const dialogStatus = await readScratchDialogStatus(db as never, runId);

      return NextResponse.json(
        {
          runId,
          action,
          dialogStatus,
          stopReason: promptResult.stopReason,
        },
        { status: 202 },
      );
    } catch (err) {
      // A fenced, superseded or owner-retained turn belongs to another owner —
      // its run state is not ours to crash (E-EH-11).
      if (isYieldedScratchTurn(err)) {
        log.warn(
          {
            runId,
            assignmentId: claimed.id,
            reason: isMaisterError(err) ? err.details?.reason : undefined,
          },
          "driver-yielded",
        );
        // The recovery prompt was issued and its owner applies the outcome:
        // the recovery is under way, not refused. A fenced or superseded
        // turn is another generation's, and stays a refusal.
        if (err instanceof ScratchPromptContinuationPending)
          return NextResponse.json(
            {
              runId,
              action,
              dialogStatus: await readScratchDialogStatus(db as never, runId),
            },
            { status: 202 },
          );
        throw err;
      }
      // The recovered session is live and nothing was admitted: keep the run
      // rather than crashing a recovery that worked. The Recover text goes
      // back to the queue, so the answer is the accepted state, not an error
      // that would invite a second copy of it.
      if (err instanceof PromptIncarnationPending) {
        noteScratchAdmissionYield(runId, err);
        const { requeued } = await markScratchPromptRetryable({
          db,
          runId,
          err,
          messageId: persisted.messageId,
        }).catch((markErr) => {
          log.error(
            {
              runId,
              markErr:
                markErr instanceof Error ? markErr.message : String(markErr),
            },
            "failed to mark scratch recovery prompt retryable",
          );

          return { requeued: false };
        });

        if (requeued)
          return NextResponse.json(
            {
              runId,
              action,
              dialogStatus: "WaitingForUser",
              delivery: "queued",
            },
            { status: 202 },
          );
        throw err;
      }
      await markScratchCrashed({
        db,
        runId,
        err,
      }).catch((markErr) =>
        log.error(
          {
            runId,
            markErr:
              markErr instanceof Error ? markErr.message : String(markErr),
          },
          "failed to mark scratch recovery prompt failure",
        ),
      );
      throw err;
    }
  } catch (err) {
    return errorResponse(err, runId);
  }
}
