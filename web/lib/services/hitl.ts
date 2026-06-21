import "server-only";

import type {
  BudgetAxis,
  BudgetScope,
  BudgetState,
} from "@/lib/runs/execution-policy";

import path from "node:path";

import { and, eq, inArray, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import pino from "pino";

import { requireProjectAction } from "@/lib/authz";
import {
  claimAssignment,
  completeAssignment,
  ensureApiTokenActor,
  ensureUserActor,
  systemCloseActiveAssignmentsForRun,
} from "@/lib/assignments/service";
import { atomicWriteJson } from "@/lib/atomic";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  assertHitlResponse,
  assertReviewDecision,
  isReviewSchema,
  resolveConfidence,
} from "@/lib/flows/hitl-validate";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { runFlow } from "@/lib/flows/runner";
import { logExecPolicyAction } from "@/lib/runs/exec-policy-audit";
import { cancelPermission, deliverPermission } from "@/lib/supervisor-client";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { assignments, hitlRequests, projects, runs, scratchRuns } =
  schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "hitl-service",
  level: process.env.LOG_LEVEL ?? "info",
});

const TERMINAL_RUN_STATUS = new Set([
  "Failed",
  "Crashed",
  "Done",
  "Abandoned",
  "Review",
]);

// A form/human/permission HITL is genuinely pending ONLY while the run awaits
// the response — NeedsInput or its idle checkpoint NeedsInputIdle. Any other
// status (notably HumanWorking, where a manual takeover is active) means the
// original HITL is no longer the live question: accepting it would store a
// pre-takeover decision whose step-keyed input-<stepId>.json artifact the
// post-return rerun could replay over the human's edits (form/human), or
// deliver a stale permission against a superseded session (permission),
// bypassing fresh review. The runner still owns NeedsInput → Running (M11b
// contract) — this guard never flips status. Used as the FRESH-write allow-list
// on every kind so a future non-terminal status can never slip a `!terminal`
// deny-list.
export const PENDING_HITL_RUN_STATUS = new Set([
  "NeedsInput",
  "NeedsInputIdle",
]);

function runtimeRoot(): string {
  return process.env.MAISTER_RUNTIME_ROOT ?? process.cwd();
}

function isPostgres(): boolean {
  const url = process.env.DB_URL ?? "";

  return url.startsWith("postgres://") || url.startsWith("postgresql://");
}

// Acquire a row-level lock on the HITL request row inside a transaction.
// Postgres: SELECT ... FOR UPDATE. SQLite: deferred-write semantics rely on
// the single-writer lock so the no-op `.where()` is correct.

async function lockHitlRow(tx: any, hitlRequestId: string): Promise<any> {
  if (isPostgres()) {
    const rows = await tx
      .select()
      .from(hitlRequests)
      .where(eq(hitlRequests.id, hitlRequestId))
      .for("update");

    return rows[0];
  }
  const rows = await tx
    .select()
    .from(hitlRequests)
    .where(eq(hitlRequests.id, hitlRequestId));

  return rows[0];
}

// Schedule a runner wake-up for a delivered HITL row. Called from both
// the first-success path and the same-payload retry path so a process
// restart between Phase 3 commit and the original microtask cannot
// strand the run in NeedsInput.
function scheduleResume(runId: string): void {
  queueMicrotask(
    () =>
      void runFlow(runId).catch((err: unknown) =>
        log.error(
          { runId, err: err instanceof Error ? err.message : String(err) },
          "background runFlow on resume failed",
        ),
      ),
  );
}

