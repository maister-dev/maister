import "server-only";

import path from "node:path";

import { and, eq, isNull } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import {
  claimAssignment,
  completeAssignment,
  ensureUserActor,
  systemCloseActiveAssignmentsForRun,
} from "@/lib/assignments/service";
import { atomicWriteJson } from "@/lib/atomic";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  assertHitlResponse,
  assertReviewDecision,
  isReviewSchema,
} from "@/lib/flows/hitl-validate";
import { runFlow } from "@/lib/flows/runner";
import { deliverPermission } from "@/lib/supervisor-client";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { assignments, hitlRequests, projects, runs, scratchRuns } =
  schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "api-hitl",
  level: process.env.LOG_LEVEL ?? "info",
});

const TERMINAL_RUN_STATUS = new Set([
  "Failed",
  "Crashed",
  "Done",
  "Abandoned",
  "Review",
]);

// A form/human (incl. graph human_review) HITL is genuinely pending ONLY while
// the run awaits the response — NeedsInput or its idle checkpoint
// NeedsInputIdle. Any other status (notably HumanWorking, where a manual
// takeover is active) means the original review HITL is no longer the live
// question: accepting it would store a pre-takeover decision whose step-keyed
// input-<stepId>.json artifact the post-return rerun could replay over the
// human's edits, bypassing fresh review. The runner still owns NeedsInput →
// Running (M11b contract) — this guard never flips status.
const PENDING_FORM_RUN_STATUS = new Set(["NeedsInput", "NeedsInputIdle"]);

const bodySchema = z.object({
  optionId: z.string().min(1).optional(),
  response: z.unknown().optional(),
});

function errorResponse(
  err: unknown,
  ctx: { runId: string; hitlRequestId: string },
): NextResponse {
  if (isMaisterError(err)) {
    const status = httpStatusForCode(err.code);

    log.warn(
      { ...ctx, code: err.code, message: err.message, status },
      "respond error",
    );

    return NextResponse.json(
      { code: err.code, message: err.message },
      { status },
    );
  }
  const message = err instanceof Error ? err.message : String(err);

  log.error({ ...ctx, err: message }, "respond unhandled error");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

function httpStatusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
      return 403;
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
    case "EXECUTOR_UNAVAILABLE":
      return 503;
    case "HITL_TIMEOUT":
      return 410;
    case "CONFIG":
      return 400;
    case "NEEDS_INPUT":
      return 422;
    default:
      return 500;
  }
}

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

type RouteParams = {
  params: Promise<{ runId: string; hitlRequestId: string }>;
};

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId, hitlRequestId } = await params;
  const startedAt = Date.now();

  let body: z.infer<typeof bodySchema>;

  try {
    body = bodySchema.parse(await req.json());
  } catch (err) {
    return errorResponse(
      new MaisterError(
        "CONFIG",
        `invalid response body: ${(err as Error).message}`,
      ),
      { runId, hitlRequestId },
    );
  }

  try {
    // Auth-first: authenticate AND clear the forced-password-change gate
    // BEFORE any resource lookup, so unauthenticated or must-change callers
    // cannot probe HITL/run existence via PRECONDITION shape-leaks. Project
    // membership is enforced below, once projectId is derived from the run row.
    const sessionUser = await requireActiveSession();

    // FIXME(any): dual drizzle-orm peer-dep variants — pg|sqlite union.
    const db = getDb() as any;
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

    // RBAC: projectId is server-state (from the run row), never body-supplied.
    // Responding to HITL requires project member+.
    await requireProjectAction(runRow.projectId, "answerHitl");

    if (hitlRow.kind === "permission") {
      return await handlePermissionResponse({
        db,
        hitlRow,
        runRow,
        body,
        runId,
        hitlRequestId,
        startedAt,
        sessionUser,
      });
    }

    return await handleFormHumanResponse({
      db,
      hitlRow,
      runRow,
      body,
      runId,
      hitlRequestId,
      startedAt,
      sessionUser,
    });
  } catch (err) {
    return errorResponse(err, { runId, hitlRequestId });
  }
}

type HandlerArgs = {
  db: any;

  hitlRow: any;

  runRow: any;
  body: z.infer<typeof bodySchema>;
  runId: string;
  hitlRequestId: string;
  startedAt: number;
  sessionUser: {
    id: string;
    name?: string | null;
    email?: string | null;
  };
};

type ResponseAssignmentClaim = {
  assignmentId: string;
  actorId: string;
} | null;

