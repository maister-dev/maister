import "server-only";

import type {
  BudgetAxis,
  BudgetScope,
  BudgetState,
} from "@/lib/runs/execution-policy";

import path from "node:path";

import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  sql,
} from "drizzle-orm";
import { NextResponse } from "next/server";
import pino from "pino";

import { requireProjectAction } from "@/lib/authz";
import {
  claimAssignment,
  completeAssignment,
  ensureApiTokenActor,
  ensureUserActor,
  systemCloseActiveAssignmentsForRun,
  systemCloseActiveAssignmentsForHitlRequest,
} from "@/lib/assignments/service";
import { atomicWriteJson } from "@/lib/atomic";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  assertConsensusDecision,
  assertHitlResponse,
  assertReviewDecision,
  isConsensusResolutionSchema,
  isReviewSchema,
  resolveConfidence,
} from "@/lib/flows/hitl-validate";
import { isPlanReviewDecisionRequestSchema } from "@/lib/flows/graph/plan-review-decisions";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { captureExperimentDiffSnapshotForRun } from "@/lib/experiments/diff-snapshot";
import { isExperimentMemberRun } from "@/lib/experiments/membership";
import { syncExperimentStatusForRun } from "@/lib/experiments/status-sync";
import { runFlow } from "@/lib/flows/runner";
import { runtimeRoot } from "@/lib/runtime-root";
import {
  classifyForceRelaunchLaunchability,
  classifyManualTaskLaunchability,
  getLatestFlowRun,
} from "@/lib/runs/launchability";
import { loadActiveRunSession } from "@/lib/runs/active-run-session";
import { revokeAgentRunTokensForRun } from "@/lib/agents/tokens";
import {
  assertBudgetBreachOptionAvailable,
  budgetBreachClaimRef,
  budgetMeterToPolicyField,
  evaluateBudgetBreachClaim,
  parseBudgetBreachResponse,
  type BudgetBreachAvailabilityContext,
  type BudgetBreachDecision,
  type BudgetBreachMeter,
  type BudgetBreachScope,
  type BudgetBreachStagedDecision,
} from "@/lib/runs/budget-breach-fork";
import { logExecPolicyAction } from "@/lib/runs/exec-policy-audit";
import { capForPool, countLiveRuns, takeSchedulerLock } from "@/lib/scheduler";
import { launchRun } from "@/lib/services/runs";
import { sendTaskToTriageInTransaction } from "@/lib/services/triage";
import { actorForUserId } from "@/lib/social/activity";
import { addTaskComment } from "@/lib/social/comments";
import { getOpenRelationBlockers } from "@/lib/social/relations";
import {
  cancelPermission,
  checkpointSession,
  deliverPermission,
} from "@/lib/supervisor-client";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";
import {
  archiveWorkbench,
  createWorkbenchHandoffBranch,
  getWorkbenchHandoffMetadata,
  isCleanWorkbenchPrecondition,
  snapshotWorkbenchCommit,
  dropWorkbench,
} from "@/lib/workbench-lifecycle/service";
import { headCommit, localBranchHead, remoteBranchHead } from "@/lib/worktree";

// FIXME(any): dual drizzle-orm peer-dep variants.
const {
  artifactInstances,
  assignments,
  hitlRequests,
  projects,
  runs,
  scratchRuns,
  taskClarifications,
  tasks,
  workspaces,
} = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "hitl-service",
  level: process.env.LOG_LEVEL ?? "info",
});

type BudgetRestartLaunchResult = {
  runId: string;
  status: string;
  queuePosition?: number;
};

const TERMINAL_RUN_STATUS = new Set([
  "Failed",
  "Crashed",
  "Done",
  "Abandoned",
  "Review",
]);
const AGENT_QUESTION_SOURCE_STATUSES: Array<
  "Running" | "Failed" | "Crashed" | "Abandoned" | "Review"