// Stable comparison so retries with the same payload are idempotent.
// Different key order with the same fields hashes differently — clients
// retrying should send the same byte stream.
function payloadsEqual(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export type HitlActor =
  | { kind: "user"; userId: string; label: string }
  | {
      kind: "api_token";
      tokenId: string;
      projectId: string;
      label: string;
      ownerUserId?: string | null;
    };

export type RespondInput = {
  runId: string;
  hitlRequestId: string;
  body: {
    optionId?: string;
    response?: unknown;
    // M17 ADR-054: responder self-reported confidence in [0,1].
    confidence?: unknown;
    // Cost-budget governance: the raised token ceiling for a budget_breach
    // raise (validated fail-closed at the sink). May also ride `response`.
    raiseTo?: unknown;
  };
};

type HandlerArgs = {
  db: any;
  hitlRow: any;
  runRow: any;
  body: RespondInput["body"];
  runId: string;
  hitlRequestId: string;
  startedAt: number;
  actor: HitlActor;
  recordSuccessAudit?: (db: any, statusCode: number) => Promise<void>;
};

type ResponseAssignmentClaim = {
  assignmentId: string;
  actorId: string;
} | null;

async function claimAssignmentForResponse(args: {
  db: any;
  hitlRequestId: string;
  projectId: string;
  actor: HitlActor;
}): Promise<ResponseAssignmentClaim> {
  const [assignment] = await args.db
    .select()
    .from(assignments)
    .where(eq(assignments.hitlRequestId, args.hitlRequestId));

  if (!assignment) return null;

  const actor =
    args.actor.kind === "user"
      ? await ensureUserActor({
          db: args.db,
          projectId: args.projectId,
          userId: args.actor.userId,
          label: args.actor.label,
        })
      : await ensureApiTokenActor({
          db: args.db,
          projectId: args.projectId,
          tokenId: args.actor.tokenId,
          ownerUserId: args.actor.ownerUserId ?? null,
          label: args.actor.label,
        });

  if (
    assignment.status === "claimed" &&
    assignment.assigneeActorId !== actor.id
  ) {
    throw new MaisterError(
      "CONFLICT",
      `assignment is claimed by another actor: assignmentId=${assignment.id}`,
    );
  }

  if (assignment.status === "open") {
    await claimAssignment({
      db: args.db,
      assignmentId: assignment.id,
      actorId: actor.id,
    });
  } else if (
    assignment.status !== "claimed" &&
    assignment.status !== "completed"
  ) {
    throw new MaisterError(
      "PRECONDITION",
      `assignment is not respondable: assignmentId=${assignment.id} status=${assignment.status}`,
    );
  }

  return { assignmentId: assignment.id, actorId: actor.id };
}

async function completeResponseAssignment(
  db: any,
  claim: ResponseAssignmentClaim,
  payload: Record<string, unknown> = {},
): Promise<void> {
  if (claim === null) return;

  await completeAssignment({
    db,
    assignmentId: claim.assignmentId,
    actorId: claim.actorId,
    eventKind: "responded",
    payload,
  });
}

async function recordSuccessAuditInTransaction(
  args: HandlerArgs,
  statusCode: number,
): Promise<void> {
  if (!args.recordSuccessAudit) return;

  await args.db.transaction(async (tx: any) => {
    await args.recordSuccessAudit?.(tx, statusCode);
  });
}

async function markScratchPermissionDelivered(
  db: any,
  runRow: any,
  runId: string,
): Promise<void> {
  if (runRow.runKind !== "scratch") return;

  const now = new Date();

  await db
    .update(scratchRuns)
    .set({ dialogStatus: "Running", updatedAt: now })
    .where(eq(scratchRuns.runId, runId));
  await db.update(runs).set({ status: "Running" }).where(eq(runs.id, runId));
}

async function markScratchPermissionTimedOut(
  db: any,
  runRow: any,
  runId: string,
): Promise<void> {
  if (runRow.runKind !== "scratch") return;

  const now = new Date();

  await db
    .update(scratchRuns)
    .set({
      dialogStatus: "Crashed",
      errorCode: "HITL_TIMEOUT",
      errorMessage: "permission window expired before response was delivered",
      updatedAt: now,
    })
    .where(eq(scratchRuns.runId, runId));
}

type PermissionClaim =
  | { kind: "claimed"; runStatus: string }
  | { kind: "already-delivered"; runStatus: string }
  | { kind: "noop-idempotent"; runStatus: string };

async function handlePermissionResponse(
  args: HandlerArgs,
): Promise<NextResponse> {
  const { db, hitlRow, runRow, body, runId, hitlRequestId, startedAt } = args;
  const optionId = body.optionId;

  if (typeof optionId !== "string" || optionId.length === 0) {
    throw new MaisterError(
      "CONFIG",
      "optionId is required for kind=permission",
    );
  }

  const schema = hitlRow.schema as {
    requestId: string;
    supervisorSessionId: string;
    options?: Array<{ optionId: string }>;
  };

  if (
    typeof schema?.requestId !== "string" ||
    schema.requestId.length === 0 ||
    typeof schema?.supervisorSessionId !== "string" ||
    schema.supervisorSessionId.length === 0
  ) {
    throw new MaisterError(
      "PRECONDITION",
      "permission HITL row is missing supervisor handles (requestId/supervisorSessionId)",
    );
  }

  if (Array.isArray(schema.options)) {
    const valid = schema.options.some((o) => o.optionId === optionId);

    if (!valid) {
      throw new MaisterError(
        "CONFIG",
        `optionId ${optionId} not in declared options`,
      );
    }
  }

  const assignmentClaim = await claimAssignmentForResponse({
    db,
    hitlRequestId,
    projectId: runRow.projectId,
    actor: args.actor,
  });

  // Phase 1: claim the row with a row-level lock. Two semantics co-exist:
  //   1. unclaimed → CAS the response with our optionId
  //   2. claimed with same optionId → idempotent retry; no UPDATE needed
  //   3. claimed with a different optionId → 409 conflicting choice
  //   4. respondedAt already set → 409 already delivered
  // Returns a tag describing which branch fired so the caller can
  // distinguish "we own the deferred and must deliver" from
  // "another request already finished — return 200 idempotently".

  const claim: PermissionClaim = await db.transaction(async (tx: any) => {
    const lockedHitl = await lockHitlRow(tx, hitlRequestId);
    const lockedRunRows = await tx
      .select()
      .from(runs)
      .where(eq(runs.id, runId));
    const lockedRun = lockedRunRows[0];

    if (!lockedHitl || !lockedRun) {
      throw new MaisterError("PRECONDITION", "row vanished mid-transaction");
    }
    if (TERMINAL_RUN_STATUS.has(lockedRun.status)) {
      throw new MaisterError(
        "CONFLICT",
        `run is terminal (${lockedRun.status}); cannot respond`,
      );
    }
    if (lockedHitl.respondedAt) {
      const stored = (lockedHitl.response ?? {}) as { optionId?: string };

      if (stored.optionId === optionId) {
        return {
          kind: "already-delivered",
          runStatus: lockedRun.status as string,
        } as const;
      }
      throw new MaisterError("CONFLICT", "hitl request already delivered");
    }
    const stored = lockedHitl.response as { optionId?: string } | null;

    if (stored && stored.optionId && stored.optionId !== optionId) {
      throw new MaisterError(
        "CONFLICT",
        `permission already claimed with optionId="${stored.optionId}"; refusing to overwrite with "${optionId}"`,
      );
    }
    if (stored && stored.optionId === optionId) {
      return {
        kind: "noop-idempotent",
        runStatus: lockedRun.status as string,
      } as const;
    }

    // Fresh claim: accept ONLY when the run is genuinely awaiting it
    // (NeedsInput / NeedsInputIdle). A `!terminal` deny-list alone would admit
    // any future non-terminal status (e.g. HumanWorking) into delivery; this
    // explicit allow-list mirrors the form path and closes that hole.
    if (!PENDING_HITL_RUN_STATUS.has(lockedRun.status)) {
      throw new MaisterError(
        "CONFLICT",
        `run is not awaiting this response (status=${lockedRun.status}); cannot respond`,
      );
    }

    await tx
      .update(hitlRequests)
      .set({ response: { optionId } })
      .where(
        and(
          eq(hitlRequests.id, hitlRequestId),
          isNull(hitlRequests.respondedAt),
          isNull(hitlRequests.response),
        ),
      );

    return {
      kind: "claimed",
      runStatus: lockedRun.status as string,
    } as const;
  });

  if (claim.kind === "already-delivered") {
    // Self-heal a crash between the respondedAt marker and the scratch
    // status flip below: a process death after `respondedAt` committed but
    // before `markScratchPermissionDelivered` would otherwise strand a scratch
    // run (HITL delivered, dialogStatus never advanced). Idempotent — no-op for
    // flow runs and for an already-Running scratch run.
    await db.transaction(async (tx: any) => {
      await markScratchPermissionDelivered(tx, runRow, runId);
      await completeResponseAssignment(tx, assignmentClaim, { optionId });
      await args.recordSuccessAudit?.(tx, 200);
    });

    log.info(
      {
        runId,
        hitlRequestId,
        kind: "permission",
        phase: "already-delivered",
        latencyMs: Date.now() - startedAt,
      },
      "permission already delivered (idempotent retry)",
    );

    return NextResponse.json(
      { ok: true, runStatus: "NeedsInput" },
      { status: 200 },
    );
  }

  // M8 T10 / D8: NeedsInputIdle branch. The intent is now in
  // hitl_requests.response (Phase 1). There is no live supervisor
  // session to deliverPermission to — we trigger a respawn via
  // resumeRun and return 202. The runner-agent's permission_request
  // handler (T11) will auto-deliver the stored intent against the new
  // requestId once the resumed session re-issues the permission.
  if (claim.runStatus === "NeedsInputIdle") {
    if (runRow.runKind === "agent") {
      const claimed = await db.transaction(async (tx: any) => {
        const rows = await tx
          .update(runs)
          .set({
            status: "Running",
            keepaliveUntil: null,
            checkpointAt: null,
          })
          .where(and(eq(runs.id, runId), eq(runs.status, "NeedsInputIdle")))
          .returning({ id: runs.id });

        if (rows.length === 0) return false;
        await args.recordSuccessAudit?.(tx, 202);

        return true;
      });

      if (!claimed) {
        log.info(
          {
            runId,
            hitlRequestId,
            branch: "agent-idle",
            phase: "claim-race",
            latencyMs: Date.now() - startedAt,
          },
          "concurrent agent resume in progress — returning 202",
        );

        await recordSuccessAuditInTransaction(args, 202);

        return NextResponse.json(
          {
            ok: true,
            runStatus: "Running",
            state: "resume-in-progress",
          },
          { status: 202 },
        );
      }

      const { startAgentSession } = await import("@/lib/agents/launch");

      queueMicrotask(() => {
        void startAgentSession(runId, { db }).catch((err: unknown) => {
          log.error(
            {
              runId,
              hitlRequestId,
              err: err instanceof Error ? err.message : String(err),
            },
            "agent idle permission resume failed",
          );
        });
      });

      log.info(
        {
          runId,
          hitlRequestId,
          branch: "agent-idle",
          phase: "resume-scheduled",
          latencyMs: Date.now() - startedAt,
        },
        "permission stored; agent resume scheduled — auto-deliver async",
      );

      return NextResponse.json(
        {
          ok: true,
          runStatus: "Running",
          state: "resume-in-progress",
        },
        { status: 202 },
      );
    }

    const { resumeRun } = await import("@/lib/runs/resume");
    const { scheduleResumedSessionDrive } = await import(
      "@/lib/runs/resume-driver"
    );
    const r = await resumeRun(runId, {
      db,
      ...(args.recordSuccessAudit
        ? {
            recordSuccessAudit: async (tx: any) => {
              await args.recordSuccessAudit?.(tx, 202);
            },
          }
        : {}),
    });

    if (r.ok) {
      // M8 review finding #2: schedule the actual driver. Until
      // this lands, returning 202 here was a lie — the supervisor
      // session existed but no one read its stream, sent it a prompt,
      // or auto-delivered the stored intent.
      const driveId = scheduleResumedSessionDrive({
        runId,
        supervisorSessionId: r.newSupervisorSessionId,
        acpSessionId: r.acpSessionId,
        stepId: hitlRow.stepId,
      });

      log.info(
        {
          runId,
          hitlRequestId,
          branch: "idle",
          phase: "resume-spawned",
          newSupervisorSessionId: r.newSupervisorSessionId,
          driveId,
          latencyMs: Date.now() - startedAt,
        },
        "permission stored; resume spawned + driver scheduled — auto-deliver async",
      );

      return NextResponse.json(
        {
          ok: true,
          runStatus: "NeedsInput",
          state: "resume-in-progress",
        },
        { status: 202 },
      );
    }

    // M8 review finding #3: claim race lost is NOT a terminal
    // failure — another /respond invocation owns the resume. Return
    // 202 so the operator UI keeps showing "resume in progress" and
    // the next idempotent retry (after auto-deliver completes) hits
    // the already-delivered path and gets 200.
    if (r.code === "CLAIM_RACE") {
      log.info(
        {
          runId,
          hitlRequestId,
          branch: "idle",
          phase: "claim-race",
          latencyMs: Date.now() - startedAt,
        },
        "concurrent resume in progress — returning 202",
      );

      await recordSuccessAuditInTransaction(args, 202);

      return NextResponse.json(
        {
          ok: true,
          runStatus: "NeedsInput",
          state: "resume-in-progress",
        },
        { status: 202 },
      );
    }

    if (r.retryable) {
      log.warn(
        {
          runId,
          hitlRequestId,
          branch: "idle",
          phase: "resume-retryable",
          code: r.code,
          latencyMs: Date.now() - startedAt,
        },
        "resume spawn failed — caller may retry",
      );

      return NextResponse.json(
        { code: r.code, message: r.message, terminal: false },
        { status: 503 },
      );
    }

    log.warn(
      {
        runId,
        hitlRequestId,
        branch: "idle",
        phase: "resume-terminal",
        code: r.code,
        latencyMs: Date.now() - startedAt,
      },
      "resume spawn failed terminally — run transitioned to Failed",
    );
    await systemCloseActiveAssignmentsForRun({
      db,
      runId,
      reason: `permission resume failed terminally: ${r.code}`,
    });

    return NextResponse.json(
      { code: r.code, message: r.message, terminal: true },
      { status: 410 },
    );
  }

  // Phase 2: deliver to supervisor, then mark respondedAt.
  // `delivered` distinguishes a supervisor-side delivery FAILURE (deferred still
  // live → must be released, see catch) from a post-delivery DB failure (deferred
  // already resolved → must NOT be cancelled).
  let delivered = false;

  try {
    await deliverPermission(
      schema.supervisorSessionId,
      schema.requestId,
      optionId,
    );
    delivered = true;

    // Marker + scratch dialog flip + assignment completion + audit are one atomic
    // unit so the durable success state cannot commit without its token audit.
    await db.transaction(async (tx: any) => {
      const stamped = await tx
        .update(hitlRequests)
        .set({ respondedAt: new Date() })
        .where(
          and(
            eq(hitlRequests.id, hitlRequestId),
            isNull(hitlRequests.respondedAt),
          ),
        )
        .returning({ id: hitlRequests.id });

      await markScratchPermissionDelivered(tx, runRow, runId);
      await completeResponseAssignment(tx, assignmentClaim, { optionId });
      await args.recordSuccessAudit?.(tx, 200);

      // ADR-097: a project-less local-package assistant run has no project to
      // attribute this webhook to (webhook_events.project_id is NOT NULL and
      // consumers are project-scoped) — skip it.
      if (stamped.length > 0 && runRow.projectId) {
        await emitWebhookEvent({
          db: tx,
          type: "hitl.responded",
          projectId: runRow.projectId,
          runId,
          data: { hitlRequestId, kind: hitlRow.kind, via: "user" },
        });
      }
    });

    log.info(
      {
        runId,
        hitlRequestId,
        kind: "permission",
        phase: "delivered",
        supervisorAck: true,
        idempotent: claim.kind === "noop-idempotent",
        latencyMs: Date.now() - startedAt,
      },
      "permission delivered",
    );

    return NextResponse.json(
      { ok: true, runStatus: "NeedsInput" },
      { status: 200 },
    );
  } catch (err) {
    if (isMaisterError(err) && err.code === "HITL_TIMEOUT") {
      // Re-check under FOR UPDATE: a concurrent winner may have already
      // marked respondedAt — in which case the supervisor 404 we just
      // saw is the side-effect of THAT request succeeding, not a real
      // timeout. Returning 200 here is the correct idempotent outcome.
      //
      // M8 review pass 2 finding #1: if this was a
      // `noop-idempotent` retry (same-payload re-submit) we must NOT
      // mark the run Failed on the supervisor's 404. The 404 may be
      // the stale checkpointed deferred that the sweeper cancelled —
      // an M8 background resume driver is still delivering the
      // operator's intent against a fresh requestId. In that case we
      // return 202 "resume-in-progress" and let the auto-deliver
      // path (or the next retry hitting `already-delivered`) close
      // the row.
      const outcome = await db.transaction(async (tx: any) => {
        const lockedHitl = await lockHitlRow(tx, hitlRequestId);

        if (lockedHitl?.respondedAt) {
          return { transition: "already-delivered" } as const;
        }
        if (claim.kind === "noop-idempotent") {
          return { transition: "in-flight-resume" } as const;
        }
        const terminalRows = await tx
          .update(runs)
          .set({
            status: runRow.runKind === "scratch" ? "Crashed" : "Failed",
            endedAt: new Date(),
          })
          .where(and(eq(runs.id, runId), eq(runs.status, "NeedsInput")))
          .returning({
            projectId: runs.projectId,
            taskId: runs.taskId,
            flowId: runs.flowId,
            runKind: runs.runKind,
            parentRunId: runs.parentRunId,
          });

        await tx
          .update(hitlRequests)
          .set({ respondedAt: new Date() })
          .where(eq(hitlRequests.id, hitlRequestId));

        // ADR-097: project-less assistant run ⇒ no project to attribute the
        // terminal outbox events to (both emits require a non-null projectId).
        if (terminalRows.length > 0 && terminalRows[0].projectId) {
          await emitWebhookEvent({
            db: tx,
            type: runRow.runKind === "scratch" ? "run.crashed" : "run.failed",
            projectId: terminalRows[0].projectId,
            runId,
            data: { errorCode: "HITL_TIMEOUT" },
          });
          await emitDomainEvent({
            db: tx,
            kind: runRow.runKind === "scratch" ? "run.crashed" : "run.failed",
            projectId: terminalRows[0].projectId,
            runId,
            taskId: terminalRows[0].taskId,
            actor: { type: "system", id: null },
            parentRunId: terminalRows[0].parentRunId,
            payload: {
              runId,
              taskId: terminalRows[0].taskId,
              flowId: terminalRows[0].flowId,
              runKind: terminalRows[0].runKind,
              reason: "HITL_TIMEOUT",
            },
          });
        }

        return { transition: "terminal" } as const;
      });

      if (outcome.transition === "in-flight-resume") {
        log.info(
          {
            runId,
            hitlRequestId,
            kind: "permission",
            phase: "in-flight-resume-202",
            latencyMs: Date.now() - startedAt,
          },
          "supervisor 404 on idempotent retry — resume likely in flight; returning 202",
        );

        await recordSuccessAuditInTransaction(args, 202);

        return NextResponse.json(
          {
            ok: true,
            runStatus: "NeedsInput",
            state: "resume-in-progress",
          },
          { status: 202 },
        );
      }

      if (outcome.transition === "already-delivered") {
        await db.transaction(async (tx: any) => {
          await completeResponseAssignment(tx, assignmentClaim, { optionId });
          await args.recordSuccessAudit?.(tx, 200);
        });

        log.info(
          {
            runId,
            hitlRequestId,
            kind: "permission",
            phase: "concurrent-winner-200",
            latencyMs: Date.now() - startedAt,
          },
          "supervisor 404 raced a concurrent delivery — treating as success",
        );

        return NextResponse.json(
          { ok: true, runStatus: "NeedsInput" },
          { status: 200 },
        );
      }

      await markScratchPermissionTimedOut(db, runRow, runId);
      await systemCloseActiveAssignmentsForRun({
        db,
        runId,
        reason: "permission deferred expired before response was delivered",
      });

      log.warn(
        {
          runId,
          hitlRequestId,
          kind: "permission",
          phase: "terminal-410",
          latencyMs: Date.now() - startedAt,
        },
        runRow.runKind === "scratch"
          ? "permission deferred expired — scratch run transitioned to Crashed"
          : "permission deferred expired — run transitioned to Failed",
      );

      return NextResponse.json(
        {
          code: "HITL_TIMEOUT",
          message: "permission window expired before response was delivered",
        },
        { status: 410 },
      );
    }

    if (isMaisterError(err) && err.code === "EXECUTOR_UNAVAILABLE") {
      log.warn(
        {
          runId,
          hitlRequestId,
          kind: "permission",
          phase: "retry-503",
          latencyMs: Date.now() - startedAt,
        },
        "supervisor unreachable — response retryable",
      );

      return NextResponse.json(
        {
          code: "EXECUTOR_UNAVAILABLE",
          message: "supervisor unreachable; retry the response",
        },
        { status: 503 },
      );
    }

    // Terminal/unexpected delivery failure (e.g. ACP_PROTOCOL 409). If the
    // delivery itself failed, the supervisor's permission deferred is still live
    // and would leak until its keep-alive timeout, blocking the agent. Release it
    // explicitly (best-effort) before propagating. `delivered === true` means the
    // failure happened AFTER a successful delivery (the deferred is already
    // resolved) — cancelling then would be wrong, so we skip it.
    if (!delivered) {
      const code = isMaisterError(err) ? err.code : "unknown";

      try {
        await cancelPermission(
          schema.supervisorSessionId,
          schema.requestId,
          `permission delivery failed: ${code}`,
        );
        log.warn(
          {
            runId,
            hitlRequestId,
            kind: "permission",
            phase: "deferred-released",
            code,
          },
          "permission delivery failed terminally — released the live supervisor deferred",
        );
      } catch (cancelErr) {
        log.error(
          {
            runId,
            hitlRequestId,
            kind: "permission",
            phase: "deferred-release-failed",
            err:
              cancelErr instanceof Error
                ? cancelErr.message
                : String(cancelErr),
          },
          "failed to release supervisor permission deferred after delivery failure",
        );
      }
    }

    throw err;
  }
}

type FormClaim =
  | { kind: "claimed"; storedResponse: unknown; runStatus: string }
  | { kind: "already-delivered"; storedResponse: unknown; runStatus: string };

async function handleFormHumanResponse(
  args: HandlerArgs,
): Promise<NextResponse> {
  const { db, hitlRow, runRow, body, runId, hitlRequestId, startedAt } = args;

  if (TERMINAL_RUN_STATUS.has(runRow.status)) {
    throw new MaisterError(
      "CONFLICT",
      `run is terminal (${runRow.status}); cannot respond`,
    );
  }

  // Phase 0: validate BEFORE any state mutation. Confidence is validated first
  // so an out-of-range value returns 422 NEEDS_INPUT before the response-missing
  // check (which returns 400 CONFIG) — preserving the error-priority ordering.
  //
  // Response derivation: body.response takes priority; if absent, the body
  // itself (minus the top-level `confidence` field) is used as the response
  // payload, enabling flat-body callers (body: { field: value, confidence: 0.8 }).
  let confidence: number | undefined;
  let reviewFields: {
    decision?: string;
    workspacePolicy?: string | null;
    reworkTarget?: string | null;
  } = {};

  if (isReviewSchema(hitlRow.schema)) {
    // Review path: confidence flows through assertReviewDecision.
    const response = body.response;

    if (response === undefined) {
      throw new MaisterError(
        "CONFIG",
        `response is required for kind=${hitlRow.kind}`,
      );
    }
    const resolved = assertReviewDecision(
      response,
      hitlRow.schema,
      body.confidence,
    );

    confidence = resolved.confidence;
    reviewFields = {
      decision: resolved.decision,
      workspacePolicy: resolved.workspacePolicy ?? null,
      reworkTarget: resolved.reworkTarget ?? null,
    };
  } else {
    // Non-review: validate confidence first (422 before CONFIG 400).
    confidence = resolveConfidence(body.confidence);

    const response = body.response;

    if (response === undefined) {
      throw new MaisterError(
        "CONFIG",
        `response is required for kind=${hitlRow.kind}`,
      );
    }
    assertHitlResponse(response, hitlRow.schema);
  }

  // Build the canonical response-to-store once. This value is used for the
  // fresh-write DB set, ALL idempotency comparisons, and the artifact write.
  // If confidence is present and response is a plain non-array object, echo it in.
  // The `hitl_requests.human_confidence` COLUMN is the source of truth for
  // confidence (always written below); the jsonb echo is a best-effort
  // convenience that only applies to object responses (review/form payloads in
  // practice) — for an array/primitive response the column still carries it.
  const rawResponse: unknown = body.response;
  const responseToStore: unknown =
    confidence !== undefined &&
    rawResponse !== null &&
    typeof rawResponse === "object" &&
    !Array.isArray(rawResponse)
      ? { ...(rawResponse as Record<string, unknown>), confidence }
      : rawResponse;

  const projectRows = await db
    .select({ slug: projects.slug })
    .from(projects)
    .where(eq(projects.id, runRow.projectId));
  const projectSlug = projectRows[0]?.slug;

  if (!projectSlug) {
    throw new MaisterError("PRECONDITION", "project slug not found");
  }

  const assignmentClaim = await claimAssignmentForResponse({
    db,
    hitlRequestId,
    projectId: runRow.projectId,
    actor: args.actor,
  });

  // Phase 1: claim the row before touching the filesystem. Concurrent
  // double-submits with the same payload are idempotent; conflicting
  // payloads return 409 BEFORE either request can write to disk.

  const claim: FormClaim = await db.transaction(async (tx: any) => {
    const lockedHitl = await lockHitlRow(tx, hitlRequestId);
    const lockedRunRows = await tx
      .select()
      .from(runs)
      .where(eq(runs.id, runId));
    const lockedRun = lockedRunRows[0];

    if (!lockedHitl || !lockedRun) {
      throw new MaisterError("PRECONDITION", "row vanished mid-transaction");
    }
    if (TERMINAL_RUN_STATUS.has(lockedRun.status)) {
      throw new MaisterError(
        "CONFLICT",
        `run is terminal (${lockedRun.status}); cannot respond`,
      );
    }
    // Idempotent recovery (already-delivered / same-payload re-claim) is exempt
    // from the pending-status guard below: those responses were already
    // accepted while the run was pending, and the runner may since have flipped
    // NeedsInput → Running (it owns that transition, M11b). The guard fires only
    // on the FRESH-write branch — a never-delivered response is rejected unless
    // the run is genuinely awaiting it, closing the HumanWorking replay hole.
    if (lockedHitl.respondedAt) {
      if (payloadsEqual(lockedHitl.response, responseToStore)) {
        return {
          kind: "already-delivered",
          storedResponse: lockedHitl.response,
          runStatus: lockedRun.status as string,
        } as const;
      }
      throw new MaisterError("CONFLICT", "hitl request already delivered");
    }
    if (lockedHitl.response !== null && lockedHitl.response !== undefined) {
      if (!payloadsEqual(lockedHitl.response, responseToStore)) {
        throw new MaisterError(
          "CONFLICT",
          "hitl request already claimed with a different response payload",
        );
      }

      // same payload — idempotent retry. Fall through to artifact write.
      return {
        kind: "claimed",
        storedResponse: lockedHitl.response,
        runStatus: lockedRun.status as string,
      } as const;
    }

    // Fresh response: accept ONLY when the run is genuinely awaiting it
    // (NeedsInput / NeedsInputIdle). HumanWorking (a manual takeover is active)
    // and every other non-pending status reject here so a pre-takeover decision
    // never gets stored + replayed by the post-return rerun.
    if (!PENDING_HITL_RUN_STATUS.has(lockedRun.status)) {
      throw new MaisterError(
        "CONFLICT",
        `run is not awaiting this response (status=${lockedRun.status}); cannot respond`,
      );
    }

    const confidenceFields =
      confidence !== undefined ? { humanConfidence: confidence } : {};

    await tx
      .update(hitlRequests)
      .set({ response: responseToStore, ...reviewFields, ...confidenceFields })
      .where(
        and(
          eq(hitlRequests.id, hitlRequestId),
          isNull(hitlRequests.respondedAt),
          isNull(hitlRequests.response),
        ),
      );

    log.info(
      { runId, hitlRequestId, confidence },
      "confidence recorded on response",
    );

    return {
      kind: "claimed",
      storedResponse: responseToStore,
      runStatus: lockedRun.status as string,
    } as const;
  });

  if (claim.kind === "already-delivered") {
    await db.transaction(async (tx: any) => {
      await completeResponseAssignment(tx, assignmentClaim, {
        response: claim.storedResponse as Record<string, unknown>,
      });
      await args.recordSuccessAudit?.(tx, 200);
    });

    // Same-payload retry on an already-delivered row. If the run is
    // still in NeedsInput, the original microtask may have been lost
    // (process restart between commit and queueMicrotask, runner
    // crash, etc.) — re-queue the wake here so the retry is the
    // durable recovery path. Idempotent: runFlow's resume gate is a
    // no-op if the run has already advanced.
    const needsRequeue = claim.runStatus === "NeedsInput";

    if (needsRequeue) {
      scheduleResume(runId);
    }
    log.info(
      {
        runId,
        hitlRequestId,
        kind: hitlRow.kind,
        phase: "already-delivered",
        requeuedResume: needsRequeue,
        latencyMs: Date.now() - startedAt,
      },
      "form/human already delivered (idempotent retry)",
    );

    return NextResponse.json(
      { ok: true, runStatus: "NeedsInput" },
      { status: 200 },
    );
  }

  // Phase 2: write the artifact from the STORED response value. Even on
  // an idempotent retry we re-write so that disk and DB stay consistent
  // when an earlier attempt crashed between the claim and the write.
  const inputPath = path.join(
    runtimeRoot(),
    ".maister",
    projectSlug,
    "runs",
    runId,
    `input-${hitlRow.stepId}.json`,
  );

  try {
    await atomicWriteJson(inputPath, claim.storedResponse);
  } catch (err) {
    // respondedAt is still null — leave the row claimed and retryable.
    // The user's intent is durably stored in the DB; the runner's
    // resume-from-existing-input branch will read it on the next try.
    log.warn(
      {
        runId,
        hitlRequestId,
        err: err instanceof Error ? err.message : String(err),
      },
      "input artifact write failed — retryable",
    );

    return NextResponse.json(
      {
        code: "EXECUTOR_UNAVAILABLE",
        message: "could not persist input artifact; retry",
      },
      { status: 503 },
    );
  }

  // Phase 3: mark the response delivered. The runner is the single
  // owner of the NeedsInput → Running transition (see runFlow's
  // isResume detection); flipping status here would defeat the
  // resume gate and restart the flow at step 0.
  await db.transaction(async (tx: any) => {
    const stamped = await tx
      .update(hitlRequests)
      .set({ respondedAt: new Date() })
      .where(
        and(
          eq(hitlRequests.id, hitlRequestId),
          isNull(hitlRequests.respondedAt),
        ),
      )
      .returning({ id: hitlRequests.id });

    await completeResponseAssignment(tx, assignmentClaim, {
      response: claim.storedResponse as Record<string, unknown>,
    });
    await args.recordSuccessAudit?.(tx, 200);

    if (stamped.length > 0) {
      await emitWebhookEvent({
        db: tx,
        type: "hitl.responded",
        projectId: runRow.projectId,
        runId,
        data: { hitlRequestId, kind: hitlRow.kind, via: "user" },
      });
    }
  });

  scheduleResume(runId);

  log.info(
    {
      runId,
      hitlRequestId,
      kind: hitlRow.kind,
      phase: "delivered",
      supervisorAck: false,
      latencyMs: Date.now() - startedAt,
    },
    "form/human response delivered",
  );

  return NextResponse.json(
    { ok: true, runStatus: "NeedsInput" },
    { status: 200 },
  );
}

// infra_recovery (A2 auto_retry exhaustion escalation): a human chooses
// `retry` or `abandon` on a run paused after the in-run auto-retries were spent.
//  - retry   → close the assignment + wake the runner; the resume RE-RUNS the
//              failed node with the worktree intact (one attempt per click — the
//              human is the backoff; a repeat failure re-escalates).
//  - abandon → fail the run terminally (run.failed); the task returns to Backlog.
// Idempotent on a responded row. Human-actor-only (enforced in respondToHitl).
async function handleInfraRecoveryResponse(args: {
  db: any;
  hitlRow: any;
  runRow: any;
  body: { optionId?: string };
  runId: string;
  hitlRequestId: string;
  startedAt: number;
  recordSuccessAudit?: (db: any, statusCode: number) => Promise<void>;
}): Promise<NextResponse> {
  const {
    db,
    hitlRow,
    runRow,
    body,
    runId,
    hitlRequestId,
    startedAt,
    recordSuccessAudit,
  } = args;
  const decision = body.optionId;

  if (decision !== "retry" && decision !== "abandon") {
    throw new MaisterError(
      "PRECONDITION",
      'infra_recovery response requires optionId "retry" or "abandon"',
    );
  }

  const outcome = await db.transaction(async (tx: any) => {
    const locked = await lockHitlRow(tx, hitlRequestId);

    if (!locked) {
      throw new MaisterError(
        "PRECONDITION",
        `hitl request not found: ${hitlRequestId}`,
      );
    }
    if (locked.respondedAt) {
      return { transition: "already-delivered" } as const;
    }

    await tx
      .update(hitlRequests)
      .set({ respondedAt: new Date() })
      .where(eq(hitlRequests.id, hitlRequestId));

    if (decision === "abandon") {
      const terminal = await tx
        .update(runs)
        .set({ status: "Failed", endedAt: new Date() })
        .where(
          and(
            eq(runs.id, runId),
            inArray(runs.status, ["NeedsInput", "NeedsInputIdle"]),
          ),
        )
        .returning({
          projectId: runs.projectId,
          taskId: runs.taskId,
          flowId: runs.flowId,
          runKind: runs.runKind,
          parentRunId: runs.parentRunId,
        });

      if (terminal.length > 0) {
        const errorCode =
          (hitlRow.schema as { code?: string } | null)?.code ??
          "EXECUTOR_UNAVAILABLE";

        await emitWebhookEvent({
          db: tx,
          type: "run.failed",
          projectId: terminal[0].projectId,
          runId,
          data: { errorCode, reason: "infra_recovery_abandoned" },
        });
        await emitDomainEvent({
          db: tx,
          kind: "run.failed",
          projectId: terminal[0].projectId,
          runId,
          taskId: terminal[0].taskId,
          actor: { type: "system", id: null },
          parentRunId: terminal[0].parentRunId,
          payload: {
            runId,
            taskId: terminal[0].taskId,
            flowId: terminal[0].flowId,
            runKind: terminal[0].runKind,
            reason: "infra_recovery_abandoned",
          },
        });
      }
      await systemCloseActiveAssignmentsForRun({
        db: tx,
        runId,
        reason: "infra-recovery abandoned",
      });
      await recordSuccessAudit?.(tx, 200);

      return { transition: "abandoned" } as const;
    }

    // retry: close the assignment; the runner re-runs the node on resume.
    await systemCloseActiveAssignmentsForRun({
      db: tx,
      runId,
      reason: "infra-recovery retry",
    });
    await emitWebhookEvent({
      db: tx,
      type: "hitl.responded",
      projectId: runRow.projectId,
      runId,
      data: { hitlRequestId, kind: "infra_recovery", via: "user" },
    });
    await recordSuccessAudit?.(tx, 200);

    return { transition: "retry" } as const;
  });

  if (outcome.transition === "already-delivered") {
    return NextResponse.json(
      { ok: true, runStatus: runRow.status, idempotent: true },
      { status: 200 },
    );
  }

  if (outcome.transition === "abandoned") {
    log.info(
      { runId, hitlRequestId, decision, latencyMs: Date.now() - startedAt },
      "infra_recovery abandoned — run Failed",
    );

    return NextResponse.json(
      { ok: true, runStatus: "Failed" },
      { status: 200 },
    );
  }

  // retry → the runner re-runs the failed node (worktree preserved)
  scheduleResume(runId);
  log.info(
    { runId, hitlRequestId, decision, latencyMs: Date.now() - startedAt },
    "infra_recovery retry — resuming (re-run node)",
  );

  return NextResponse.json(
    { ok: true, runStatus: "NeedsInput", state: "resume-in-progress" },
    { status: 202 },
  );
}

// Maps the breached meter to the BudgetLimits field a raise writes. tokens →
// maxTokens (escalate ceiling), failures → consecutiveFailures, wallclock →
// wallClockMinutes (tree only). hardMaxTokens is left untouched — the raise
// lifts the escalate ceiling; the terminate band re-derives from it.
const BUDGET_METER_FIELD = {
  tokens: "maxTokens",
  failures: "consecutiveFailures",
  wallclock: "wallClockMinutes",
} as const;

type BudgetBreachSchema = {
  scope: BudgetScope;
  meter: keyof typeof BUDGET_METER_FIELD;
  limit: number;
};

// budget_breach (cost-budget governance ESCALATE rung): a human chooses
// `raise` or `abandon` on a run paused at a token/failure/wall-clock ceiling.
//  - abandon → fail the run terminally (run.failed, BUDGET_EXCEEDED); the task
//              returns to Backlog.
//  - raise   → write budget_state.ceilingOverride[scope] (additive — the
//              execution snapshot stays immutable), clear notified[scope] so the
//              raised band re-warns (E10), log budget_raised, then resume. The
//              raise amount is validated fail-CLOSED (positive int > the breached
//              limit) even though the budget axis itself fails open.
// Idempotent on a responded row. Human-actor-only (enforced in respondToHitl).
async function handleBudgetBreachResponse(args: {
  db: any;
  hitlRow: any;
  runRow: any;
  body: { optionId?: string; raiseTo?: unknown; response?: unknown };
  runId: string;
  hitlRequestId: string;
  startedAt: number;
  recordSuccessAudit?: (db: any, statusCode: number) => Promise<void>;
}): Promise<NextResponse> {
  const {
    db,
    hitlRow,
    body,
    runId,
    hitlRequestId,
    startedAt,
    recordSuccessAudit,
  } = args;
  const decision = body.optionId;

  if (decision !== "raise" && decision !== "abandon") {
    throw new MaisterError(
      "PRECONDITION",
      'budget_breach response requires optionId "raise" or "abandon"',
    );
  }

  const breach = (hitlRow.schema ?? {}) as BudgetBreachSchema;
  const scope = breach.scope;
  const meter = breach.meter;

  // Validate the raise amount at the sink BEFORE opening the transaction.
  // Out-of-range ≠ missing: a present-but-invalid raise is fail-closed
  // (PRECONDITION), never silently dropped. raiseTo OR response carries it.
  let raiseTo = 0;

  if (decision === "raise") {
    const raw = body.raiseTo ?? body.response;
    const candidate = typeof raw === "number" ? raw : Number(raw);

    if (
      !Number.isInteger(candidate) ||
      candidate <= 0 ||
      candidate <= breach.limit
    ) {
      throw new MaisterError(
        "PRECONDITION",
        `budget_breach raise requires a positive integer greater than the breached limit (${breach.limit})`,
      );
    }
    raiseTo = candidate;
  }

  const outcome = await db.transaction(async (tx: any) => {
    const locked = await lockHitlRow(tx, hitlRequestId);

    if (!locked) {
      throw new MaisterError(
        "PRECONDITION",
        `hitl request not found: ${hitlRequestId}`,
      );
    }
    if (locked.respondedAt) {
      return { transition: "already-delivered" } as const;
    }

    await tx
      .update(hitlRequests)
      .set({ respondedAt: new Date() })
      .where(eq(hitlRequests.id, hitlRequestId));

    if (decision === "abandon") {
      const terminal = await tx
        .update(runs)
        .set({ status: "Failed", endedAt: new Date() })
        .where(
          and(
            eq(runs.id, runId),
            inArray(runs.status, ["NeedsInput", "NeedsInputIdle"]),
          ),
        )
        .returning({
          projectId: runs.projectId,
          taskId: runs.taskId,
          flowId: runs.flowId,
          runKind: runs.runKind,
          parentRunId: runs.parentRunId,
        });

      if (terminal.length > 0) {
        await emitWebhookEvent({
          db: tx,
          type: "run.failed",
          projectId: terminal[0].projectId,
          runId,
          data: { errorCode: "BUDGET_EXCEEDED", reason: "budget_abandoned" },
        });
        await emitDomainEvent({
          db: tx,
          kind: "run.failed",
          projectId: terminal[0].projectId,
          runId,
          taskId: terminal[0].taskId,
          actor: { type: "system", id: null },
          parentRunId: terminal[0].parentRunId,
          payload: {
            runId,
            taskId: terminal[0].taskId,
            flowId: terminal[0].flowId,
            runKind: terminal[0].runKind,
            errorCode: "BUDGET_EXCEEDED",
            reason: "budget_abandoned",
          },
        });
      }
      await systemCloseActiveAssignmentsForRun({
        db: tx,
        runId,
        reason: "budget breach abandoned",
      });
      await recordSuccessAudit?.(tx, 200);

      return { transition: "abandoned" } as const;
    }

    // raise: merge the per-scope ceiling override + clear the per-scope notified
    // rung, CAS-guarded on the still-pausable status so a moved run is not raised.
    // Re-read budget_state under the lock so a concurrent warn-rung write is not
    // clobbered (the run is locked transitively via the hitl row + status CAS).
    const [current] = await tx
      .select({ budgetState: runs.budgetState })
      .from(runs)
      .where(eq(runs.id, runId));
    const prior = (current?.budgetState ?? null) as BudgetState | null;
    const priorOverride: BudgetAxis = prior?.ceilingOverride ?? {};
    const field = BUDGET_METER_FIELD[meter];
    const nextOverride: BudgetAxis = {
      ...priorOverride,
      [scope]: { ...(priorOverride[scope] ?? {}), [field]: raiseTo },
    };
    const nextNotified = { ...(prior?.notified ?? {}) };

    delete nextNotified[scope];

    const nextState: BudgetState = {
      ceilingOverride: nextOverride,
      notified: nextNotified,
    };

    const raised = await tx
      .update(runs)
      .set({ budgetState: nextState })
      .where(
        and(
          eq(runs.id, runId),
          inArray(runs.status, ["NeedsInput", "NeedsInputIdle"]),
        ),
      )
      .returning({ id: runs.id });

    if (raised.length === 0) {
      throw new MaisterError(
        "CONFLICT",
        `run ${runId} is no longer awaiting a budget-breach response`,
      );
    }

    await systemCloseActiveAssignmentsForRun({
      db: tx,
      runId,
      reason: "budget breach raised",
    });
    logExecPolicyAction({
      runId,
      kind: "budget_raised",
      detail: { scope, meter, raiseTo },
    });
    await recordSuccessAudit?.(tx, 200);

    return { transition: "raised" } as const;
  });

  if (outcome.transition === "already-delivered") {
    return NextResponse.json({ ok: true, idempotent: true }, { status: 200 });
  }

  if (outcome.transition === "abandoned") {
    log.info(
      { runId, hitlRequestId, decision, latencyMs: Date.now() - startedAt },
      "budget_breach abandoned — run Failed",
    );

    return NextResponse.json(
      { ok: true, runStatus: "Failed" },
      { status: 200 },
    );
  }

  // raise → resume the run (worktree preserved, effective ceiling lifted)
  scheduleResume(runId);
  log.info(
    {
      runId,
      hitlRequestId,
      decision,
      scope,
      meter,
      raiseTo,
      latencyMs: Date.now() - startedAt,
    },
    "budget_breach raised — resuming",
  );

  return NextResponse.json(
    { ok: true, runStatus: "NeedsInput", state: "resume-in-progress" },
    { status: 202 },
  );
}

export async function respondToHitl(
  input: RespondInput,
  actor: HitlActor,
  deps: {
    db: any;
    recordSuccessAudit?: (db: any, statusCode: number) => Promise<void>;
  },
): Promise<NextResponse> {
  const { db, recordSuccessAudit } = deps;
  const { runId, hitlRequestId, body } = input;
  const startedAt = Date.now();

  log.info(
    { runId, hitlRequestId, actorKind: actor.kind, actorLabel: actor.label },
    "respondToHitl",
  );

  const hitlRows = await db
    .select()
    .from(hitlRequests)
    .where(eq(hitlRequests.id, hitlRequestId));
  const hitlRow = hitlRows[0];

  if (!hitlRow) {
    throw new MaisterError(
      "PRECONDITION",
      `hitl request not found: ${hitlRequestId}`,
    );
  }
  if (hitlRow.runId !== runId) {
    throw new MaisterError(
      "PRECONDITION",
      `hitl request ${hitlRequestId} does not belong to run ${runId}`,
    );
  }

  const runRows = await db.select().from(runs).where(eq(runs.id, runId));
  const runRow = runRows[0];

  if (!runRow) {
    throw new MaisterError("PRECONDITION", `run not found: ${runId}`);
  }

  // AUTHZ branch on actor kind
  if (actor.kind === "user") {
    // ADR-097: a project-less local-package assistant run (projectId NULL)
    // carries member-level RBAC (any active user, per ADR-096); a project run
    // keeps its project-scoped answerHitl gate. requireActiveSession is already
    // enforced by the calling route, so this branch only needs the project gate.
    if (runRow.projectId) {
      await requireProjectAction(runRow.projectId, "answerHitl");
    }
  } else {
    // D7 (ADR-055): a `human`-kind HITL (incl. graph human_review) is a Flow gate
    // that ONLY a human actor may satisfy. A machine token can never answer it,
    // even holding hitl:respond scope. Enforced here (the shared chokepoint),
    // BEFORE any mutation — so neither the session route nor the ext route can
    // bypass it.
    if (
      hitlRow.kind === "human" ||
      hitlRow.kind === "infra_recovery" ||
      hitlRow.kind === "budget_breach"
    ) {
      throw new MaisterError(
        "UNAUTHORIZED",
        `a ${hitlRow.kind}-kind HITL request requires a human actor`,
      );
    }
    // Defense-in-depth project scope (the ext route already existence-hides a
    // cross-project run as 404; this re-check guarantees the service alone never
    // answers across projects).
    if (actor.projectId !== runRow.projectId) {
      throw new MaisterError("UNAUTHORIZED", "actor project mismatch");
    }
  }

  if (hitlRow.kind === "permission") {
    log.debug({ runId, hitlRequestId, branch: "permission" }, "dispatch");

    return await handlePermissionResponse({
      db,
      hitlRow,
      runRow,
      body,
      runId,
      hitlRequestId,
      startedAt,
      actor,
      recordSuccessAudit,
    });
  }

  if (hitlRow.kind === "infra_recovery") {
    log.debug({ runId, hitlRequestId, branch: "infra_recovery" }, "dispatch");

    return await handleInfraRecoveryResponse({
      db,
      hitlRow,
      runRow,
      body,
      runId,
      hitlRequestId,
      startedAt,
      recordSuccessAudit,
    });
  }

  if (hitlRow.kind === "budget_breach") {
    log.debug({ runId, hitlRequestId, branch: "budget_breach" }, "dispatch");

    return await handleBudgetBreachResponse({
      db,
      hitlRow,
      runRow,
      body,
      runId,
      hitlRequestId,
      startedAt,
      recordSuccessAudit,
    });
  }

  log.debug({ runId, hitlRequestId, branch: "form/human" }, "dispatch");

  return await handleFormHumanResponse({
    db,
    hitlRow,
    runRow,
    body,
    runId,
    hitlRequestId,
    startedAt,
    actor,
    recordSuccessAudit,
  });
}