async function claimAssignmentForResponse(args: {
  db: any;
  hitlRequestId: string;
  projectId: string;
  sessionUser: HandlerArgs["sessionUser"];
}): Promise<ResponseAssignmentClaim> {
  const [assignment] = await args.db
    .select()
    .from(assignments)
    .where(eq(assignments.hitlRequestId, args.hitlRequestId));

  if (!assignment) return null;

  const actor = await ensureUserActor({
    db: args.db,
    projectId: args.projectId,
    userId: args.sessionUser.id,
    label:
      args.sessionUser.name ?? args.sessionUser.email ?? args.sessionUser.id,
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
    sessionUser: args.sessionUser,
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
    await completeResponseAssignment(db, assignmentClaim, { optionId });

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
    const { resumeRun } = await import("@/lib/runs/resume");
    const { scheduleResumedSessionDrive } = await import(
      "@/lib/runs/resume-driver"
    );
    const r = await resumeRun(runId, { db });

    if (r.ok) {
      // [FIX] M8 review finding #2: schedule the actual driver. Until
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

    // [FIX] M8 review finding #3: claim race lost is NOT a terminal
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
  try {
    await deliverPermission(
      schema.supervisorSessionId,
      schema.requestId,
      optionId,
    );

    await db
      .update(hitlRequests)
      .set({ respondedAt: new Date() })
      .where(
        and(
          eq(hitlRequests.id, hitlRequestId),
          isNull(hitlRequests.respondedAt),
        ),
      );
    await markScratchPermissionDelivered(db, runRow, runId);
    await completeResponseAssignment(db, assignmentClaim, { optionId });

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
      // [FIX] M8 review pass 2 finding #1: if this was a
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
        await tx
          .update(runs)
          .set({
            status: runRow.runKind === "scratch" ? "Crashed" : "Failed",
            endedAt: new Date(),
          })
          .where(and(eq(runs.id, runId), eq(runs.status, "NeedsInput")));
        await tx
          .update(hitlRequests)
          .set({ respondedAt: new Date() })
          .where(eq(hitlRequests.id, hitlRequestId));

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
          "[FIX] supervisor 404 on idempotent retry — resume likely in flight; returning 202",
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

      if (outcome.transition === "already-delivered") {
        await completeResponseAssignment(db, assignmentClaim, { optionId });

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
  const response = body.response;

  if (response === undefined) {
    throw new MaisterError(
      "CONFIG",
      `response is required for kind=${hitlRow.kind}`,
    );
  }

  if (TERMINAL_RUN_STATUS.has(runRow.status)) {
    throw new MaisterError(
      "CONFLICT",
      `run is terminal (${runRow.status}); cannot respond`,
    );
  }

  // Phase 0: validate the response BEFORE any state mutation. Returns 422
  // NEEDS_INPUT on failure so retries with a fixed payload are still
  // possible (respondedAt remains null because the claim never ran).
  //
  // A graph human_review HITL validates the decision against the server-state
  // allow-list stored on the row at creation (never body-trusted) and resolves
  // the columns persisted at claim time. Non-review form/human stays on the
  // form-schema validation.
  let reviewFields: {
    decision?: string;
    workspacePolicy?: string | null;
    reworkTarget?: string | null;
  } = {};

  if (isReviewSchema(hitlRow.schema)) {
    const resolved = assertReviewDecision(response, hitlRow.schema);

    reviewFields = {
      decision: resolved.decision,
      workspacePolicy: resolved.workspacePolicy ?? null,
      reworkTarget: resolved.reworkTarget ?? null,
    };
  } else {
    assertHitlResponse(response, hitlRow.schema);
  }

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
    sessionUser: args.sessionUser,
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
      if (payloadsEqual(lockedHitl.response, response)) {
        return {
          kind: "already-delivered",
          storedResponse: lockedHitl.response,
          runStatus: lockedRun.status as string,
        } as const;
      }
      throw new MaisterError("CONFLICT", "hitl request already delivered");
    }
    if (lockedHitl.response !== null && lockedHitl.response !== undefined) {
      if (!payloadsEqual(lockedHitl.response, response)) {
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
    if (!PENDING_FORM_RUN_STATUS.has(lockedRun.status)) {
      throw new MaisterError(
        "CONFLICT",
        `run is not awaiting this response (status=${lockedRun.status}); cannot respond`,
      );
    }

    await tx
      .update(hitlRequests)
      .set({ response, ...reviewFields })
      .where(
        and(
          eq(hitlRequests.id, hitlRequestId),
          isNull(hitlRequests.respondedAt),
          isNull(hitlRequests.response),
        ),
      );

    return {
      kind: "claimed",
      storedResponse: response,
      runStatus: lockedRun.status as string,
    } as const;
  });

  if (claim.kind === "already-delivered") {
    await completeResponseAssignment(db, assignmentClaim, {
      response: claim.storedResponse as Record<string, unknown>,
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
  await db
    .update(hitlRequests)
    .set({ respondedAt: new Date() })
    .where(
      and(eq(hitlRequests.id, hitlRequestId), isNull(hitlRequests.respondedAt)),
    );
  await completeResponseAssignment(db, assignmentClaim, {
    response: claim.storedResponse as Record<string, unknown>,
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