> = ["Running", "Failed", "Crashed", "Abandoned", "Review"];
const AGENT_QUESTION_SOURCE_STATUS_SET = new Set<string>([
  "Done",
  ...AGENT_QUESTION_SOURCE_STATUSES,
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

// Acquire a row-level lock on the HITL request row inside a transaction.
async function lockHitlRow(tx: any, hitlRequestId: string): Promise<any> {
  const rows = await tx
    .select()
    .from(hitlRequests)
    .where(eq(hitlRequests.id, hitlRequestId))
    .for("update");

  return rows[0];
}

// A Plan-review parent is the serialization boundary for both child answers and
// direct parent rework. Acquire one transaction-scoped key before row locks so
// a child-assignment claim cannot invert the parent/child lock order under
// concurrent responses.
async function lockPlanReviewParent(
  tx: any,
  parentHitlRequestId: string,
): Promise<any> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${parentHitlRequestId}))`,
  );

  return lockHitlRow(tx, parentHitlRequestId);
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

async function claimGraphResumeSlot(
  db: any,
  runId: string,
): Promise<"ready" | "queued" | "noop"> {
  return db.transaction(async (tx: any) => {
    await takeSchedulerLock(tx);

    const [current]: Array<{ status: string }> = await tx
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId));

    if (!current) return "noop";

    if (current.status === "NeedsInput") return "ready";

    if (current.status !== "NeedsInputIdle") return "noop";

    if ((await countLiveRuns(tx, "flow")) >= capForPool("flow")) {
      await tx
        .update(runs)
        .set({ resumeRequestedAt: new Date() })
        .where(and(eq(runs.id, runId), eq(runs.status, "NeedsInputIdle")));

      return "queued";
    }

    const resumed = await tx
      .update(runs)
      .set({
        status: "NeedsInput",
        resumeRequestedAt: null,
        keepaliveUntil: null,
        checkpointAt: null,
      })
      .where(and(eq(runs.id, runId), eq(runs.status, "NeedsInputIdle")))
      .returning({ id: runs.id });

    return resumed.length > 0 ? "ready" : "noop";
  });
}

// ADR-121 (INV-1): cap-safe agent idle-resume claim, shared by the hook_trip
// (claimAndResumeAgentRun) and budget-raise (scheduleBudgetBreachResume) wakes —
// the same D2 over-cap bypass T14 closed on the permission idle-resume path
// (resumeRun / the NeedsInputIdle permission branch below). A run in NeedsInput
// still HOLDS its agent slot, so it flips to Running directly (slot-neutral); a
// checkpointed NeedsInputIdle run FREED its slot, so at cap it DEFERS — stamps
// resume_requested_at (the C3 FIFO key) and leaves the run NeedsInputIdle for the
// unified admission gate to admit cap-safely on the next freed agent slot. The
// lock + count + flip share ONE transaction so two concurrent wakes cannot both
// observe the same free slot and both claim (the residual burst race). The CAS is
// still the serialization point: "noop" means the run already advanced (a prior
// resume won or it moved terminal), so a same-payload retry never double-spawns.
export async function claimAgentResumeSlot(
  db: any,
  runId: string,
): Promise<"claimed" | "queued" | "noop"> {
  return db.transaction(async (tx: any) => {
    await takeSchedulerLock(tx);

    const [cur]: Array<{ status: string }> = await tx
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId));

    if (!cur) return "noop" as const;

    // NeedsInput holds the slot — flip directly, no cap gate needed.
    if (cur.status === "NeedsInput") {
      const flipped = await tx
        .update(runs)
        .set({ status: "Running", keepaliveUntil: null, checkpointAt: null })
        .where(and(eq(runs.id, runId), eq(runs.status, "NeedsInput")))
        .returning({ id: runs.id });

      return flipped.length > 0 ? ("claimed" as const) : ("noop" as const);
    }

    // NeedsInputIdle freed the slot — cap-gate the reclaim (INV-1).
    if (cur.status === "NeedsInputIdle") {
      if ((await countLiveRuns(tx, "agent")) >= capForPool("agent")) {
        await tx
          .update(runs)
          .set({ resumeRequestedAt: new Date() })
          .where(and(eq(runs.id, runId), eq(runs.status, "NeedsInputIdle")));

        return "queued" as const;
      }

      const flipped = await tx
        .update(runs)
        .set({
          status: "Running",
          resumeRequestedAt: null,
          keepaliveUntil: null,
          checkpointAt: null,
        })
        .where(and(eq(runs.id, runId), eq(runs.status, "NeedsInputIdle")))
        .returning({ id: runs.id });

      return flipped.length > 0 ? ("claimed" as const) : ("noop" as const);
    }

    return "noop" as const;
  });
}

// ADR-108 (M40): idempotent agent hook_trip resume claim. The agent run is left
// NeedsInput|NeedsInputIdle through the response tx; the claim happens HERE, off
// the response path (the runner — not the response tx — owns the transition,
// mirroring runFlow for a flow run). Cap-safe via claimAgentResumeSlot (ADR-121
// INV-1): at cap a checkpointed run defers to the C3 admission gate instead of
// bypassing the agent pool cap. Called from BOTH the first-success path and the
// already-delivered retry so a process restart between the respondedAt commit and
// the original claim cannot strand the run. The post-claim crash window (Running,
// no live session yet) is recovered by the crash-reconcile sweep, as for any run.
function claimAndResumeAgentRun(runId: string, db: any): void {
  void (async () => {
    const outcome = await claimAgentResumeSlot(db, runId);

    if (outcome === "queued") {
      log.info(
        { runId },
        "agent hook_trip resume — agent pool at cap; deferred (resume_requested_at stamped, gate will admit)",
      );

      return;
    }

    if (outcome === "noop") {
      log.debug(
        { runId },
        "agent hook_trip resume — run already advanced, no re-claim",
      );

      return;
    }

    const { startAgentSession } = await import("@/lib/agents/launch");

    await startAgentSession(runId, { db });
  })().catch((err: unknown) =>
    log.error(
      { runId, err: err instanceof Error ? err.message : String(err) },
      "agent hook_trip resume failed",
    ),
  );
}

// Wake a run after a budget raise (ADR-106 M39 Phase 5). The mechanism depends on
// run_kind + the PAUSED status, which the onBudgetBreach disposition chose:
// `escalate` left the run in NeedsInput (slot held); `terminate_restorable` in
// NeedsInputIdle (checkpointed, slot freed). Both kept acp_session_id, so the
// resume restores context via session/resume.
//   - agent  → CAS NeedsInput|NeedsInputIdle → Running, then respawn the session.
//   - flow + NeedsInput     → runFlow (it claims NeedsInput→Running itself).
//   - flow + NeedsInputIdle → resumeRun (respawn) + the resume-driver.
async function scheduleBudgetBreachResume(args: {
  db: any;
  runId: string;
  runKind: string;
  stepId: string;
}): Promise<void> {
  const { db, runId, runKind, stepId } = args;

  if (runKind === "agent") {
    // ADR-121 (INV-1): cap-safe reclaim — at cap a checkpointed run defers to the
    // C3 admission gate instead of bypassing the agent pool cap.
    const outcome = await claimAgentResumeSlot(db, runId);

    if (outcome === "queued") {
      log.info(
        { runId },
        "agent budget-raise resume — agent pool at cap; deferred (resume_requested_at stamped, gate will admit)",
      );

      return;
    }

    if (outcome === "noop") return;
    const { startAgentSession } = await import("@/lib/agents/launch");

    queueMicrotask(() => {
      void startAgentSession(runId, { db }).catch((err: unknown) =>
        log.error(
          { runId, err: err instanceof Error ? err.message : String(err) },
          "agent budget-raise resume failed",
        ),
      );
    });

    return;
  }

  // flow: the paused status decides the resume path.
  const [cur] = await db
    .select({ status: runs.status })
    .from(runs)
    .where(eq(runs.id, runId));

  if (cur?.status === "NeedsInputIdle") {
    const { resumeRun } = await import("@/lib/runs/resume");
    const { scheduleResumedSessionDrive } = await import(
      "@/lib/runs/resume-driver"
    );
    const r = await resumeRun(runId, { db });

    if (r.ok) {
      scheduleResumedSessionDrive({
        runId,
        supervisorSessionId: r.newSupervisorSessionId,
        acpSessionId: r.acpSessionId,
        stepId,
      });
    }

    return;
  }

  // flow + NeedsInput (escalate): runFlow claims NeedsInput→Running.
  scheduleResume(runId);
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

function assignmentResponsePayload(
  hitlSchema: unknown,
  response: unknown,
): Record<string, unknown> {
  if (
    isConsensusResolutionSchema(hitlSchema) &&
    response &&
    typeof response === "object" &&
    !Array.isArray(response)
  ) {
    const r = response as Record<string, unknown>;

    return {
      response: {
        decision: r.decision,
        resolutionPresent:
          typeof r.resolution === "string" && r.resolution.length > 0,
      },
    };
  }

  return { response: response as Record<string, unknown> };
}

export type HitlActor =
  | {
      kind: "user";
      userId: string;
      label: string;
      preauthorizedProjectId?: string | null;
    }
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
  // The route preserves raw top-level keys because Zod's default object parser
  // strips unknown fields before the kind-specific decision contract can reject
  // them. Direct service callers omit it and use the typed body keys instead.
  bodyKeys?: readonly string[];
  body: {
    optionId?: string;
    response?: unknown;
    // M17 ADR-054: responder self-reported confidence in [0,1].
    confidence?: unknown;
    // Cost-budget governance: the raised token ceiling for a budget_breach
    // raise (validated fail-closed at the sink). May also ride `response`.
    raiseTo?: unknown;
    // ADR-125: tolerant top-level alias for response.dropWorkspace on abandon.
    dropWorkspace?: unknown;
  };
};

type HandlerArgs = {
  db: any;
  hitlRow: any;
  runRow: any;
  bodyKeys: readonly string[];
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
      // ADR-121 (T14, G4): cap-gate the agent idle-resume claim atomically (closes
      // the D2 over-cap bypass on the agent pool too). Under the scheduler lock,
      // count the agent pool; if at cap, DEFER — stamp resume_requested_at (the C3
      // FIFO key) and leave the run NeedsInputIdle for the gate to admit on a freed
      // slot. NeedsInputIdle is not counted; the claim flips it to Running
      // (counted), so live < cap before ⇒ live + 1 ≤ cap after.
      const claimed = await db.transaction(async (tx: any) => {
        await takeSchedulerLock(tx);
        const live = await countLiveRuns(tx, "agent");

        if (live >= capForPool("agent")) {
          await tx
            .update(runs)
            .set({ resumeRequestedAt: new Date() })
            .where(and(eq(runs.id, runId), eq(runs.status, "NeedsInputIdle")));
          await args.recordSuccessAudit?.(tx, 202);

          return "queued" as const;
        }

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

      if (claimed === "queued") {
        log.info(
          {
            runId,
            hitlRequestId,
            branch: "agent-idle",
            phase: "resume-queued",
            latencyMs: Date.now() - startedAt,
          },
          "permission stored; agent pool at cap — resume queued for the next free slot",
        );

        return NextResponse.json(
          {
            ok: true,
            runStatus: "NeedsInputIdle",
            state: "resume-in-progress",
          },
          { status: 202 },
        );
      }

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

    // ADR-121 (T14, G4): the flow pool is at cap — resumeRun deferred the resume
    // (stamped resume_requested_at). The response is stored; the unified admission
    // gate (C3) admits this run cap-safely on the next freed slot. Return 202 so
    // the UI keeps "resume in progress" exactly as for the spawned path.
    if (r.code === "QUEUED") {
      log.info(
        {
          runId,
          hitlRequestId,
          branch: "idle",
          phase: "resume-queued",
          latencyMs: Date.now() - startedAt,
        },
        "permission stored; flow pool at cap — resume queued for the next free slot",
      );

      await recordSuccessAuditInTransaction(args, 202);

      return NextResponse.json(
        {
          ok: true,
          runStatus: "NeedsInputIdle",
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

        if (terminalRows.length > 0) {
          await syncExperimentStatusForRun({ db: tx, runId });
        }

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
      await captureExperimentDiffSnapshotForRun({ db, runId, force: true });

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

type PlanReviewParentState = {
  sourceArtifactId: string;
  answersVar: string;
  decisions: Array<{ id: string }>;
  assumptions: Array<{
    id: string;
    defaultDecision: { id: string; label: string };
  }>;
};

function planReviewParentState(schema: unknown): PlanReviewParentState | null {
  if (!schema || typeof schema !== "object") return null;
  const planReview = (schema as { planReview?: unknown }).planReview;

  if (!planReview || typeof planReview !== "object") return null;
  const value = planReview as Record<string, unknown>;

  if (
    typeof value.sourceArtifactId !== "string" ||
    typeof value.answersVar !== "string" ||
    !Array.isArray(value.decisions) ||
    !Array.isArray(value.assumptions)
  ) {
    return null;
  }

  const decisions = value.decisions
    .map((decision) => {
      if (!decision || typeof decision !== "object") return null;
      const id = (decision as { id?: unknown }).id;

      return typeof id === "string" ? { id } : null;
    })
    .filter((decision): decision is { id: string } => decision !== null);
  const assumptions = value.assumptions
    .map((assumption) => {
      if (!assumption || typeof assumption !== "object") return null;
      const record = assumption as {
        id?: unknown;
        defaultDecision?: { id?: unknown; label?: unknown };
      };

      if (
        typeof record.id !== "string" ||
        typeof record.defaultDecision?.id !== "string" ||
        typeof record.defaultDecision.label !== "string"
      ) {
        return null;
      }

      return {
        id: record.id,
        defaultDecision: {
          id: record.defaultDecision.id,
          label: record.defaultDecision.label,
        },
      };
    })
    .filter(
      (
        assumption,
      ): assumption is {
        id: string;
        defaultDecision: { id: string; label: string };
      } => assumption !== null,
    );

  if (
    decisions.length !== value.decisions.length ||
    assumptions.length !== value.assumptions.length
  ) {
    return null;
  }

  return {
    sourceArtifactId: value.sourceArtifactId,
    answersVar: value.answersVar,
    decisions,
    assumptions,
  };
}

function planReviewCommentsVar(schema: unknown): string | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  const value = (schema as { commentsVar?: unknown }).commentsVar;

  return typeof value === "string" ? value : undefined;
}

function planReviewParentInput({
  decision,
  workspacePolicy,
  comments,
  commentsVar,
  answersVar,
  sourceArtifactId,
  answers,
  assumptions,
}: {
  decision: "approve" | "rework";
  workspacePolicy: string;
  comments: string;
  commentsVar?: string;
  answersVar: string;
  sourceArtifactId: string;
  answers: Array<{ decisionId: string; optionId: string }>;
  assumptions: Array<{
    id: string;
    defaultDecision: { id: string; label: string };
  }>;
}): Record<string, unknown> {
  const answerEnvelope = {
    schemaVersion: 1,
    sourceArtifactId,
    answers,
  };

  return {
    decision,
    workspacePolicy,
    comments,
    ...(commentsVar ? { [commentsVar]: comments } : {}),
    [answersVar]: answerEnvelope,
    ...(decision === "approve"
      ? {
          acceptedAssumptions: assumptions.map((assumption) => ({
            assumptionId: assumption.id,
            defaultDecision: assumption.defaultDecision,
          })),
        }
      : {}),
  };
}

async function planReviewInputPath(
  db: any,
  projectId: string,
  runId: string,
  stepId: string,
): Promise<string> {
  const projectRows = await db
    .select({ slug: projects.slug })
    .from(projects)
    .where(eq(projects.id, projectId));
  const projectSlug = projectRows[0]?.slug;

  if (!projectSlug) {
    throw new MaisterError("PRECONDITION", "project slug not found");
  }

  return path.join(
    runtimeRoot(),
    ".maister",
    projectSlug,
    "runs",
    runId,
    `input-${stepId}.json`,
  );
}

async function assertCurrentPlanReviewArtifact(
  tx: any,
  sourceArtifactId: string,
  runId: string,
): Promise<void> {
  const [artifact] = await tx
    .select({
      id: artifactInstances.id,
      runId: artifactInstances.runId,
      validity: artifactInstances.validity,
    })
    .from(artifactInstances)
    .where(eq(artifactInstances.id, sourceArtifactId));

  if (
    !artifact ||
    artifact.runId !== runId ||
    artifact.validity !== "current"
  ) {
    throw new MaisterError(
      "CONFLICT",
      "plan review artifact is no longer current; open the replacement review",
    );
  }
}

function decisionAnswerFromResponse(
  response: unknown,
): { optionId: string } | null {
  if (!response || typeof response !== "object") return null;
  const optionId = (response as { optionId?: unknown }).optionId;

  return typeof optionId === "string" ? { optionId } : null;
}

async function completePlanReviewResponse(args: {
  db: any;
  runId: string;
  projectId: string;
  parentHitlRequestId: string;
  childHitlRequestId?: string;
  parentAssignmentClaim?: ResponseAssignmentClaim;
  childAssignmentClaim?: ResponseAssignmentClaim;
  recordSuccessAudit?: (db: any, statusCode: number) => Promise<void>;
}): Promise<void> {
  await args.db.transaction(async (tx: any) => {
    const now = new Date();

    if (args.childHitlRequestId) {
      await tx
        .update(hitlRequests)
        .set({ respondedAt: now })
        .where(
          and(
            eq(hitlRequests.id, args.childHitlRequestId),
            isNull(hitlRequests.respondedAt),
          ),
        );
      await completeResponseAssignment(tx, args.childAssignmentClaim ?? null);
    }

    const stamped = await tx
      .update(hitlRequests)
      .set({ respondedAt: now })
      .where(
        and(
          eq(hitlRequests.id, args.parentHitlRequestId),
          isNull(hitlRequests.respondedAt),
        ),
      )
      .returning({ id: hitlRequests.id });

    await completeResponseAssignment(tx, args.parentAssignmentClaim ?? null);
    await systemCloseActiveAssignmentsForHitlRequest({
      db: tx,
      hitlRequestId: args.parentHitlRequestId,
      projectId: args.projectId,
      reason: "plan-review rework delivered",
    });
    await args.recordSuccessAudit?.(tx, 202);

    if (stamped.length > 0) {
      await emitWebhookEvent({
        db: tx,
        type: "hitl.responded",
        projectId: args.projectId,
        runId: args.runId,
        data: {
          hitlRequestId: args.parentHitlRequestId,
          kind: "human",
          via: "user",
          planReview: {
            parentHitlRequestId: args.parentHitlRequestId,
            state: "rework-scheduled",
          },
        },
      });
    }
  });
}

type PlanReviewHandoff =
  | { kind: "not-ready" }
  | {
      kind: "already-delivered";
      runId: string;
    }
  | {
      kind: "pending-delivery";
      childHitlRequestIds: string[];
      parentDecision: "approve" | "rework";
      parentHitlRequestId: string;
      parentResponse: unknown;
      parentStepId: string;
      projectId: string;
      runId: string;
    };

async function loadPlanReviewHandoff(
  db: any,
  parentHitlRequestId: string,
): Promise<PlanReviewHandoff> {
  return db.transaction(async (tx: any) => {
    const parent = await lockPlanReviewParent(tx, parentHitlRequestId);

    if (
      !parent ||
      parent.kind !== "human" ||
      parent.response === null ||
      parent.response === undefined
    ) {
      return { kind: "not-ready" as const };
    }
    const parentState = planReviewParentState(parent.schema);

    if (!parentState) return { kind: "not-ready" as const };

    const runRows = await tx
      .select({
        currentStepId: runs.currentStepId,
        projectId: runs.projectId,
        status: runs.status,
      })
      .from(runs)
      .where(eq(runs.id, parent.runId))
      .for("update");
    const run = runRows[0];

    if (
      !run ||
      run.projectId === null ||
      run.currentStepId !== parent.stepId ||
      !PENDING_HITL_RUN_STATUS.has(run.status)
    ) {
      return { kind: "not-ready" as const };
    }

    await assertCurrentPlanReviewArtifact(
      tx,
      parentState.sourceArtifactId,
      parent.runId,
    );

    if (parent.respondedAt) {
      return { kind: "already-delivered" as const, runId: parent.runId };
    }

    const children = await tx
      .select({
        id: hitlRequests.id,
        kind: hitlRequests.kind,
        respondedAt: hitlRequests.respondedAt,
        response: hitlRequests.response,
      })
      .from(hitlRequests)
      .where(eq(hitlRequests.parentHitlRequestId, parent.id))
      .orderBy(asc(hitlRequests.id))
      .for("update");
    const childHitlRequestIds = children
      .filter(
        (child: {
          id: string;
          kind: string;
          respondedAt: Date | null;
          response: unknown;
        }) =>
          child.kind === "decision_request" &&
          child.respondedAt === null &&
          decisionAnswerFromResponse(child.response) !== null,
      )
      .map((child: { id: string }) => child.id);

    return {
      kind: "pending-delivery" as const,
      childHitlRequestIds,
      parentDecision: parent.decision === "approve" ? "approve" : "rework",
      parentHitlRequestId: parent.id,
      parentResponse: parent.response,
      parentStepId: parent.stepId,
      projectId: run.projectId,
      runId: parent.runId,
    };
  });
}

async function completeRecoveredPlanReviewHandoff(
  args: Extract<PlanReviewHandoff, { kind: "pending-delivery" }> & {
    db: any;
  },
): Promise<boolean> {
  return args.db.transaction(async (tx: any) => {
    const now = new Date();

    if (args.childHitlRequestIds.length > 0) {
      await tx
        .update(hitlRequests)
        .set({ respondedAt: now })
        .where(
          and(
            inArray(hitlRequests.id, args.childHitlRequestIds),
            isNull(hitlRequests.respondedAt),
          ),
        );

      for (const hitlRequestId of args.childHitlRequestIds) {
        await systemCloseActiveAssignmentsForHitlRequest({
          db: tx,
          hitlRequestId,
          projectId: args.projectId,
          reason: "plan-review response recovered after restart",
        });
      }
    }

    const stamped = await tx
      .update(hitlRequests)
      .set({ respondedAt: now })
      .where(
        and(
          eq(hitlRequests.id, args.parentHitlRequestId),
          isNull(hitlRequests.respondedAt),
        ),
      )
      .returning({ id: hitlRequests.id });

    if (stamped.length === 0) return false;

    await systemCloseActiveAssignmentsForHitlRequest({
      db: tx,
      hitlRequestId: args.parentHitlRequestId,
      projectId: args.projectId,
      reason: "plan-review response recovered after restart",
    });
    await emitWebhookEvent({
      db: tx,
      type: "hitl.responded",
      projectId: args.projectId,
      runId: args.runId,
      data: {
        hitlRequestId: args.parentHitlRequestId,
        kind: "human",
        via: "reconciliation",
        planReview: {
          parentHitlRequestId: args.parentHitlRequestId,
          state:
            args.parentDecision === "approve" ? "approved" : "rework-scheduled",
        },
      },
    });

    return true;
  });
}

export async function reconcilePlanReviewDecisionHandoffs(args: {
  db: any;
  limit?: number;
}): Promise<number> {
  const candidates = await args.db
    .select({ id: hitlRequests.id })
    .from(hitlRequests)
    .innerJoin(runs, eq(runs.id, hitlRequests.runId))
    .innerJoin(
      artifactInstances,
      sql`${artifactInstances.id} = ${hitlRequests.schema} -> 'planReview' ->> 'sourceArtifactId'`,
    )
    .where(
      and(
        eq(hitlRequests.kind, "human"),
        isNotNull(hitlRequests.response),
        inArray(runs.status, Array.from(PENDING_HITL_RUN_STATUS)),
        eq(runs.currentStepId, hitlRequests.stepId),
        sql`${hitlRequests.schema} @> '{"planReview": {}}'::jsonb`,
        eq(artifactInstances.runId, runs.id),
        eq(artifactInstances.validity, "current"),
      ),
    )
    .orderBy(asc(hitlRequests.createdAt), asc(hitlRequests.id))
    .limit(args.limit ?? 50);
  let resumed = 0;

  for (const candidate of candidates) {
    try {
      const handoff = await loadPlanReviewHandoff(args.db, candidate.id);

      if (handoff.kind === "not-ready") continue;

      if (handoff.kind === "pending-delivery") {
        const inputPath = await planReviewInputPath(
          args.db,
          handoff.projectId,
          handoff.runId,
          handoff.parentStepId,
        );

        await atomicWriteJson(inputPath, handoff.parentResponse);

        const delivered = await completeRecoveredPlanReviewHandoff({
          ...handoff,
          db: args.db,
        });

        if (!delivered) continue;
      }

      const resume = await claimGraphResumeSlot(args.db, handoff.runId);

      if (resume === "ready") scheduleResume(handoff.runId);
      if (resume !== "noop") resumed += 1;

      log.info(
        {
          runId: handoff.runId,
          parentHitlRequestId: candidate.id,
          resume,
        },
        "[FIX:plan-review-handoff] reconciled durable response",
      );
    } catch (err) {
      log.warn(
        {
          parentHitlRequestId: candidate.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "[FIX:plan-review-handoff] reconciliation failed; retaining intent for retry",
      );
    }
  }

  return resumed;
}

async function handlePlanReviewDecisionResponse(
  args: HandlerArgs,
): Promise<NextResponse> {
  const { db, hitlRow, runRow, body, bodyKeys, runId, hitlRequestId, actor } =
    args;
  const optionId = body.optionId;
  const parentHitlRequestId = hitlRow.parentHitlRequestId;

  if (
    bodyKeys.length !== 1 ||
    bodyKeys[0] !== "optionId" ||
    typeof optionId !== "string" ||
    body.response !== undefined ||
    body.confidence !== undefined ||
    body.raiseTo !== undefined ||
    body.dropWorkspace !== undefined
  ) {
    throw new MaisterError(
      "CONFIG",
      "decision_request requires exactly an optionId response",
    );
  }

  const childSchema = isPlanReviewDecisionRequestSchema(hitlRow.schema)
    ? hitlRow.schema
    : null;

  if (
    !childSchema ||
    !childSchema.options.some(
      (option: { id: string }) => option.id === optionId,
    )
  ) {
    throw new MaisterError(
      "NEEDS_INPUT",
      "optionId is not declared by this plan decision",
    );
  }
  if (typeof parentHitlRequestId !== "string") {
    throw new MaisterError(
      "PRECONDITION",
      "plan decision request has no parent review",
    );
  }

  const assignmentClaim = await claimAssignmentForResponse({
    db,
    hitlRequestId,
    projectId: runRow.projectId,
    actor,
  });
  const response = { optionId };
  const outcome = await db.transaction(async (tx: any) => {
    // Serialize child answers through the common parent before taking any
    // child-row locks. The transaction-scoped advisory key prevents a
    // child-assignment claim from inverting this lock order.
    const parent = await lockPlanReviewParent(tx, parentHitlRequestId);
    const child = await lockHitlRow(tx, hitlRequestId);

    if (
      !child ||
      child.kind !== "decision_request" ||
      child.parentHitlRequestId !== parentHitlRequestId
    ) {
      throw new MaisterError(
        "PRECONDITION",
        "plan decision request disappeared",
      );
    }
    if (!parent || parent.kind !== "human" || parent.runId !== runId) {
      throw new MaisterError("CONFLICT", "plan decision parent is invalid");
    }
    const parentState = planReviewParentState(parent.schema);

    if (
      !parentState ||
      parentState.sourceArtifactId !== child.sourceArtifactId
    ) {
      throw new MaisterError(
        "CONFLICT",
        "plan decision parent provenance changed",
      );
    }
    await assertCurrentPlanReviewArtifact(
      tx,
      parentState.sourceArtifactId,
      runId,
    );

    const runRows = await tx
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId))
      .for("update");
    const lockedRun = runRows[0];

    if (!lockedRun || !PENDING_HITL_RUN_STATUS.has(lockedRun.status)) {
      throw new MaisterError("CONFLICT", "run is not awaiting plan decisions");
    }
    if (child.respondedAt) {
      if (payloadsEqual(child.response, response)) {
        if (parent.respondedAt) {
          return {
            kind: "already-delivered" as const,
            parentHitlRequestId: parent.id,
          };
        }
      } else {
        throw new MaisterError("CONFLICT", "plan decision already answered");
      }
    }
    if (parent.respondedAt) {
      throw new MaisterError("CONFLICT", "parent review is already closed");
    }
    if (child.response !== null && child.response !== undefined) {
      if (!payloadsEqual(child.response, response)) {
        throw new MaisterError("CONFLICT", "plan decision answer conflicts");
      }
    } else {
      await tx
        .update(hitlRequests)
        .set({ response })
        .where(
          and(
            eq(hitlRequests.id, child.id),
            isNull(hitlRequests.respondedAt),
            isNull(hitlRequests.response),
          ),
        );
    }

    const siblings = await tx
      .select()
      .from(hitlRequests)
      .where(eq(hitlRequests.parentHitlRequestId, parent.id))
      .orderBy(asc(hitlRequests.id))
      .for("update");
    const answers = new Map<string, string>();

    for (const sibling of siblings) {
      const siblingAnswer =
        sibling.id === child.id
          ? response
          : decisionAnswerFromResponse(sibling.response);

      if (siblingAnswer)
        answers.set(sibling.decisionId, siblingAnswer.optionId);
    }

    const remaining = parentState.decisions.filter(
      (decision) => !answers.has(decision.id),
    );

    if (remaining.length > 0) {
      if (parent.response !== null && parent.response !== undefined) {
        throw new MaisterError("CONFLICT", "parent review is closing");
      }

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

      if (stamped.length > 0) {
        await completeResponseAssignment(tx, assignmentClaim, { response });
        await args.recordSuccessAudit?.(tx, 200);
        await emitWebhookEvent({
          db: tx,
          type: "hitl.responded",
          projectId: runRow.projectId,
          runId,
          data: {
            hitlRequestId,
            kind: "decision_request",
            via: "user",
            planReview: {
              parentHitlRequestId: parent.id,
              sourceArtifactId: childSchema.sourceArtifactId,
              decisionId: childSchema.decisionId,
              remainingDecisionCount: remaining.length,
              state: "awaiting-decisions",
            },
          },
        });
      }

      return {
        kind: "awaiting-decisions" as const,
        remainingDecisionCount: remaining.length,
        parentHitlRequestId: parent.id,
      };
    }

    const orderedAnswers = parentState.decisions.map((decision) => ({
      decisionId: decision.id,
      optionId: answers.get(decision.id)!,
    }));
    const parentResponse = planReviewParentInput({
      decision: "rework",
      workspacePolicy: "keep",
      comments: "",
      commentsVar: planReviewCommentsVar(parent.schema),
      answersVar: parentState.answersVar,
      sourceArtifactId: parentState.sourceArtifactId,
      answers: orderedAnswers,
      assumptions: parentState.assumptions,
    });

    if (parent.response !== null && parent.response !== undefined) {
      if (!payloadsEqual(parent.response, parentResponse)) {
        throw new MaisterError("CONFLICT", "parent review is closing");
      }
    } else {
      await tx
        .update(hitlRequests)
        .set({
          response: parentResponse,
          decision: "rework",
          workspacePolicy: "keep",
        })
        .where(
          and(
            eq(hitlRequests.id, parent.id),
            isNull(hitlRequests.respondedAt),
            isNull(hitlRequests.response),
          ),
        );
    }

    return {
      kind: "rework-pending" as const,
      parentHitlRequestId: parent.id,
      parentStepId: parent.stepId,
      parentResponse,
    };
  });

  if (outcome.kind === "already-delivered") {
    const resume = await claimGraphResumeSlot(db, runId);

    if (resume === "ready") scheduleResume(runId);

    return NextResponse.json(
      {
        ok: true,
        state: resume === "queued" ? "resume-queued" : "rework-scheduled",
        remainingDecisionCount: 0,
      },
      { status: 202 },
    );
  }

  if (outcome.kind === "awaiting-decisions") {
    return NextResponse.json(
      {
        ok: true,
        state: "awaiting-decisions",
        remainingDecisionCount: outcome.remainingDecisionCount,
      },
      { status: 200 },
    );
  }

  const inputPath = await planReviewInputPath(
    db,
    runRow.projectId,
    runId,
    outcome.parentStepId,
  );

  try {
    await atomicWriteJson(inputPath, outcome.parentResponse);
  } catch (err) {
    log.warn(
      {
        runId,
        hitlRequestId,
        err: err instanceof Error ? err.message : String(err),
      },
      "plan-review final answer input write failed — retryable",
    );

    return NextResponse.json(
      {
        code: "EXECUTOR_UNAVAILABLE",
        message: "could not persist plan-review input; retry",
      },
      { status: 503 },
    );
  }

  await completePlanReviewResponse({
    db,
    runId,
    projectId: runRow.projectId,
    parentHitlRequestId: outcome.parentHitlRequestId,
    childHitlRequestId: hitlRequestId,
    childAssignmentClaim: assignmentClaim,
    recordSuccessAudit: args.recordSuccessAudit,
  });
  const resume = await claimGraphResumeSlot(db, runId);

  if (resume === "ready") scheduleResume(runId);

  return NextResponse.json(
    {
      ok: true,
      state: resume === "queued" ? "resume-queued" : "rework-scheduled",
      remainingDecisionCount: 0,
    },
    { status: 202 },
  );
}

async function handlePlanReviewParentResponse(
  args: HandlerArgs,
): Promise<NextResponse> {
  const { db, hitlRow, runRow, body, runId, hitlRequestId, actor } = args;
  const parentState = planReviewParentState(hitlRow.schema);

  if (!parentState) {
    throw new MaisterError("CONFIG", "plan-review parent schema is malformed");
  }
  if (body.response === undefined) {
    throw new MaisterError("CONFIG", "plan-review response is required");
  }

  const resolved = assertReviewDecision(body.response, hitlRow.schema);

  if (resolved.decision !== "approve" && resolved.decision !== "rework") {
    throw new MaisterError(
      "NEEDS_INPUT",
      "plan-review requires approve or rework",
    );
  }
  const planDecision: "approve" | "rework" = resolved.decision;

  const submitted = body.response as { comments?: unknown };
  const comments =
    typeof submitted.comments === "string" ? submitted.comments : "";
  const assignmentClaim = await claimAssignmentForResponse({
    db,
    hitlRequestId,
    projectId: runRow.projectId,
    actor,
  });
  const phaseOne = await db.transaction(async (tx: any) => {
    const parent = await lockPlanReviewParent(tx, hitlRequestId);

    if (!parent || parent.kind !== "human") {
      throw new MaisterError("PRECONDITION", "plan-review parent disappeared");
    }
    const lockedState = planReviewParentState(parent.schema);

    if (!lockedState) {
      throw new MaisterError("CONFLICT", "plan-review parent contract changed");
    }
    await assertCurrentPlanReviewArtifact(
      tx,
      lockedState.sourceArtifactId,
      runId,
    );

    const runRows = await tx
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId))
      .for("update");
    const lockedRun = runRows[0];

    if (!lockedRun || !PENDING_HITL_RUN_STATUS.has(lockedRun.status)) {
      throw new MaisterError("CONFLICT", "run is not awaiting plan review");
    }
    const siblings = await tx
      .select()
      .from(hitlRequests)
      .where(eq(hitlRequests.parentHitlRequestId, parent.id))
      .orderBy(asc(hitlRequests.id))
      .for("update");
    const openChildren = siblings.filter(
      (child: { respondedAt: Date | null }) => child.respondedAt === null,
    );

    if (parent.respondedAt) {
      return { kind: "already-delivered" as const, parent };
    }
    if (planDecision === "approve" && openChildren.length > 0) {
      throw new MaisterError(
        "PRECONDITION",
        "all blocking plan decisions must be answered before approval",
      );
    }

    const answers = new Map<string, string>();

    for (const child of siblings) {
      const answer = decisionAnswerFromResponse(child.response);

      if (answer) answers.set(child.decisionId, answer.optionId);
    }
    const orderedAnswers = lockedState.decisions
      .map((decision) => {
        const optionId = answers.get(decision.id);

        return optionId ? { decisionId: decision.id, optionId } : null;
      })
      .filter(
        (answer): answer is { decisionId: string; optionId: string } =>
          answer !== null,
      );
    const parentResponse = planReviewParentInput({
      decision: planDecision,
      workspacePolicy: resolved.workspacePolicy ?? "keep",
      comments,
      commentsVar: planReviewCommentsVar(parent.schema),
      answersVar: lockedState.answersVar,
      sourceArtifactId: lockedState.sourceArtifactId,
      answers: orderedAnswers,
      assumptions: lockedState.assumptions,
    });

    if (parent.response !== null && parent.response !== undefined) {
      if (!payloadsEqual(parent.response, parentResponse)) {
        throw new MaisterError(
          "CONFLICT",
          "plan-review response is already pending delivery",
        );
      }

      return {
        kind: "pending-delivery" as const,
        parent,
        parentResponse,
        closedChildCount: 0,
      };
    }

    if (planDecision === "rework") {
      const now = new Date();

      for (const child of openChildren) {
        await tx
          .update(hitlRequests)
          .set({
            response: {
              kind: "parent_reworked",
              parentHitlRequestId: parent.id,
            },
            respondedAt: now,
          })
          .where(
            and(
              eq(hitlRequests.id, child.id),
              isNull(hitlRequests.respondedAt),
            ),
          );
        await systemCloseActiveAssignmentsForHitlRequest({
          db: tx,
          hitlRequestId: child.id,
          projectId: runRow.projectId,
          reason: "parent review reworked",
        });
      }
    }

    await tx
      .update(hitlRequests)
      .set({
        response: parentResponse,
        decision: planDecision,
        workspacePolicy: resolved.workspacePolicy ?? "keep",
        reworkTarget: resolved.reworkTarget ?? null,
      })
      .where(
        and(
          eq(hitlRequests.id, parent.id),
          isNull(hitlRequests.respondedAt),
          isNull(hitlRequests.response),
        ),
      );

    return {
      kind: "pending-delivery" as const,
      parent,
      parentResponse,
      closedChildCount: planDecision === "rework" ? openChildren.length : 0,
    };
  });

  if (phaseOne.kind === "already-delivered") {
    const resume = await claimGraphResumeSlot(db, runId);

    if (resume === "ready") scheduleResume(runId);

    return NextResponse.json(
      { ok: true, runStatus: "NeedsInput" },
      { status: 200 },
    );
  }

  const inputPath = await planReviewInputPath(
    db,
    runRow.projectId,
    runId,
    phaseOne.parent.stepId,
  );

  try {
    await atomicWriteJson(inputPath, phaseOne.parentResponse);
  } catch (err) {
    log.warn(
      {
        runId,
        hitlRequestId,
        err: err instanceof Error ? err.message : String(err),
      },
      "plan-review parent input write failed — retryable",
    );

    return NextResponse.json(
      {
        code: "EXECUTOR_UNAVAILABLE",
        message: "could not persist plan-review input; retry",
      },
      { status: 503 },
    );
  }

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

    await completeResponseAssignment(tx, assignmentClaim);
    await args.recordSuccessAudit?.(tx, 200);

    if (stamped.length > 0) {
      await emitWebhookEvent({
        db: tx,
        type: "hitl.responded",
        projectId: runRow.projectId,
        runId,
        data: {
          hitlRequestId,
          kind: "human",
          via: "user",
          planReview: {
            parentHitlRequestId: hitlRequestId,
            remainingDecisionCount: 0,
            state: planDecision === "rework" ? "rework-scheduled" : "approved",
          },
        },
      });
    }
  });

  const resume = await claimGraphResumeSlot(db, runId);

  if (resume === "ready") scheduleResume(runId);

  log.info(
    {
      runId,
      hitlRequestId,
      decision: planDecision,
      closedChildCount: phaseOne.closedChildCount,
      resume,
    },
    "plan-review parent response delivered",
  );

  return NextResponse.json(
    { ok: true, runStatus: "NeedsInput" },
    { status: 200 },
  );
}

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
  let canonicalResponse: unknown | null = null;

  if (isConsensusResolutionSchema(hitlRow.schema)) {
    const response = body.response;

    if (response === undefined) {
      throw new MaisterError(
        "CONFIG",
        `response is required for kind=${hitlRow.kind}`,
      );
    }
    const resolved = assertConsensusDecision(response, hitlRow.schema);

    canonicalResponse = resolved.response;
    reviewFields = {
      decision: resolved.decision,
      workspacePolicy: null,
      reworkTarget: null,
    };
  } else if (isReviewSchema(hitlRow.schema)) {
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
  const rawResponse: unknown = canonicalResponse ?? body.response;
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
      await completeResponseAssignment(
        tx,
        assignmentClaim,
        assignmentResponsePayload(hitlRow.schema, claim.storedResponse),
      );
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

    await completeResponseAssignment(
      tx,
      assignmentClaim,
      assignmentResponsePayload(hitlRow.schema, claim.storedResponse),
    );
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
      const [r] = await tx
        .select({ status: runs.status })
        .from(runs)
        .where(eq(runs.id, runId));

      return {
        transition: "already-delivered",
        runStatus: (r?.status as string | undefined) ?? runRow.status,
      } as const;
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

        await syncExperimentStatusForRun({ db: tx, runId });

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
    // Self-heal a lost post-commit scheduleResume (see respondToHookTripHitl):
    // a retry-resumed flow run left NeedsInput has no reconcile backstop, so the
    // same-payload retry re-queues the wake. Idempotent — runFlow's NeedsInput
    // resume gate no-ops if the run already advanced.
    if (outcome.runStatus === "NeedsInput") {
      scheduleResume(runId);
    }

    return NextResponse.json(
      { ok: true, runStatus: outcome.runStatus, idempotent: true },
      { status: 200 },
    );
  }

  if (outcome.transition === "abandoned") {
    await captureExperimentDiffSnapshotForRun({ db, runId, force: true });
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

type BudgetBreachSchema = {
  scope: BudgetBreachScope;
  meter: BudgetBreachMeter;
  limit: number;
};

async function loadBudgetBreachAvailabilityContext(args: {
  db: any;
  runRow: any;
  runId: string;
}): Promise<BudgetBreachAvailabilityContext> {
  const workspaceRows = await args.db
    .select({
      id: workspaces.id,
      removedAt: workspaces.removedAt,
    })
    .from(workspaces)
    .where(eq(workspaces.runId, args.runId));
  const workspace = workspaceRows[0] ?? null;

  return {
    runKind: args.runRow.runKind,
    status: args.runRow.status,
    taskId: args.runRow.taskId ?? null,
    flowId: args.runRow.flowId ?? null,
    agentId: args.runRow.agentId ?? null,
    parentRunId: args.runRow.parentRunId ?? null,
    agentWorkspace: args.runRow.agentWorkspace ?? null,
    hasOwnedWorkspace: workspace !== null && workspace.removedAt === null,
  };
}

function parseBudgetBreachSchema(schemaValue: unknown): BudgetBreachSchema {
  const value =
    schemaValue !== null && typeof schemaValue === "object"
      ? (schemaValue as Partial<BudgetBreachSchema>)
      : {};

  if (
    (value.scope !== "run" &&
      value.scope !== "task" &&
      value.scope !== "tree") ||
    (value.meter !== "tokens" &&
      value.meter !== "failures" &&
      value.meter !== "wallclock") ||
    typeof value.limit !== "number" ||
    !Number.isInteger(value.limit)
  ) {
    throw new MaisterError("CONFIG", "invalid budget_breach schema");
  }

  return {
    scope: value.scope,
    meter: value.meter,
    limit: value.limit,
  };
}

function stagedBudgetDecision(
  decision: BudgetBreachDecision,
  stage: BudgetBreachStagedDecision["stage"],
  extra: Partial<Pick<BudgetBreachStagedDecision, "ref" | "error">> = {},
): BudgetBreachStagedDecision {
  return { ...decision, stage, ...extra } as BudgetBreachStagedDecision;
}

async function setBudgetBreachStage(args: {
  db: any;
  hitlRequestId: string;
  decision: BudgetBreachDecision;
  stage: BudgetBreachStagedDecision["stage"];
  ref?: string;
  error?: string;
  respondedAt?: Date | null;
}): Promise<void> {
  await args.db
    .update(hitlRequests)
    .set({
      response: stagedBudgetDecision(args.decision, args.stage, {
        ...(args.ref ? { ref: args.ref } : {}),
        ...(args.error ? { error: args.error } : {}),
      }),
      respondedAt: args.respondedAt ?? null,
    })
    .where(eq(hitlRequests.id, args.hitlRequestId));
}

async function terminalizeBudgetRun(args: {
  tx: any;
  runId: string;
  reason: "budget_abandoned" | "budget_restart";
  assignmentReason: string;
}): Promise<{
  projectId: string | null;
  taskId: string | null;
  flowId: string | null;
  runKind: string;
  parentRunId: string | null;
} | null> {
  const terminal = await args.tx
    .update(runs)
    .set({ status: "Failed", endedAt: new Date() })
    .where(
      and(
        eq(runs.id, args.runId),
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
  const row = terminal[0] ?? null;

  if (row) {
    await syncExperimentStatusForRun({ db: args.tx, runId: args.runId });
  }

  if (row?.projectId) {
    await emitWebhookEvent({
      db: args.tx,
      type: "run.failed",
      projectId: row.projectId,
      runId: args.runId,
      data: { errorCode: "BUDGET_EXCEEDED", reason: args.reason },
    });
    await emitDomainEvent({
      db: args.tx,
      kind: "run.failed",
      projectId: row.projectId,
      runId: args.runId,
      taskId: row.taskId,
      actor: { type: "system", id: null },
      parentRunId: row.parentRunId,
      payload: {
        runId: args.runId,
        taskId: row.taskId,
        flowId: row.flowId,
        runKind: row.runKind,
        errorCode: "BUDGET_EXCEEDED",
        reason: args.reason,
      },
    });
  }

  await systemCloseActiveAssignmentsForRun({
    db: args.tx,
    runId: args.runId,
    reason: args.assignmentReason,
  });

  return row;
}

async function markBudgetParkedRun(args: {
  db: any;
  runId: string;
  ref: string | null;
}): Promise<"Abandoned"> {
  let changed = false;

  await args.db.transaction(async (tx: any) => {
    const endedAt = new Date();
    const updated = await tx
      .update(runs)
      .set({
        status: "Abandoned",
        currentStepId: null,
        endedAt,
      })
      .where(
        and(
          eq(runs.id, args.runId),
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
    const row = updated[0] ?? null;

    if (!row) {
      const existing = await tx
        .select({ status: runs.status })
        .from(runs)
        .where(eq(runs.id, args.runId));

      if (existing[0]?.status === "Abandoned") return;

      throw new MaisterError(
        "CONFLICT",
        `run ${args.runId} was not park-terminalizable after preservation`,
      );
    }

    changed = true;
    await syncExperimentStatusForRun({ db: tx, runId: args.runId });

    if (row.projectId) {
      await emitWebhookEvent({
        db: tx,
        type: "run.abandoned",
        projectId: row.projectId,
        runId: args.runId,
        data: {
          source: "budget_breach",
          reason: "budget_parked",
          ref: args.ref,
        },
      });
      await emitDomainEvent({
        db: tx,
        kind: "run.abandoned",
        projectId: row.projectId,
        runId: args.runId,
        taskId: row.taskId,
        actor: { type: "system", id: null },
        parentRunId: row.parentRunId,
        payload: {
          runId: args.runId,
          taskId: row.taskId,
          flowId: row.flowId,
          runKind: row.runKind,
          reason: "budget_parked",
          ref: args.ref,
        },
      });
    }

    await systemCloseActiveAssignmentsForRun({
      db: tx,
      runId: args.runId,
      reason: "budget breach parked",
    });
  });

  if (changed) {
    await captureExperimentDiffSnapshotForRun({
      db: args.db,
      runId: args.runId,
      force: true,
    });
  }

  return "Abandoned";
}

async function loadBudgetRestartOptions(args: {
  db: any;
  runId: string;
  runRow: any;
}): Promise<{
  taskId: string;
  projectId: string;
  flowId?: string;
  runnerId?: string;
  baseBranch?: string;
  targetBranch?: string;
}> {
  if (!args.runRow.taskId || !args.runRow.projectId) {
    throw new MaisterError(
      "PRECONDITION",
      `budget restart requires a task-bound project run: ${args.runId}`,
    );
  }

  const workspaceRows = await args.db
    .select({
      baseBranch: workspaces.baseBranch,
      targetBranch: workspaces.targetBranch,
    })
    .from(workspaces)
    .where(eq(workspaces.runId, args.runId));
  const activeSession = await loadActiveRunSession(args.db, args.runId);
  const runnerId = activeSession?.runnerId ?? undefined;
  const workspace = workspaceRows[0] ?? null;

  return {
    taskId: args.runRow.taskId,
    projectId: args.runRow.projectId,
    ...(args.runRow.flowId ? { flowId: args.runRow.flowId } : {}),
    ...(runnerId ? { runnerId } : {}),
    ...(workspace?.baseBranch ? { baseBranch: workspace.baseBranch } : {}),
    ...(workspace?.targetBranch
      ? { targetBranch: workspace.targetBranch }
      : {}),
  };
}

async function preflightParkExportBranch(args: {
  db: any;
  runId: string;
  branchName: string;
}): Promise<void> {
  const rows = await args.db
    .select({
      worktreePath: workspaces.worktreePath,
      parentRepoPath: workspaces.parentRepoPath,
      removedAt: workspaces.removedAt,
    })
    .from(workspaces)
    .where(eq(workspaces.runId, args.runId));
  const workspace = rows[0] ?? null;

  if (!workspace || workspace.removedAt) {
    throw new MaisterError(
      "PRECONDITION",
      `workspace unavailable for budget park export: ${args.runId}`,
    );
  }

  const [head, localHead, metadata] = await Promise.all([
    headCommit({ worktreePath: workspace.worktreePath }),
    localBranchHead({
      projectRepoPath: workspace.parentRepoPath,
      branch: args.branchName,
    }),
    getWorkbenchHandoffMetadata(args.runId, { allowPausedBudgetRun: true }),
  ]);

  if (localHead !== null && localHead !== head) {
    throw new MaisterError(
      "CONFLICT",
      `local branch already exists at a different commit: ${args.branchName}`,
    );
  }

  if (!metadata.defaultRemote) {
    throw new MaisterError(
      "PRECONDITION",
      `no git remote configured for budget park export: ${args.runId}`,
    );
  }

  const remoteHead = await remoteBranchHead({
    projectRepoPath: workspace.parentRepoPath,
    remote: metadata.defaultRemote,
    branch: args.branchName,
  });

  if (remoteHead !== null && remoteHead !== head) {
    throw new MaisterError(
      "CONFLICT",
      `remote branch already exists at a different commit: ${metadata.defaultRemote}/${args.branchName}`,
    );
  }
}

async function addBudgetSystemComment(args: {
  taskId: string | null;
  body: string;
}): Promise<void> {
  if (!args.taskId) return;

  await addTaskComment({
    taskId: args.taskId,
    body: args.body,
    actor: actorForUserId(null),
    activityPayloadExtra: { source: "budget_breach" },
  });
}

async function addBudgetSystemCommentBestEffort(args: {
  taskId: string | null;
  body: string;
  runId: string;
  hitlRequestId: string;
  phase: string;
}): Promise<void> {
  try {
    await addBudgetSystemComment(args);
  } catch (err) {
    log.warn(
      {
        runId: args.runId,
        hitlRequestId: args.hitlRequestId,
        phase: args.phase,
        err: err instanceof Error ? err.message : String(err),
      },
      "budget_breach system comment failed after decision side effect",
    );
  }
}

async function checkpointBudgetLiveSession(args: {
  db: any;
  runId: string;
  hitlRequestId: string;
  phase: "restart" | "park";
}): Promise<boolean> {
  const active = await loadActiveRunSession(args.db, args.runId);

  if (!active?.acpSessionId) {
    return false;
  }

  const sessionId = active.acpSessionId;

  await checkpointSession(sessionId);
  log.info(
    {
      runId: args.runId,
      hitlRequestId: args.hitlRequestId,
      sessionName: active.sessionName,
      sessionId,
      phase: args.phase,
    },
    "budget_breach checkpointed live session before composite side effects",
  );

  return true;
}

async function preflightBudgetRestartLaunchability(args: {
  db: any;
  runId: string;
  runRow: any;
}): Promise<void> {
  const taskId = args.runRow.taskId as string | null;

  if (!taskId || !args.runRow.projectId) {
    throw new MaisterError(
      "PRECONDITION",
      `budget restart requires a task-bound project run: ${args.runId}`,
    );
  }

  const [task] = await args.db
    .select({
      id: tasks.id,
      projectId: tasks.projectId,
      status: tasks.status,
      triageStatus: tasks.triageStatus,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId));

  if (!task) {
    throw new MaisterError("PRECONDITION", `task not found: ${taskId}`);
  }

  await requireProjectAction(task.projectId, "launchRun");
  const experimentMemberRestart = await isExperimentMemberRun(
    args.db,
    args.runId,
  );

  if (!experimentMemberRestart) {
    const activeTaskRuns = await args.db
      .select({ id: runs.id, status: runs.status })
      .from(runs)
      .where(
        and(
          eq(runs.taskId, taskId),
          ne(runs.id, args.runId),
          inArray(runs.status, [
            "Pending",
            "Running",
            "NeedsInput",
            "NeedsInputIdle",
            "HumanWorking",
            "WaitingOnChildren",
            "Review",
          ]),
        ),
      )
      .limit(1);
    const otherActive = activeTaskRuns.filter(
      (run: { id: string }) => run.id !== args.runId,
    );

    if (otherActive.length > 0) {
      throw new MaisterError(
        "PRECONDITION",
        `task is not launchable (classification: busy)`,
      );
    }
  }

  const latestFlowRun = await getLatestFlowRun(taskId, args.db);
  const latestForRestart =
    latestFlowRun === null || latestFlowRun.id === args.runId
      ? ({ status: "Failed" } as const)
      : latestFlowRun;
  const openBlockers =
    (await getOpenRelationBlockers([taskId], args.db)).get(taskId) ?? [];
  const launchability = experimentMemberRestart
    ? classifyForceRelaunchLaunchability(task, latestForRestart, {
        openBlockers,
      })
    : classifyManualTaskLaunchability(task, latestForRestart, { openBlockers });

  if (launchability !== "launchable") {
    const blockerSuffix =
      launchability === "blocked"
        ? ` — blocked by ${openBlockers.map((b) => `${b.key}-${b.number}`).join(", ")}`
        : "";

    throw new MaisterError(
      "PRECONDITION",
      `task is not launchable (classification: ${launchability})${blockerSuffix}`,
    );
  }
}

function budgetRestartTriggerPayload(
  runId: string,
  hitlRequestId: string,
): Record<string, unknown> {
  return {
    kind: "budget_restart",
    oldRunId: runId,
    hitlRequestId,
    idempotencyKey: `budget_restart:${runId}:${hitlRequestId}`,
  };
}

async function findExistingBudgetRestartRun(args: {
  db: any;
  runId: string;
  hitlRequestId: string;
  runRow: any;
}): Promise<BudgetRestartLaunchResult | null> {
  const predicates = [ne(runs.id, args.runId)];

  predicates.push(
    sql`${runs.triggerPayload}->>'kind' = 'budget_restart'`,
    sql`${runs.triggerPayload}->>'oldRunId' = ${args.runId}`,
    sql`${runs.triggerPayload}->>'hitlRequestId' = ${args.hitlRequestId}`,
  );

  if (args.runRow.taskId) {
    predicates.push(eq(runs.taskId, args.runRow.taskId));
  }

  if (args.runRow.agentId) {
    predicates.push(eq(runs.agentId, args.runRow.agentId));
  }

  const rows = await args.db
    .select({
      id: runs.id,
      status: runs.status,
      taskId: runs.taskId,
      agentId: runs.agentId,
      triggerPayload: runs.triggerPayload,
    })
    .from(runs)
    .where(and(...predicates))
    .orderBy(desc(runs.startedAt))
    .limit(20);
  const existing =
    rows.find((row: Record<string, unknown>) => {
      const payload = row.triggerPayload;

      return (
        row.id !== args.runId &&
        (args.runRow.taskId ? row.taskId === args.runRow.taskId : true) &&
        (args.runRow.agentId ? row.agentId === args.runRow.agentId : true) &&
        payload !== null &&
        typeof payload === "object" &&
        !Array.isArray(payload) &&
        (payload as Record<string, unknown>).kind === "budget_restart" &&
        (payload as Record<string, unknown>).oldRunId === args.runId &&
        (payload as Record<string, unknown>).hitlRequestId ===
          args.hitlRequestId
      );
    }) ?? null;

  if (!existing) return null;

  log.info(
    {
      runId: args.runId,
      hitlRequestId: args.hitlRequestId,
      newRunId: existing.id,
      status: existing.status,
    },
    "[FIX:budget-breach-restart] recovered existing restart run from trigger payload",
  );

  return { runId: String(existing.id), status: String(existing.status) };
}

async function launchBudgetRestart(args: {
  db: any;
  actor: HitlActor;
  runId: string;
  runRow: any;
  hitlRequestId: string;
}): Promise<BudgetRestartLaunchResult> {
  const existing = await findExistingBudgetRestartRun(args);

  if (existing !== null) return existing;

  const triggerPayload = budgetRestartTriggerPayload(
    args.runId,
    args.hitlRequestId,
  );

  if (args.runRow.runKind === "agent") {
    if (!args.runRow.agentId || !args.runRow.projectId) {
      throw new MaisterError(
        "PRECONDITION",
        `agent budget restart requires agent/project ids: ${args.runId}`,
      );
    }
    await requireProjectAction(args.runRow.projectId, "launchRun");
    const { launchAgentRun } = await import("@/lib/agents/launch");
    const result = await launchAgentRun({
      agentId: args.runRow.agentId,
      projectId: args.runRow.projectId,
      taskId: args.runRow.taskId ?? null,
      launchOverrideRunnerId: null,
      trigger: {
        source: "manual",
        payload: triggerPayload,
      },
      workspace: args.runRow.agentWorkspace ?? null,
      db: args.db,
    });

    if ("deduped" in result) {
      throw new MaisterError(
        "CONFLICT",
        `agent restart deduped by trigger event for run ${args.runId}`,
      );
    }

    return result;
  }

  const restartOptions = await loadBudgetRestartOptions({
    db: args.db,
    runId: args.runId,
    runRow: args.runRow,
  });

  return launchRun(
    {
      taskId: restartOptions.taskId,
      ...(restartOptions.flowId ? { flowId: restartOptions.flowId } : {}),
      ...(restartOptions.runnerId ? { runnerId: restartOptions.runnerId } : {}),
      ...(restartOptions.baseBranch
        ? { baseBranch: restartOptions.baseBranch }
        : {}),
      ...(restartOptions.targetBranch
        ? { targetBranch: restartOptions.targetBranch }
        : {}),
      triggerSource: "manual",
      triggerPayload,
      allowConcurrent: false,
    },
    {
      actorUserId: args.actor.kind === "user" ? args.actor.userId : null,
      authorize: async (projectId, action = "launchRun") => {
        await requireProjectAction(projectId, action);
      },
    },
    args.db,
  );
}

async function performBudgetPark(args: {
  db: any;
  decision: Extract<BudgetBreachDecision, { optionId: "park" }>;
  runId: string;
  hitlRequestId: string;
}): Promise<{ runStatus: string; ref: string | null }> {
  await checkpointBudgetLiveSession({
    db: args.db,
    runId: args.runId,
    hitlRequestId: args.hitlRequestId,
    phase: "park",
  });

  if (args.decision.mode === "snapshot") {
    let snapshotRef: string | null = null;

    try {
      const snapshot = await snapshotWorkbenchCommit(args.runId, {
        commitMessage: `Budget park snapshot for ${args.runId}`,
        allowPausedBudgetRun: true,
      });

      snapshotRef = snapshot.commit;
    } catch (err) {
      if (!isCleanWorkbenchPrecondition(err)) {
        throw err;
      }
    }

    const archive = await archiveWorkbench(args.runId, {
      allowPausedBudgetRun: true,
    });

    return {
      runStatus: "Abandoned",
      ref: snapshotRef ?? archive.archivedBranch,
    };
  }

  if (!args.decision.branchName) {
    throw new MaisterError(
      "PRECONDITION",
      "budget park export requires branchName",
    );
  }

  try {
    await snapshotWorkbenchCommit(args.runId, {
      commitMessage: `Budget park snapshot for ${args.runId}`,
      allowPausedBudgetRun: true,
    });
  } catch (err) {
    if (!isCleanWorkbenchPrecondition(err)) {
      throw err;
    }
  }

  const metadata = await getWorkbenchHandoffMetadata(args.runId, {
    allowPausedBudgetRun: true,
  });

  if (!metadata.defaultRemote) {
    throw new MaisterError(
      "PRECONDITION",
      `no git remote configured for budget park export: ${args.runId}`,
    );
  }

  const handoff = await createWorkbenchHandoffBranch(args.runId, {
    remote: metadata.defaultRemote,
    handoffBranch: args.decision.branchName,
    allowPausedBudgetRun: true,
  });

  await archiveWorkbench(args.runId, { allowPausedBudgetRun: true });

  return { runStatus: "Abandoned", ref: handoff.pushedRef };
}

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
  body: {
    optionId?: string;
    raiseTo?: unknown;
    response?: unknown;
    dropWorkspace?: unknown;
  };
  runId: string;
  hitlRequestId: string;
  startedAt: number;
  actor: HitlActor;
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
    actor,
    recordSuccessAudit,
  } = args;
  const breach = parseBudgetBreachSchema(hitlRow.schema);
  const scope = breach.scope as BudgetScope;
  const meter = breach.meter;
  const decision = parseBudgetBreachResponse(body, {
    breachedMeter: meter,
    breachedLimit: breach.limit,
  });
  const availabilityContext = await loadBudgetBreachAvailabilityContext({
    db,
    runRow,
    runId,
  });
  const initialClaim = evaluateBudgetBreachClaim({
    storedResponse: hitlRow.response,
    respondedAt: hitlRow.respondedAt,
    incoming: decision,
  });
  const needsPreClaimChecks =
    initialClaim.kind === "fresh" || initialClaim.kind === "re-claimable";

  if (needsPreClaimChecks) {
    assertBudgetBreachOptionAvailable(decision.optionId, availabilityContext);
  }

  if (needsPreClaimChecks && decision.optionId === "restart") {
    await preflightBudgetRestartLaunchability({ db, runId, runRow });
  }

  if (
    needsPreClaimChecks &&
    decision.optionId === "park" &&
    decision.mode === "export"
  ) {
    await preflightParkExportBranch({
      db,
      runId,
      branchName: decision.branchName ?? "",
    });
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
      const claim = evaluateBudgetBreachClaim({
        storedResponse: locked.response,
        respondedAt: locked.respondedAt,
        incoming: decision,
      });

      if (claim.kind !== "idempotent") {
        throw new MaisterError(
          "CONFLICT",
          "budget_breach response already delivered with a different payload",
        );
      }
      const [r] = await tx
        .select({ status: runs.status })
        .from(runs)
        .where(eq(runs.id, runId));

      return {
        transition: "already-delivered",
        runStatus: (r?.status as string | undefined) ?? runRow.status,
      } as const;
    }

    const claim = evaluateBudgetBreachClaim({
      storedResponse: locked.response,
      respondedAt: null,
      incoming: decision,
    });

    if (claim.kind === "conflict") {
      throw new MaisterError(
        "CONFLICT",
        "budget_breach response conflicts with the stored claim",
      );
    }

    if (claim.kind === "re-drive") {
      if (decision.optionId === "restart") {
        return {
          transition: "restart-claimed",
          reDrive: true,
          stage: claim.stage,
          ref: budgetBreachClaimRef(locked.response),
        } as const;
      }
      if (decision.optionId === "park") {
        return {
          transition: "park-claimed",
          reDrive: true,
          stage: claim.stage,
          ref: budgetBreachClaimRef(locked.response),
        } as const;
      }
    }

    if (decision.optionId === "restart") {
      await tx
        .update(hitlRequests)
        .set({
          response: stagedBudgetDecision(decision, "claimed"),
          respondedAt: null,
        })
        .where(eq(hitlRequests.id, hitlRequestId));

      return {
        transition: "restart-claimed",
        reDrive: false,
        stage: "claimed",
        ref: null,
      } as const;
    }

    if (decision.optionId === "park") {
      await tx
        .update(hitlRequests)
        .set({
          response: stagedBudgetDecision(decision, "preserving"),
          respondedAt: null,
        })
        .where(eq(hitlRequests.id, hitlRequestId));

      return {
        transition: "park-claimed",
        reDrive: false,
        stage: "preserving",
        ref: null,
      } as const;
    }

    await tx
      .update(hitlRequests)
      .set({ response: decision, respondedAt: new Date() })
      .where(eq(hitlRequests.id, hitlRequestId));

    if (decision.optionId === "abandon") {
      await terminalizeBudgetRun({
        tx,
        runId,
        reason: "budget_abandoned",
        assignmentReason: "budget breach abandoned",
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
    const field = budgetMeterToPolicyField(meter);
    const nextOverride: BudgetAxis = {
      ...priorOverride,
      [scope]: { ...(priorOverride[scope] ?? {}), [field]: decision.newLimit },
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
      detail: { scope, meter, raiseTo: decision.newLimit },
    });
    await recordSuccessAudit?.(tx, 200);

    return { transition: "raised" } as const;
  });

  if (outcome.transition === "already-delivered") {
    // Self-heal a lost post-commit resume (a crash between the respondedAt commit
    // and scheduleBudgetBreachResume): the run is still awaiting, so the
    // same-payload retry re-drives the SAME dispatcher the raise path uses — it
    // branches on run_kind (agent → respawn, flow → runFlow/resumeRun) AND covers
    // BOTH the NeedsInput (escalate) and NeedsInputIdle (terminate_restorable)
    // pauses. Idempotent: its status CAS / NeedsInput gate no-ops if the run
    // already advanced. The pre-fix flow+NeedsInput-only guard stranded a
    // restorable pause and mis-drove an agent retry through runFlow.
    if (
      outcome.runStatus === "NeedsInput" ||
      outcome.runStatus === "NeedsInputIdle"
    ) {
      await scheduleBudgetBreachResume({
        db,
        runId,
        runKind: runRow.runKind,
        stepId: hitlRow.stepId,
      });
    }

    return NextResponse.json({ ok: true, idempotent: true }, { status: 200 });
  }

  if (outcome.transition === "restart-claimed") {
    let terminalRow: Awaited<ReturnType<typeof terminalizeBudgetRun>> | null =
      null;
    let oldRunTerminalized = false;

    try {
      const oldRunAlreadyTerminal =
        outcome.reDrive &&
        (outcome.stage === "terminalized" ||
          outcome.stage === "relaunch_failed");

      oldRunTerminalized = oldRunAlreadyTerminal;

      if (!oldRunAlreadyTerminal) {
        await checkpointBudgetLiveSession({
          db,
          runId,
          hitlRequestId,
          phase: "restart",
        });

        terminalRow = await db.transaction(async (tx: any) => {
          const row = await terminalizeBudgetRun({
            tx,
            runId,
            reason: "budget_restart",
            assignmentReason: "budget breach restart",
          });

          if (row === null) {
            throw new MaisterError(
              "CONFLICT",
              `run ${runId} is no longer awaiting a budget restart`,
            );
          }

          await setBudgetBreachStage({
            db: tx,
            hitlRequestId,
            decision,
            stage: "terminalized",
          });

          return row;
        });
        oldRunTerminalized = true;
        await captureExperimentDiffSnapshotForRun({ db, runId, force: true });
      }

      const launched = await launchBudgetRestart({
        db,
        actor,
        runId,
        runRow,
        hitlRequestId,
      });

      await setBudgetBreachStage({
        db,
        hitlRequestId,
        decision,
        stage: "terminalized",
        ref: launched.runId,
        respondedAt: new Date(),
      });
      await addBudgetSystemCommentBestEffort({
        taskId: terminalRow?.taskId ?? runRow.taskId ?? null,
        body: `Budget breach restart: old run ${runId} was terminalized and relaunched as ${launched.runId}.`,
        runId,
        hitlRequestId,
        phase: "restart-launched",
      });

      log.info(
        {
          runId,
          hitlRequestId,
          newRunId: launched.runId,
          status: launched.status,
          queuePosition: launched.queuePosition,
          latencyMs: Date.now() - startedAt,
        },
        "budget_breach restarted — new run launched",
      );

      return NextResponse.json(
        {
          ok: true,
          runStatus: "Failed",
          newRunId: launched.runId,
          newRunStatus: launched.status,
          queuePosition: launched.queuePosition,
        },
        { status: 202 },
      );
    } catch (err) {
      if (oldRunTerminalized) {
        const existingRestart = await findExistingBudgetRestartRun({
          db,
          runId,
          hitlRequestId,
          runRow,
        });

        if (existingRestart !== null) {
          await setBudgetBreachStage({
            db,
            hitlRequestId,
            decision,
            stage: "terminalized",
            ref: existingRestart.runId,
            respondedAt: new Date(),
          });
          await addBudgetSystemCommentBestEffort({
            taskId: terminalRow?.taskId ?? runRow.taskId ?? null,
            body: `Budget breach restart: old run ${runId} was terminalized and relaunched as ${existingRestart.runId}.`,
            runId,
            hitlRequestId,
            phase: "restart-redrive-existing",
          });

          return NextResponse.json(
            {
              ok: true,
              runStatus: "Failed",
              newRunId: existingRestart.runId,
              newRunStatus: existingRestart.status,
              queuePosition: existingRestart.queuePosition,
            },
            { status: 202 },
          );
        }
      }

      await setBudgetBreachStage({
        db,
        hitlRequestId,
        decision,
        stage: oldRunTerminalized ? "relaunch_failed" : "failed",
        error: err instanceof Error ? err.message : String(err),
        respondedAt: oldRunTerminalized ? new Date() : null,
      });

      if (oldRunTerminalized) {
        await addBudgetSystemCommentBestEffort({
          taskId: terminalRow?.taskId ?? runRow.taskId ?? null,
          body: `Budget breach restart failed after terminalizing run ${runId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          runId,
          hitlRequestId,
          phase: "restart-failed",
        });
      }

      throw err;
    }
  }

  if (outcome.transition === "park-claimed") {
    let preservationRecorded = false;

    try {
      if (decision.optionId !== "park") {
        throw new MaisterError("CONFIG", "budget park decision lost narrowing");
      }

      const parked =
        outcome.reDrive && outcome.stage === "terminalized"
          ? { runStatus: "Abandoned", ref: outcome.ref ?? null }
          : await performBudgetPark({
              db,
              decision,
              runId,
              hitlRequestId,
            });

      if (!(outcome.reDrive && outcome.stage === "terminalized")) {
        await setBudgetBreachStage({
          db,
          hitlRequestId,
          decision,
          stage: "terminalized",
          ...(parked.ref ? { ref: parked.ref } : {}),
        });
      }

      preservationRecorded = true;

      const runStatus = await markBudgetParkedRun({
        db,
        runId,
        ref: parked.ref,
      });

      await setBudgetBreachStage({
        db,
        hitlRequestId,
        decision,
        stage: "terminalized",
        ...(parked.ref ? { ref: parked.ref } : {}),
        respondedAt: new Date(),
      });
      await addBudgetSystemCommentBestEffort({
        taskId: runRow.taskId ?? null,
        body: `Budget breach parked run ${runId}${
          parked.ref ? ` at ${parked.ref}` : ""
        }.`,
        runId,
        hitlRequestId,
        phase: "parked",
      });

      log.info(
        {
          runId,
          hitlRequestId,
          mode: decision.mode,
          ref: parked.ref,
          runStatus,
          latencyMs: Date.now() - startedAt,
        },
        "budget_breach parked — work preserved",
      );

      return NextResponse.json(
        { ok: true, runStatus, ref: parked.ref },
        { status: 200 },
      );
    } catch (err) {
      if (preservationRecorded) {
        log.warn(
          {
            runId,
            hitlRequestId,
            err: err instanceof Error ? err.message : String(err),
          },
          "[FIX:budget-breach-park] preservation recorded; leaving staged marker retryable",
        );

        throw err;
      }

      await setBudgetBreachStage({
        db,
        hitlRequestId,
        decision,
        stage: "failed",
        error: err instanceof Error ? err.message : String(err),
      });

      throw err;
    }
  }

  if (outcome.transition === "abandoned") {
    await captureExperimentDiffSnapshotForRun({ db, runId, force: true });

    if (
      decision.optionId === "abandon" &&
      decision.dropWorkspace &&
      availabilityContext.hasOwnedWorkspace
    ) {
      try {
        await dropWorkbench(runId);
      } catch (err) {
        log.warn(
          {
            runId,
            hitlRequestId,
            err: err instanceof Error ? err.message : String(err),
          },
          "budget_breach dropWorkspace failed after abandon; TTL cleanup remains available",
        );
      }
    }

    log.info(
      {
        runId,
        hitlRequestId,
        optionId: decision.optionId,
        dropRequested:
          decision.optionId === "abandon" ? decision.dropWorkspace : false,
        latencyMs: Date.now() - startedAt,
      },
      "budget_breach abandoned — run Failed",
    );

    return NextResponse.json(
      { ok: true, runStatus: "Failed" },
      { status: 200 },
    );
  }

  // raise → resume the run (worktree preserved, effective ceiling lifted). The
  // wake mechanism branches on run_kind + the paused status (escalate=NeedsInput,
  // terminate_restorable=NeedsInputIdle) — ADR-106 extends the former flow-only
  // runFlow resume to agents (session/resume) and the idle restorable pause.
  await scheduleBudgetBreachResume({
    db,
    runId,
    runKind: runRow.runKind,
    stepId: hitlRow.stepId,
  });
  log.info(
    {
      runId,
      hitlRequestId,
      optionId: decision.optionId,
      scope,
      meter,
      previousLimit: breach.limit,
      newLimit: decision.optionId === "raise" ? decision.newLimit : null,
      runKind: runRow.runKind,
      latencyMs: Date.now() - startedAt,
    },
    "budget_breach raised — resuming",
  );

  // runStatus is the pre-resume paused status hint; the resume runs async and the
  // client observes the live status via the stream (the contract stays NeedsInput
  // for back-compat — a restorable run is NeedsInputIdle but resume-in-progress is
  // the meaningful signal).
  return NextResponse.json(
    { ok: true, runStatus: "NeedsInput", state: "resume-in-progress" },
    { status: 202 },
  );
}

// ADR-108 (M40): respond to a guardrail trip (NeedsInput hook_trip HITL). A
// resume-or-abort decision (like infra_recovery / budget_breach), routed through
// each run_kind's EXISTING resume path: flow → scheduleResume (runFlow does the
// NeedsInput→Running CAS); agent → CAS the run Running in-tx then respawn via
// startAgentSession. abort → terminal Failed. Human-actor-only is enforced at
// the respondToHitl chokepoint. scratch never produces a hook_trip HITL (D2).
async function handleHookTripResponse(args: {
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
    runRow,
    body,
    runId,
    hitlRequestId,
    startedAt,
    recordSuccessAudit,
  } = args;
  const decision = body.optionId;

  if (decision !== "resume" && decision !== "abort") {
    throw new MaisterError(
      "PRECONDITION",
      'hook_trip response requires optionId "resume" or "abort"',
    );
  }

  const isAgent = runRow.runKind === "agent";

  const outcome = await db.transaction(async (tx: any) => {
    const locked = await lockHitlRow(tx, hitlRequestId);

    if (!locked) {
      throw new MaisterError(
        "PRECONDITION",
        `hitl request not found: ${hitlRequestId}`,
      );
    }
    if (locked.respondedAt) {
      const [r] = await tx
        .select({ status: runs.status })
        .from(runs)
        .where(eq(runs.id, runId));

      return {
        transition: "already-delivered",
        runStatus: (r?.status as string | undefined) ?? runRow.status,
      } as const;
    }

    await tx
      .update(hitlRequests)
      .set({ respondedAt: new Date() })
      .where(eq(hitlRequests.id, hitlRequestId));

    if (decision === "abort") {
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
        await syncExperimentStatusForRun({ db: tx, runId });
      }

      if (terminal.length > 0 && terminal[0].projectId) {
        await emitWebhookEvent({
          db: tx,
          type: "run.failed",
          projectId: terminal[0].projectId,
          runId,
          data: { errorCode: "PRECONDITION", reason: "hook_trip_abandoned" },
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
            reason: "hook_trip_abandoned",
          },
        });
      }
      await systemCloseActiveAssignmentsForRun({
        db: tx,
        runId,
        reason: "hook_trip aborted",
      });
      await recordSuccessAudit?.(tx, 200);

      return { transition: "aborted" } as const;
    }

    // resume: the run is left NeedsInput|NeedsInputIdle here for BOTH run kinds.
    // The runner owns NeedsInput→Running on resume — flow via runFlow's own CAS,
    // agent via claimAndResumeAgentRun (off the response path). Keeping the run
    // awaiting until the claim lands is the durable re-drive signal: a
    // same-payload retry whose prior handoff was lost re-drives from the
    // already-delivered branch (mirrors the flow self-heal). No in-tx Running
    // flip — that flip destroyed the agent re-drive signal and stranded a lost
    // handoff as a fake Running run until reconcile crashed it.
    await systemCloseActiveAssignmentsForRun({
      db: tx,
      runId,
      reason: "hook_trip resumed",
    });
    await recordSuccessAudit?.(tx, 202);

    return { transition: "resume" } as const;
  });

  if (outcome.transition === "already-delivered") {
    // Self-heal a crash between the respondedAt commit and the post-commit
    // resume handoff: the run was left awaiting, so a same-payload retry is the
    // durable recovery path. Re-drive the run_kind's resume — idempotent: the
    // agent claim CAS / runFlow's NeedsInput gate no-ops if the run already
    // advanced. (A stranded post-claim Running agent run is recovered by
    // reconcile.)
    if (
      isAgent &&
      (outcome.runStatus === "NeedsInput" ||
        outcome.runStatus === "NeedsInputIdle")
    ) {
      claimAndResumeAgentRun(runId, db);
    } else if (!isAgent && outcome.runStatus === "NeedsInput") {
      scheduleResume(runId);
    }

    return NextResponse.json(
      { ok: true, runStatus: outcome.runStatus, idempotent: true },
      { status: 200 },
    );
  }

  if (outcome.transition === "aborted") {
    await captureExperimentDiffSnapshotForRun({ db, runId, force: true });
    log.info(
      { runId, hitlRequestId, decision, latencyMs: Date.now() - startedAt },
      "hook_trip aborted — run Failed",
    );

    return NextResponse.json(
      { ok: true, runStatus: "Failed" },
      { status: 200 },
    );
  }

  // resume → re-enter the run through its run_kind's resume path. The run is
  // left awaiting; the runner owns NeedsInput→Running (agent claim / runFlow).
  if (isAgent) {
    claimAndResumeAgentRun(runId, db);
  } else {
    scheduleResume(runId);
  }

  log.info(
    {
      runId,
      hitlRequestId,
      decision,
      runKind: runRow.runKind,
      latencyMs: Date.now() - startedAt,
    },
    "hook_trip resumed — re-entering run",
  );

  return NextResponse.json(
    { ok: true, runStatus: "NeedsInput", state: "resume-in-progress" },
    { status: 202 },
  );
}

type AgentQuestionResponseOutcome =
  | { kind: "replayed"; reTriggerMode: "agent" | "triage" }
  | {
      kind: "answered";
      reTriggerMode: "agent" | "triage";
      supersededCount: number;
    };

async function handleAgentQuestionResponse(
  args: HandlerArgs,
): Promise<NextResponse> {
  const { db, hitlRow, runRow, body, runId, hitlRequestId, startedAt } = args;

  const humanActor = args.actor;

  if (humanActor.kind !== "user") {
    throw new MaisterError(
      "UNAUTHORIZED",
      "an agent_question HITL request requires a human actor",
    );
  }
  if (body.response === undefined) {
    throw new MaisterError(
      "CONFIG",
      "response is required for kind=agent_question",
    );
  }
  if (typeof hitlRow.taskId !== "string" || hitlRow.taskId.length === 0) {
    throw new MaisterError(
      "PRECONDITION",
      "agent_question is missing its task binding",
    );
  }

  // Validate before locking/mutating. An agent question is schema-driven like a
  // form, but it has no input artifact or run-resume step after the answer.
  assertHitlResponse(body.response, hitlRow.schema);
  const response = body.response;
  const taskId = hitlRow.taskId;

  const outcome: AgentQuestionResponseOutcome = await db.transaction(
    async (tx: any) => {
      // Lock order is task → request. New task-bound agent launches use the
      // same order while superseding questions, so answer-vs-successor resolves
      // deterministically without a dangling active Inbox assignment.
      const taskRows = await tx
        .select({
          id: tasks.id,
          projectId: tasks.projectId,
          number: tasks.number,
          title: tasks.title,
        })
        .from(tasks)
        .where(and(eq(tasks.id, taskId), eq(tasks.projectId, runRow.projectId)))
        .for("update");
      const task = taskRows[0];

      if (!task) {
        throw new MaisterError("PRECONDITION", "agent_question task not found");
      }

      const lockedHitl = await lockHitlRow(tx, hitlRequestId);

      if (
        !lockedHitl ||
        lockedHitl.kind !== "agent_question" ||
        lockedHitl.runId !== runId ||
        lockedHitl.taskId !== task.id
      ) {
        throw new MaisterError(
          "PRECONDITION",
          "agent_question no longer matches the requested source run and task",
        );
      }

      const reTriggerMode = lockedHitl.reTriggerMode;

      if (reTriggerMode !== "agent" && reTriggerMode !== "triage") {
        throw new MaisterError(
          "PRECONDITION",
          "agent_question has an invalid re-trigger mode",
        );
      }

      const clarificationRows = await tx
        .select()
        .from(taskClarifications)
        .where(
          and(
            eq(taskClarifications.sourceHitlRequestId, hitlRequestId),
            eq(taskClarifications.taskId, task.id),
          ),
        )
        .for("update");
      const clarification = clarificationRows[0];

      if (!clarification) {
        throw new MaisterError(
          "PRECONDITION",
          "agent_question clarification provenance is missing",
        );
      }

      const sourceRows = await tx
        .select({ status: runs.status, runKind: runs.runKind })
        .from(runs)
        .where(eq(runs.id, runId))
        .for("update");
      const source = sourceRows[0];

      if (
        !source ||
        source.runKind !== "agent" ||
        !AGENT_QUESTION_SOURCE_STATUS_SET.has(source.status)
      ) {
        throw new MaisterError(
          "PRECONDITION",
          "agent_question source run cannot be finalized as Done",
        );
      }
      if (source.status !== "Done") {
        await tx
          .update(runs)
          .set({ status: "Done", endedAt: new Date(), currentStepId: null })
          .where(
            and(
              eq(runs.id, runId),
              inArray(runs.status, AGENT_QUESTION_SOURCE_STATUSES),
            ),
          );
        await revokeAgentRunTokensForRun(runId, tx);
      }

      if (lockedHitl.respondedAt !== null) {
        if (!payloadsEqual(lockedHitl.response, response)) {
          throw new MaisterError(
            "CONFLICT",
            "agent_question already has a different answer",
          );
        }

        await args.recordSuccessAudit?.(tx, 200);

        return { kind: "replayed", reTriggerMode } as const;
      }
      if (
        lockedHitl.activationState !== "active" ||
        lockedHitl.supersededAt !== null ||
        lockedHitl.response !== null
      ) {
        throw new MaisterError(
          "CONFLICT",
          "agent_question is not an active unanswered request",
        );
      }

      const assignmentRows = await tx
        .select()
        .from(assignments)
        .where(eq(assignments.hitlRequestId, hitlRequestId))
        .for("update");
      const assignment = assignmentRows[0];
      const assignmentActor = assignment
        ? await ensureUserActor({
            db: tx,
            projectId: task.projectId,
            userId: humanActor.userId,
            label: humanActor.label,
          })
        : null;

      if (
        assignment &&
        assignment.status === "claimed" &&
        assignment.assigneeActorId !== assignmentActor?.id
      ) {
        throw new MaisterError(
          "CONFLICT",
          "agent_question assignment is claimed by another actor",
        );
      }
      if (assignment?.status === "cancelled") {
        throw new MaisterError(
          "CONFLICT",
          "agent_question assignment is already cancelled",
        );
      }

      const now = new Date();

      await tx
        .update(hitlRequests)
        .set({ response, respondedAt: now })
        .where(
          and(
            eq(hitlRequests.id, hitlRequestId),
            isNull(hitlRequests.respondedAt),
            eq(hitlRequests.activationState, "active"),
            isNull(hitlRequests.supersededAt),
          ),
        );
      await tx
        .update(taskClarifications)
        .set({
          answer: response,
          answeredByUserId: humanActor.userId,
          answeredAt: now,
        })
        .where(
          and(
            eq(taskClarifications.id, clarification.id),
            isNull(taskClarifications.answeredAt),
            isNull(taskClarifications.supersededAt),
          ),
        );

      const siblings = await tx
        .select({ id: hitlRequests.id })
        .from(hitlRequests)
        .where(
          and(
            eq(hitlRequests.taskId, task.id),
            eq(hitlRequests.kind, "agent_question"),
            ne(hitlRequests.id, hitlRequestId),
            isNull(hitlRequests.respondedAt),
            isNull(hitlRequests.supersededAt),
            inArray(hitlRequests.activationState, [
              "pending_termination",
              "active",
            ]),
          ),
        )
        .for("update");
      const siblingIds = siblings.map((sibling: { id: string }) => sibling.id);

      if (siblingIds.length > 0) {
        await tx
          .update(hitlRequests)
          .set({
            supersededAt: now,
            supersededByHitlRequestId: hitlRequestId,
          })
          .where(inArray(hitlRequests.id, siblingIds));
        await tx
          .update(taskClarifications)
          .set({
            supersededAt: now,
            supersededByHitlRequestId: hitlRequestId,
          })
          .where(inArray(taskClarifications.sourceHitlRequestId, siblingIds));

        for (const siblingId of siblingIds) {
          await systemCloseActiveAssignmentsForHitlRequest({
            db: tx,
            hitlRequestId: siblingId,
            projectId: task.projectId,
            reason: "superseded by an answered agent clarification",
          });
        }
      }

      if (assignment && assignmentActor) {
        await completeAssignment({
          db: tx,
          assignmentId: assignment.id,
          actorId: assignmentActor.id,
          eventKind: "responded",
        });
      }

      const eventActor = actorForUserId(humanActor.userId);

      if (reTriggerMode === "triage") {
        const projectRows = await tx
          .select({ taskKey: projects.taskKey })
          .from(projects)
          .where(eq(projects.id, task.projectId));
        const project = projectRows[0];

        if (!project) {
          throw new MaisterError(
            "PRECONDITION",
            "agent_question project is missing",
          );
        }

        await sendTaskToTriageInTransaction(tx, {
          taskId: task.id,
          projectId: task.projectId,
          taskRef: `${project.taskKey}-${task.number}`,
          title: task.title,
          actor: eventActor,
        });
      } else {
        await emitDomainEvent({
          db: tx,
          kind: "task.clarification_answered",
          projectId: task.projectId,
          taskId: task.id,
          runId,
          actor: eventActor,
          payload: {
            clarificationId: clarification.id,
            hitlRequestId,
            requestingAgentId: clarification.originAgentId,
          },
        });
      }

      await args.recordSuccessAudit?.(tx, 200);

      return {
        kind: "answered",
        reTriggerMode,
        supersededCount: siblingIds.length,
      } as const;
    },
  );

  if (outcome.kind === "replayed") {
    log.debug(
      { runId, hitlRequestId, reTriggerMode: outcome.reTriggerMode },
      "agent_question answer replayed idempotently",
    );

    return NextResponse.json(
      { ok: true, runStatus: "Done", idempotent: true },
      { status: 200 },
    );
  }

  log.info(
    {
      runId,
      hitlRequestId,
      reTriggerMode: outcome.reTriggerMode,
      supersededCount: outcome.supersededCount,
      latencyMs: Date.now() - startedAt,
    },
    "agent_question answered and re-trigger fact committed",
  );

  return NextResponse.json({ ok: true, runStatus: "Done" }, { status: 200 });
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
  const bodyKeys = input.bodyKeys ?? Object.keys(body);
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
    if (runRow.projectId && actor.preauthorizedProjectId !== runRow.projectId) {
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
      hitlRow.kind === "decision_request" ||
      hitlRow.kind === "agent_question" ||
      hitlRow.kind === "infra_recovery" ||
      hitlRow.kind === "budget_breach" ||
      // ADR-108 (M40): a guardrail trip is a safety escalation only a human may
      // resolve — a machine/agent token must never dismiss its own trip
      // (dispatched to handleHookTripResponse below).
      hitlRow.kind === "hook_trip"
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
      bodyKeys,
      body,
      runId,
      hitlRequestId,
      startedAt,
      actor,
      recordSuccessAudit,
    });
  }

  if (hitlRow.kind === "agent_question") {
    log.debug({ runId, hitlRequestId, branch: "agent_question" }, "dispatch");

    return await handleAgentQuestionResponse({
      db,
      hitlRow,
      runRow,
      bodyKeys,
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
      actor,
      recordSuccessAudit,
    });
  }

  if (hitlRow.kind === "hook_trip") {
    log.debug({ runId, hitlRequestId, branch: "hook_trip" }, "dispatch");

    return await handleHookTripResponse({
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

  if (hitlRow.kind === "decision_request") {
    log.debug({ runId, hitlRequestId, branch: "decision_request" }, "dispatch");

    return await handlePlanReviewDecisionResponse({
      db,
      hitlRow,
      runRow,
      bodyKeys,
      body,
      runId,
      hitlRequestId,
      startedAt,
      actor,
      recordSuccessAudit,
    });
  }

  if (hitlRow.kind === "human" && planReviewParentState(hitlRow.schema)) {
    log.debug(
      { runId, hitlRequestId, branch: "plan_review_parent" },
      "dispatch",
    );

    return await handlePlanReviewParentResponse({
      db,
      hitlRow,
      runRow,
      bodyKeys,
      body,
      runId,
      hitlRequestId,
      startedAt,
      actor,
      recordSuccessAudit,
    });
  }

  log.debug({ runId, hitlRequestId, branch: "form/human" }, "dispatch");

  return await handleFormHumanResponse({
    db,
    hitlRow,
    runRow,
    bodyKeys,
    body,
    runId,
    hitlRequestId,
    startedAt,
    actor,
    recordSuccessAudit,
  });
}
