import "server-only";

import type { FlowYamlV1 } from "@/lib/config.schema";

import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import path from "node:path";

import { and, asc, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import pino from "pino";

import { markCheckpointed } from "./state-transitions";

import { atomicWriteJson } from "@/lib/atomic";
import {
  createHitlAssignmentForRun,
  systemCloseActiveAssignmentsForRun,
} from "@/lib/assignments/service";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { compileManifest } from "@/lib/flows/graph/compile";
import { markNodeFailed, markNodeNeedsInput } from "@/lib/flows/graph/ledger";
import { runtimeRoot as configuredRuntimeRoot } from "@/lib/instance-config";
import { cascadeAbandonRunTree } from "@/lib/orchestrator/cascade";
import {
  consecutiveFailedAttempts,
  consecutiveFailedRuns,
  treeWallClockMinutes,
} from "@/lib/runs/budget-meters";
import {
  queryRunTokens,
  queryRunTreeTokens,
  queryTaskTokens,
  reconcileRunCostRollups,
} from "@/lib/runs/cost-rollups";
import {
  budgetFromSnapshot,
  type BudgetAxis,
  type BudgetLimits,
  type BudgetRung,
  type BudgetScope,
} from "@/lib/runs/execution-policy";
import { logExecPolicyAction } from "@/lib/runs/exec-policy-audit";
import { runDirPath } from "@/lib/flows/graph/mutation-check";
import { promoteNextPending, releaseSlotOnIdle } from "@/lib/scheduler";
import {
  checkpointSession,
  deleteSession,
  listSessions,
  type SupervisorSessionRecord,
} from "@/lib/supervisor-client";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { flowRevisions, flows, hitlRequests, nodeAttempts, projects, runs } =
  schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "keepalive-sweeper",
  level: process.env.LOG_LEVEL ?? "info",
});

const DEFAULT_SWEEP_INTERVAL_SECONDS = 30;
const DEFAULT_NEEDS_INPUT_IDLE_TTL_HOURS = 24;
const PER_TICK_LIMIT = 50;
const PER_PASS_CONCURRENCY = 4;

function sweepIntervalSeconds(): number {
  const raw = process.env.MAISTER_KEEPALIVE_SWEEP_INTERVAL_SECONDS;

  if (!raw) return DEFAULT_SWEEP_INTERVAL_SECONDS;
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_SWEEP_INTERVAL_SECONDS;
  }

  return parsed;
}

function needsInputIdleTtlHours(): number {
  const raw = process.env.MAISTER_NEEDSINPUTIDLE_TTL_HOURS;

  if (!raw) return DEFAULT_NEEDS_INPUT_IDLE_TTL_HOURS;
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_NEEDS_INPUT_IDLE_TTL_HOURS;
  }

  return parsed;
}

// Map<acpSessionId, SupervisorSessionRecord> built once per tick so
// each candidate row can look up its supervisor entry in O(1) without
// a second HTTP round-trip.
type SessionMap = Map<string, SupervisorSessionRecord>;

async function loadSupervisorSessionRecords(): Promise<
  SupervisorSessionRecord[] | null
> {
  try {
    return await listSessions();
  } catch (err) {
    log.warn(
      { err: (err as Error).message },
      "sweeper listSessions failed — candidates left for the next tick",
    );

    return null;
  }
}

async function loadSupervisorSessions(): Promise<SessionMap | null> {
  const records = await loadSupervisorSessionRecords();

  if (records === null) return null;

  const map: SessionMap = new Map();

  for (const rec of records) {
    if (rec.status === "live" && rec.acpSessionId) {
      map.set(rec.acpSessionId, rec);
    } else if (rec.status === "live") {
      // No acpSessionId yet (rare race during boot) — fall back to
      // the supervisor sessionId as the key. The matching path below
      // tries acpSessionId first; the supervisor-sessionId fallback
      // is only an escape hatch.
      map.set(rec.sessionId, rec);
    }
  }

  return map;
}

type Pass1Candidate = {
  id: string;
  acpSessionId: string | null;
};

async function fetchPass1Candidates(db: Db): Promise<Pass1Candidate[]> {
  const now = new Date();
  const rows = await db
    .select({ id: runs.id, acpSessionId: runs.acpSessionId })
    .from(runs)
    .where(
      and(
        eq(runs.status, "NeedsInput"),
        isNotNull(runs.keepaliveUntil),
        lt(runs.keepaliveUntil, now),
      ),
    )
    .orderBy(asc(runs.keepaliveUntil))
    .limit(PER_TICK_LIMIT);

  return rows;
}

type Pass2Candidate = { id: string; runKind: string };

async function fetchPass2Candidates(
  db: Db,
  ttlHours: number,
): Promise<Pass2Candidate[]> {
  const cutoff = new Date(Date.now() - ttlHours * 3600_000);
  const rows = await db
    .select({ id: runs.id, runKind: runs.runKind })
    .from(runs)
    .where(
      and(
        eq(runs.status, "NeedsInputIdle"),
        isNotNull(runs.checkpointAt),
        lt(runs.checkpointAt, cutoff),
        // M37 Phase 8 (ADR-099): a persistent swarm member parks INDEFINITELY
        // until re-messaged or its tree terminates — never TTL-abandoned here.
        eq(runs.persistent, false),
      ),
    )
    .orderBy(asc(runs.checkpointAt))
    .limit(PER_TICK_LIMIT);

  return rows;
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const slot = async () => {
    while (cursor < items.length) {
      const idx = cursor;

      cursor += 1;
      await worker(items[idx]);
    }
  };

  const slots = Array.from({ length: Math.min(limit, items.length) }, () =>
    slot(),
  );

  await Promise.all(slots);
}

async function runPass1(db: Db): Promise<number> {
  const candidates = await fetchPass1Candidates(db);

  if (candidates.length === 0) return 0;

  const supervisorMap = await loadSupervisorSessions();

  // M8 review finding #1: when listSessions() fails we cannot
  // distinguish "session is gone" from "supervisor is transiently
  // unreachable". Marking the row NeedsInputIdle in the latter case
  // produces a split-brain state — the agent is still alive holding
  // the original permission deferred, but the DB says the slot is
  // free and the run is idle. Refuse to act on any candidate and
  // wait for the next tick.
  if (supervisorMap === null) {
    log.warn(
      { candidateCount: candidates.length },
      "sweeper pass1 aborted — listSessions failed; leaving candidates in NeedsInput for next tick",
    );

    return 0;
  }

  let idled = 0;

  await runWithConcurrency(candidates, PER_PASS_CONCURRENCY, async (row) => {
    const live = row.acpSessionId
      ? supervisorMap.get(row.acpSessionId)
      : undefined;

    if (live) {
      try {
        await checkpointSession(live.sessionId);
      } catch (err) {
        if (isMaisterError(err) && err.code === "EXECUTOR_UNAVAILABLE") {
          log.warn(
            { runId: row.id, err: err.message },
            "sweeper pass1 supervisor 5xx — retry on next tick",
          );

          return;
        }
        log.warn(
          {
            runId: row.id,
            err: err instanceof Error ? err.message : String(err),
            code:
              isMaisterError(err) && "code" in err
                ? (err as { code: string }).code
                : null,
          },
          "sweeper pass1 supervisor terminal failure — proceeding to markCheckpointed (session is unrecoverable)",
        );
      }
    } else if (row.acpSessionId) {
      log.info(
        { runId: row.id, acpSessionId: row.acpSessionId },
        "sweeper pass1 supervisor session not live — marking checkpointed directly",
      );
    }

    const transition = await markCheckpointed(row.id, { db });

    if (transition.ok) {
      idled += 1;
      try {
        await releaseSlotOnIdle({ runId: row.id, db });
      } catch (err) {
        log.warn(
          {
            runId: row.id,
            err: err instanceof Error ? err.message : String(err),
          },
          "sweeper pass1 promoteNextPending after markCheckpointed failed",
        );
      }
    }
  });

  return idled;
}

// Exported for the ADR-086 emit-terminal integration test — the public sweep
// entry stays runSweepTick.
export async function runPass2(db: Db): Promise<number> {
  const ttlHours = needsInputIdleTtlHours();
  const candidates = await fetchPass2Candidates(db, ttlHours);

  if (candidates.length === 0) return 0;

  let abandoned = 0;

  await runWithConcurrency(candidates, PER_PASS_CONCURRENCY, async (row) => {
    if (row.runKind === "agent") {
      const { finalizeAgentRun } = await import("@/lib/agents/launch");
      const result = await finalizeAgentRun(row.id, "Abandoned", {
        db,
        reason: "ttl",
        closeOpenHitl: true,
      });

      if (!result.finalized) {
        log.debug(
          { runId: row.id },
          "sweeper pass2 agent finalize mismatch — concurrent transition won",
        );

        return;
      }

      abandoned += 1;
      log.warn(
        { runId: row.id, ttlHours },
        "sweeper pass2 agent NeedsInputIdle → Abandoned (TTL exceeded)",
      );

      return;
    }

    // ADR-086: the status flip, the hitl close-out, and BOTH outbox emits
    // (webhook + domain) commit in ONE transaction — previously two bare
    // updates with no emit (the TTL run.abandoned webhook gap, now closed
    // with data.source = "ttl").
    const flipped: boolean = await db.transaction(async (tx: Db) => {
      const updated = await tx
        .update(runs)
        .set({ status: "Abandoned", endedAt: new Date() })
        .where(and(eq(runs.id, row.id), eq(runs.status, "NeedsInputIdle")))
        .returning({
          id: runs.id,
          projectId: runs.projectId,
          taskId: runs.taskId,
          flowId: runs.flowId,
          runKind: runs.runKind,
          parentRunId: runs.parentRunId,
        });

      if (updated.length === 0) return false;

      // M8 T12: mark any open hitl_requests row for this run with
      // respondedAt=now() so the operator UI shows the request as closed.
      // Audit metadata (abandonedReason) lives in the run-level audit
      // surface (M9+ inbox); a hitl_requests-level audit column would
      // require a migration and is intentionally deferred.
      await tx
        .update(hitlRequests)
        .set({ respondedAt: new Date() })
        .where(
          and(eq(hitlRequests.runId, row.id), isNull(hitlRequests.respondedAt)),
        );

      // ADR-097: a project-less local-package run has no project to attribute
      // these project-scoped events to — skip the emits (its terminal row is
      // the record).
      if (updated[0].projectId) {
        await emitWebhookEvent({
          db: tx,
          type: "run.abandoned",
          projectId: updated[0].projectId,
          runId: row.id,
          data: { source: "ttl" },
        });

        await emitDomainEvent({
          db: tx,
          kind: "run.abandoned",
          projectId: updated[0].projectId,
          runId: row.id,
          taskId: updated[0].taskId,
          actor: { type: "system", id: null },
          parentRunId: updated[0].parentRunId,
          payload: {
            runId: row.id,
            taskId: updated[0].taskId,
            flowId: updated[0].flowId,
            runKind: updated[0].runKind,
            reason: "ttl",
          },
        });
      }

      return true;
    });

    if (!flipped) {
      log.debug(
        { runId: row.id },
        "sweeper pass2 status-guard mismatch — concurrent transition won",
      );

      return;
    }

    abandoned += 1;
    log.warn(
      { runId: row.id, ttlHours },
      "sweeper pass2 NeedsInputIdle → Abandoned (TTL exceeded)",
    );
  });

  return abandoned;
}

// --- M11c Phase 3B: time-limit kill-on-cap watchdog (ADR-032) --------------

type TimeLimitCandidate = {
  id: string;
  flowId: string | null;
  flowRevisionId: string | null;
  currentStepId: string | null;
  acpSessionId: string | null;
};

async function fetchTimeLimitCandidates(db: Db): Promise<TimeLimitCandidate[]> {
  const rows = await db
    .select({
      id: runs.id,
      flowId: runs.flowId,
      flowRevisionId: runs.flowRevisionId,
      currentStepId: runs.currentStepId,
      acpSessionId: runs.acpSessionId,
    })
    .from(runs)
    .where(
      and(
        eq(runs.status, "Running"),
        eq(runs.runKind, "flow"),
        isNotNull(runs.currentStepId),
      ),
    )
    // No acp_session_id filter: a capped node that hangs before reporting a
    // session id must still be killable. deleteSession is best-effort (skipped
    // when no live session matches); the Failed transition fires regardless.
    .orderBy(asc(runs.startedAt))
    .limit(PER_TICK_LIMIT);

  return rows;
}

// Resolve the pinned manifest for a run: the immutable flow_revisions.manifest
// when the run carries a revision pin, else the live flows.manifest.
async function resolveRunManifest(
  db: Db,
  candidate: TimeLimitCandidate,
): Promise<FlowYamlV1 | null> {
  if (candidate.flowRevisionId) {
    const revRows = await db
      .select({ manifest: flowRevisions.manifest })
      .from(flowRevisions)
      .where(eq(flowRevisions.id, candidate.flowRevisionId));

    if (revRows[0]?.manifest) return revRows[0].manifest as FlowYamlV1;
  }

  if (!candidate.flowId) return null;

  const flowRows = await db
    .select({ manifest: flows.manifest })
    .from(flows)
    .where(eq(flows.id, candidate.flowId));

  return (flowRows[0]?.manifest ?? null) as FlowYamlV1 | null;
}

function maxDurationMinutesFor(
  manifest: FlowYamlV1,
  nodeId: string,
): number | null {
  const node = compileManifest(manifest).nodes.get(nodeId);

  if (!node) return null;
  const settings = node.settings as
    | { limits?: { maxDurationMinutes?: number } }
    | undefined;
  const cap = settings?.limits?.maxDurationMinutes;

  return typeof cap === "number" ? cap : null;
}

type ActiveAttempt = { id: string; startedAt: Date };

async function fetchActiveAttempt(
  db: Db,
  runId: string,
  nodeId: string,
): Promise<ActiveAttempt | null> {
  const rows = await db
    .select({ id: nodeAttempts.id, startedAt: nodeAttempts.startedAt })
    .from(nodeAttempts)
    .where(
      and(
        eq(nodeAttempts.runId, runId),
        eq(nodeAttempts.nodeId, nodeId),
        eq(nodeAttempts.status, "Running"),
      ),
    )
    .orderBy(asc(nodeAttempts.attempt));

  return rows.length > 0 ? rows[rows.length - 1] : null;
}

// Kill-on-cap pass: a Running flow node whose effective
// limits.maxDurationMinutes is exceeded (elapsed from the active node attempt's
// started_at) is terminated via supervisor DELETE (which drives teardown so no
// permission deferred leaks), the attempt marked Failed, the run ended Failed.
// Cost limits stay record-only — never a kill trigger.
async function runTimeLimitPass(db: Db): Promise<number> {
  const candidates = await fetchTimeLimitCandidates(db);

  if (candidates.length === 0) return 0;

  const records = await loadSupervisorSessionRecords();

  if (records === null) {
    log.warn(
      { candidateCount: candidates.length },
      "watchdog aborted — listSessions failed; leaving Running candidates for next tick",
    );

    return 0;
  }

  let killed = 0;

  await runWithConcurrency(candidates, PER_PASS_CONCURRENCY, async (row) => {
    const manifest = await resolveRunManifest(db, row);

    if (!manifest || !row.currentStepId) return;

    const cap = maxDurationMinutesFor(manifest, row.currentStepId);

    if (cap === null) return;

    const attempt = await fetchActiveAttempt(db, row.id, row.currentStepId);

    if (!attempt) return;

    const elapsedMs = Date.now() - attempt.startedAt.getTime();

    log.info(
      { runId: row.id, nodeId: row.currentStepId, capMinutes: cap },
      "watchdog armed for capped Running node",
    );

    if (elapsedMs <= cap * 60_000) return;

    // Match the live supervisor session by the server-owned (runId, stepId),
    // NOT by runs.acp_session_id: the graph runner persists acp_session_id only
    // AFTER the node's prompt returns, so a node still mid-prompt has a null
    // column while its agent session is live. Looking up by (runId, stepId)
    // finds — and therefore actually tears down — that session instead of
    // marking the run Failed while the agent keeps mutating the worktree
    // (split-brain). Only the EXACT capped node's session is matched, never a
    // later node's live session.
    const live = records.find(
      (r) =>
        r.status === "live" &&
        r.runId === row.id &&
        r.stepId === row.currentStepId,
    );

    if (live) {
      try {
        await deleteSession(live.sessionId);
      } catch (err) {
        // 5xx / network → retryable: leave the run Running and retry next tick.
        // Marking Failed without confirming teardown is the split-brain we must
        // avoid (terminal run, still-live agent).
        if (isMaisterError(err) && err.code === "EXECUTOR_UNAVAILABLE") {
          log.warn(
            { runId: row.id, err: err.message },
            "watchdog deleteSession 5xx — leaving Running for next tick",
          );

          return;
        }
        // Terminal failure (e.g. 404 unknown session) → the session is already
        // gone; safe to proceed to the terminal transition.
        log.warn(
          {
            runId: row.id,
            err: err instanceof Error ? err.message : String(err),
          },
          "watchdog deleteSession terminal failure — session unrecoverable, proceeding",
        );
      }
    }
    // No live session for this (run, node): the capped node's agent is not
    // running — confirmed absent, safe to mark Failed.

    // Claim the terminal transition atomically over BOTH runs and the active
    // attempt, guarded on the run still being Running ON THIS NODE. A
    // concurrently-finishing node moves runs.current_step_id off this node, so
    // the guard matches zero rows and we never overwrite its ledger attempt.
    // A maxDurationMinutes cap is the same family as the concurrency-cap
    // PRECONDITION the sweeper owns, NOT a pending-permission deferred expiry
    // (that is HITL_TIMEOUT). ADR-008 closed union: reuse PRECONDITION.
    const claimed: boolean = await db.transaction(async (tx: Db) => {
      const upd = await tx
        .update(runs)
        .set({ status: "Failed", endedAt: new Date(), currentStepId: null })
        .where(
          and(
            eq(runs.id, row.id),
            eq(runs.status, "Running"),
            eq(runs.currentStepId, row.currentStepId),
          ),
        )
        .returning({
          id: runs.id,
          projectId: runs.projectId,
          taskId: runs.taskId,
          flowId: runs.flowId,
          runKind: runs.runKind,
          parentRunId: runs.parentRunId,
        });

      if (upd.length === 0) return false;

      await markNodeFailed(attempt.id, { errorCode: "PRECONDITION" }, tx);
      await systemCloseActiveAssignmentsForRun({
        db: tx,
        runId: row.id,
        reason: "node execution exceeded maxDurationMinutes",
      });

      await emitWebhookEvent({
        db: tx,
        type: "run.failed",
        projectId: upd[0].projectId,
        runId: row.id,
        data: { errorCode: "PRECONDITION" },
      });

      await emitDomainEvent({
        db: tx,
        kind: "run.failed",
        projectId: upd[0].projectId,
        runId: row.id,
        taskId: upd[0].taskId,
        actor: { type: "system", id: null },
        parentRunId: upd[0].parentRunId,
        payload: {
          runId: row.id,
          taskId: upd[0].taskId,
          flowId: upd[0].flowId,
          runKind: upd[0].runKind,
          reason: "PRECONDITION",
        },
      });

      return true;
    });

    if (!claimed) {
      log.debug(
        { runId: row.id, nodeId: row.currentStepId },
        "watchdog claim lost — run advanced concurrently; no ledger mutation",
      );

      return;
    }

    killed += 1;
    log.warn(
      { runId: row.id, nodeId: row.currentStepId, capMinutes: cap, elapsedMs },
      "watchdog terminated run past maxDurationMinutes cap",
    );

    // A maxDurationMinutes kill is a terminal transition that frees a scheduler
    // slot, exactly like a normal runner exit — promote the next Pending run so
    // queued work is not stranded. Mirrors runner-graph's promoteAfterExit.
    await promoteAfterTimeoutKill(db);
  });

  return killed;
}

// Promote the next Pending run after a watchdog kill freed a slot. Lazy-imports
// runFlow to avoid a static cycle (runner.ts → runGraph → keepalive sweep), the
// same pattern runner-graph's promoteAfterExit uses. Non-fatal: a failed
// promotion never blocks the kill that already committed.
async function promoteAfterTimeoutKill(db: Db): Promise<void> {
  try {
    const { runFlow } = await import("@/lib/flows/runner");

    await promoteNextPending({
      db,
      runFlow: (next: string) => {
        void runFlow(next).catch((err: unknown) =>
          log.error(
            {
              err: err instanceof Error ? err.message : String(err),
              runId: next,
            },
            "watchdog-promoted runFlow dispatch failed",
          ),
        );
      },
    });
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "watchdog promoteNextPending after kill failed (non-fatal)",
    );
  }
}

// --- Cost-budget governance: warn → escalate → terminate watchdog (ADR-101) --
// A multi-kind pass (flow | agent | scratch) over Running / WaitingOnChildren
// runs. For each ACTIVE budget scope (run always; task when task_id; tree when
// the run IS its tree root) it evaluates the token / failure / wall-clock meters
// against the effective ceilings (snapshot ⊕ raise-and-resume override) and acts
// on the HIGHEST rung that trips. Fail-OPEN: a run with no set/non-zero meter is
// never touched. The breach mechanism branches on run_kind BEFORE routing (D7).

const DEFAULT_BUDGET_HARD_MULTIPLIER = 1.25;
const DEFAULT_BUDGET_WARN_PCT = 80;

function budgetHardMultiplier(): number {
  const raw = process.env.MAISTER_BUDGET_HARD_MULTIPLIER;

  if (!raw) return DEFAULT_BUDGET_HARD_MULTIPLIER;
  const parsed = Number.parseFloat(raw);

  if (!Number.isFinite(parsed) || parsed <= 1) {
    return DEFAULT_BUDGET_HARD_MULTIPLIER;
  }

  return parsed;
}

type BudgetCandidate = {
  id: string;
  runKind: string;
  status: string;
  taskId: string | null;
  rootRunId: string | null;
  parentRunId: string | null;
  flowId: string | null;
  currentStepId: string | null;
  acpSessionId: string | null;
  executionPolicy: unknown;
  budgetState: {
    ceilingOverride?: BudgetAxis;
    notified?: Partial<Record<BudgetScope, BudgetRung>>;
  } | null;
  projectId: string | null;
};

async function fetchBudgetCandidates(db: Db): Promise<BudgetCandidate[]> {
  // No project join here: the project slug is needed only on the rare ESCALATE
  // path (for the needs-input.json artifact dir) and is resolved lazily there —
  // keeping this candidate query a plain runs scan (the same shape the other
  // passes use).
  const rows = await db
    .select({
      id: runs.id,
      runKind: runs.runKind,
      status: runs.status,
      taskId: runs.taskId,
      rootRunId: runs.rootRunId,
      parentRunId: runs.parentRunId,
      flowId: runs.flowId,
      currentStepId: runs.currentStepId,
      acpSessionId: runs.acpSessionId,
      executionPolicy: runs.executionPolicy,
      budgetState: runs.budgetState,
      projectId: runs.projectId,
    })
    .from(runs)
    .where(inArray(runs.status, ["Running", "WaitingOnChildren"]))
    .orderBy(asc(runs.startedAt))
    .limit(PER_TICK_LIMIT);

  return rows;
}

// Resolve the project slug for a candidate (lazy — only the escalate path needs
// it, for the needs-input.json directory). Returns null for a project-less run.
async function resolveProjectSlug(
  db: Db,
  projectId: string | null,
): Promise<string | null> {
  if (!projectId) return null;
  const rows = await db
    .select({ slug: projects.slug })
    .from(projects)
    .where(eq(projects.id, projectId));

  return rows[0]?.slug ?? null;
}

// effective(scope, meter) = ceilingOverride?.[scope]?.[meter] ?? snapshot[scope]?.[meter].
function effectiveLimit(
  snapshotBudget: BudgetAxis,
  override: BudgetAxis | undefined,
  scope: BudgetScope,
  meter: keyof BudgetLimits,
): number | null {
  const fromOverride = override?.[scope]?.[meter];

  if (typeof fromOverride === "number") return fromOverride;
  const fromSnapshot = snapshotBudget[scope]?.[meter];

  return typeof fromSnapshot === "number" ? fromSnapshot : null;
}

// A positive, finite limit is "set". 0 / null / negative = unlimited (fail-open).
function isSetLimit(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

type BudgetMeter = "tokens" | "failures" | "wallclock";

type BudgetVerdict = {
  rung: BudgetRung;
  scope: BudgetScope;
  meter: BudgetMeter;
  current: number;
  limit: number;
};

const RUNG_ORDER: Record<BudgetRung, number> = {
  warn: 1,
  escalate: 2,
  terminate: 3,
};

// Pure rung classifier for one meter against its effective ceilings. Returns the
// highest rung that trips, or null. `escalateLimit` is the 100% ceiling; for
// tokens an explicit OR computed (× multiplier) `hardLimit` is the terminate
// ceiling. failures / wallclock have NO terminate-multiplier — at/over the limit
// they ESCALATE (tree wallclock is force-promoted to terminate by the caller,
// since tree has no escalate rung).
function classifyMeter(args: {
  scope: BudgetScope;
  meter: BudgetMeter;
  current: number;
  escalateLimit: number;
  hardLimit: number | null;
  warnPct: number;
}): BudgetVerdict | null {
  const { scope, meter, current, escalateLimit, hardLimit, warnPct } = args;

  if (hardLimit !== null && current >= hardLimit) {
    return { rung: "terminate", scope, meter, current, limit: hardLimit };
  }
  if (current >= escalateLimit) {
    return { rung: "escalate", scope, meter, current, limit: escalateLimit };
  }
  const warnThreshold = (escalateLimit * warnPct) / 100;

  if (current >= warnThreshold) {
    return { rung: "warn", scope, meter, current, limit: escalateLimit };
  }

  return null;
}

function pickHigher(
  a: BudgetVerdict | null,
  b: BudgetVerdict | null,
): BudgetVerdict | null {
  if (!a) return b;
  if (!b) return a;

  return RUNG_ORDER[b.rung] > RUNG_ORDER[a.rung] ? b : a;
}

// Evaluate every active scope/meter for one candidate and return the single
// highest-rung verdict (or null = within budget). `evaluateTree` gates the tree
// scope to the tree ROOT only (this run is its own root_run_id) — a non-root
// member evaluates run/task. Tree scope is force-terminate (no escalate rung):
// a tree verdict at the escalate rung is promoted to terminate here.
async function evaluateBudgetForCandidate(
  db: Db,
  candidate: BudgetCandidate,
  snapshotBudget: BudgetAxis,
  override: BudgetAxis | undefined,
): Promise<BudgetVerdict | null> {
  const warnPct = (scope: BudgetScope): number => {
    const pct = effectiveLimit(snapshotBudget, override, scope, "warnAtPct");

    return isSetLimit(pct) ? pct : DEFAULT_BUDGET_WARN_PCT;
  };
  const multiplier = budgetHardMultiplier();
  let verdict: BudgetVerdict | null = null;
  // Run + task scope are evaluated ONLY for a Running candidate. A parked
  // WaitingOnChildren orchestrator (also a candidate, for tree eval) spends ~0
  // at run scope, and its run/task CAS guards on status='Running' — evaluating
  // them for a parked root would produce a verdict that the actor can never CAS
  // (0 rows → silent dead-end, re-evaluated forever). Task spend is still
  // enforced via any Running sibling of the task; tree scope (gated on the root
  // below) still covers the parked tree root.
  const runTaskActive = candidate.status === "Running";

  // --- run scope (Running candidate only) -----------------------------------
  const runTokenLimit = effectiveLimit(
    snapshotBudget,
    override,
    "run",
    "maxTokens",
  );

  if (runTaskActive && isSetLimit(runTokenLimit)) {
    const hard = effectiveLimit(
      snapshotBudget,
      override,
      "run",
      "hardMaxTokens",
    );
    const current = await queryRunTokens(candidate.id, { client: db });

    verdict = pickHigher(
      verdict,
      classifyMeter({
        scope: "run",
        meter: "tokens",
        current,
        escalateLimit: runTokenLimit,
        hardLimit: isSetLimit(hard) ? hard : runTokenLimit * multiplier,
        warnPct: warnPct("run"),
      }),
    );
  }

  const runFailLimit = effectiveLimit(
    snapshotBudget,
    override,
    "run",
    "consecutiveFailures",
  );

  if (runTaskActive && isSetLimit(runFailLimit)) {
    const current = await consecutiveFailedAttempts(candidate.id, {
      client: db,
    });

    verdict = pickHigher(
      verdict,
      classifyMeter({
        scope: "run",
        meter: "failures",
        current,
        escalateLimit: runFailLimit,
        hardLimit: null,
        warnPct: warnPct("run"),
      }),
    );
  }

  // --- task scope (Running candidate with a task_id) ------------------------
  if (runTaskActive && candidate.taskId) {
    const taskTokenLimit = effectiveLimit(
      snapshotBudget,
      override,
      "task",
      "maxTokens",
    );

    if (isSetLimit(taskTokenLimit)) {
      const hard = effectiveLimit(
        snapshotBudget,
        override,
        "task",
        "hardMaxTokens",
      );
      const current = await queryTaskTokens(candidate.taskId, { client: db });

      verdict = pickHigher(
        verdict,
        classifyMeter({
          scope: "task",
          meter: "tokens",
          current,
          escalateLimit: taskTokenLimit,
          hardLimit: isSetLimit(hard) ? hard : taskTokenLimit * multiplier,
          warnPct: warnPct("task"),
        }),
      );
    }

    const taskFailLimit = effectiveLimit(
      snapshotBudget,
      override,
      "task",
      "consecutiveFailures",
    );

    if (isSetLimit(taskFailLimit)) {
      const current = await consecutiveFailedRuns(
        { taskId: candidate.taskId },
        { client: db },
      );

      verdict = pickHigher(
        verdict,
        classifyMeter({
          scope: "task",
          meter: "failures",
          current,
          escalateLimit: taskFailLimit,
          hardLimit: null,
          warnPct: warnPct("task"),
        }),
      );
    }
  }

  // --- tree scope (only at the tree root: rootRunId === own id) --------------
  if (candidate.rootRunId === candidate.id) {
    const treeTokenLimit = effectiveLimit(
      snapshotBudget,
      override,
      "tree",
      "maxTokens",
    );

    if (isSetLimit(treeTokenLimit)) {
      const hard = effectiveLimit(
        snapshotBudget,
        override,
        "tree",
        "hardMaxTokens",
      );
      const current = await queryRunTreeTokens(candidate.id, { client: db });

      verdict = pickHigher(
        verdict,
        classifyMeter({
          scope: "tree",
          meter: "tokens",
          current,
          escalateLimit: treeTokenLimit,
          hardLimit: isSetLimit(hard) ? hard : treeTokenLimit * multiplier,
          warnPct: warnPct("tree"),
        }),
      );
    }

    const treeFailLimit = effectiveLimit(
      snapshotBudget,
      override,
      "tree",
      "consecutiveFailures",
    );

    if (isSetLimit(treeFailLimit)) {
      const current = await consecutiveFailedRuns(
        { rootRunId: candidate.id },
        { client: db },
      );

      verdict = pickHigher(
        verdict,
        classifyMeter({
          scope: "tree",
          meter: "failures",
          current,
          escalateLimit: treeFailLimit,
          hardLimit: null,
          warnPct: warnPct("tree"),
        }),
      );
    }

    const treeWallLimit = effectiveLimit(
      snapshotBudget,
      override,
      "tree",
      "wallClockMinutes",
    );

    if (isSetLimit(treeWallLimit)) {
      const current = await treeWallClockMinutes(candidate.id, { client: db });

      verdict = pickHigher(
        verdict,
        classifyMeter({
          scope: "tree",
          meter: "wallclock",
          current,
          escalateLimit: treeWallLimit,
          hardLimit: null,
          warnPct: warnPct("tree"),
        }),
      );
    }
  }

  // Tree scope has NO escalate rung — a parked WaitingOnChildren root has no
  // → NeedsInput transition. A tree verdict at the escalate rung is promoted to
  // terminate (spec §4: tree breach goes straight to terminate-cascade).
  if (verdict && verdict.scope === "tree" && verdict.rung === "escalate") {
    return { ...verdict, rung: "terminate" };
  }

  return verdict;
}

// Idempotency: skip a WARN when this scope is already at warn-or-higher. The
// run is still Running so it remains a candidate every tick — without this it
// would re-warn forever. Escalate/terminate are also status-derived
// (NeedsInput/Failed runs are not candidates), but notified is set in the same
// write so the rung is durable.
function alreadyActioned(
  budgetState: BudgetCandidate["budgetState"],
  scope: BudgetScope,
  rung: BudgetRung,
): boolean {
  const prior = budgetState?.notified?.[scope];

  if (!prior) return false;

  return RUNG_ORDER[prior] >= RUNG_ORDER[rung];
}

// Merge a single notified[scope]=rung into the existing budget_state WITHOUT
// clobbering ceilingOverride or other scopes' rungs.
function mergedBudgetState(
  prior: BudgetCandidate["budgetState"],
  scope: BudgetScope,
  rung: BudgetRung,
): {
  ceilingOverride?: BudgetAxis;
  notified: Partial<Record<BudgetScope, BudgetRung>>;
} {
  return {
    ...(prior?.ceilingOverride
      ? { ceilingOverride: prior.ceilingOverride }
      : {}),
    notified: { ...(prior?.notified ?? {}), [scope]: rung },
  };
}

function budgetBreachPrompt(v: BudgetVerdict): string {
  return `Budget breach: ${v.scope} ${v.meter} reached ${v.current} of ${v.limit}. Raise the ceiling and resume, or abandon the run.`;
}

function budgetBreachSchema(v: BudgetVerdict): Record<string, unknown> {
  return {
    kind: "budget_breach",
    scope: v.scope,
    meter: v.meter,
    current: v.current,
    limit: v.limit,
    decisions: ["raise", "abandon"],
  };
}

// WARN: record the breach + set notified[scope]=warn (CAS-guarded on Running so
// a concurrent terminal flip is never overwritten). Run continues.
async function actBudgetWarn(
  db: Db,
  candidate: BudgetCandidate,
  verdict: BudgetVerdict,
): Promise<boolean> {
  const next = mergedBudgetState(candidate.budgetState, verdict.scope, "warn");
  const upd = await db
    .update(runs)
    .set({ budgetState: next })
    .where(and(eq(runs.id, candidate.id), eq(runs.status, "Running")))
    .returning({ id: runs.id });

  if (upd.length === 0) return false;

  logExecPolicyAction({
    runId: candidate.id,
    kind: "budget_warned",
    detail: {
      scope: verdict.scope,
      meter: verdict.meter,
      current: verdict.current,
      limit: verdict.limit,
    },
  });
  log.info(
    { runId: candidate.id, scope: verdict.scope, meter: verdict.meter },
    "[budget] warn band entered",
  );

  return true;
}

// Find the live supervisor session for a candidate by the server-owned
// (runId, stepId) — the same identity the time-limit pass keys on (acp_session_id
// is null exactly during the long/over-cap window).
function liveRecordFor(
  records: SupervisorSessionRecord[],
  candidate: BudgetCandidate,
): SupervisorSessionRecord | undefined {
  return records.find(
    (r) =>
      r.status === "live" &&
      r.runId === candidate.id &&
      r.stepId === candidate.currentStepId,
  );
}

// ESCALATE (run/task scope only): halt the live session so spend stops
// (checkpoint), then pause to NeedsInput with a budget_breach HITL in ONE tx,
// branching on run_kind. Worktree KEPT. EXECUTOR_UNAVAILABLE on the checkpoint
// leaves the run live for the next tick (no split-brain). Returns true on pause.
async function actBudgetEscalate(
  db: Db,
  records: SupervisorSessionRecord[],
  candidate: BudgetCandidate,
  verdict: BudgetVerdict,
): Promise<boolean> {
  const live = liveRecordFor(records, candidate);

  if (live) {
    try {
      await checkpointSession(live.sessionId);
    } catch (err) {
      if (isMaisterError(err) && err.code === "EXECUTOR_UNAVAILABLE") {
        log.warn(
          { runId: candidate.id, err: err.message },
          "[budget] escalate checkpoint 5xx — leaving live for next tick",
        );

        return false;
      }
      log.warn(
        {
          runId: candidate.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "[budget] escalate checkpoint terminal failure — session unrecoverable, proceeding to pause",
      );
    }
  }

  const stepId = candidate.currentStepId ?? "budget";
  const schema = budgetBreachSchema(verdict);
  const prompt = budgetBreachPrompt(verdict);
  const hitlRequestId = randomUUID();
  // The needs-input.json artifact is written BEFORE the tx (mirrors the
  // escalateAutoRetryExhaustion template) and unlinked if the tx fails. The slug
  // is resolved lazily (escalate is the only path that needs it).
  const projectSlug = await resolveProjectSlug(db, candidate.projectId);
  const needsInputPath = projectSlug
    ? path.join(
        runDirPath(configuredRuntimeRoot(), projectSlug, candidate.id),
        "needs-input.json",
      )
    : null;

  // For a flow run, the active node attempt is moved to NeedsInput so a resume
  // re-enters it; agent / scratch have no node attempt.
  const attempt =
    candidate.runKind === "flow" && candidate.currentStepId
      ? await fetchActiveAttempt(db, candidate.id, candidate.currentStepId)
      : null;

  if (needsInputPath) {
    await atomicWriteJson(needsInputPath, {
      nodeId: stepId,
      kind: "budget_breach",
      schema,
      prompt,
      requestedAt: new Date().toISOString(),
    });
  }

  let paused = false;

  try {
    paused = await db.transaction(async (tx: Db) => {
      const upd = await tx
        .update(runs)
        .set({
          status: "NeedsInput",
          budgetState: mergedBudgetState(
            candidate.budgetState,
            verdict.scope,
            "escalate",
          ),
        })
        // Escalate is a run/task verdict, only ever reached for a Running
        // candidate (Fix A) — CAS on the EXACT observed status. A parked
        // WaitingOnChildren root has no → NeedsInput resume route, so it must
        // never be paused here even defensively.
        .where(and(eq(runs.id, candidate.id), eq(runs.status, "Running")))
        .returning({ id: runs.id, projectId: runs.projectId });

      if (upd.length === 0) return false;

      if (attempt) {
        await markNodeNeedsInput(attempt.id, tx);
      }

      await tx.insert(hitlRequests).values({
        id: hitlRequestId,
        runId: candidate.id,
        stepId,
        kind: "budget_breach",
        schema,
        prompt,
      });

      // Scratch dialog status moves with the run (the dialog surface reads it).
      if (candidate.runKind === "scratch") {
        const { scratchRuns } = schemaModule as unknown as Record<string, any>;

        await tx
          .update(scratchRuns)
          .set({ dialogStatus: "NeedsInput", updatedAt: new Date() })
          .where(eq(scratchRuns.runId, candidate.id));
      }

      // Route the breach to a human only when the run is project-scoped (an
      // assignment needs a project). A project-less local-package run never
      // reaches here (it carries no budget axis), but guard anyway.
      if (upd[0].projectId) {
        await createHitlAssignmentForRun({
          db: tx,
          runId: candidate.id,
          hitlRequestId,
          nodeId: stepId,
          actionKind: "budget_breach",
          roleRefs: [],
          title: prompt,
        });
        await emitWebhookEvent({
          db: tx,
          type: "run.needs_input",
          projectId: upd[0].projectId,
          runId: candidate.id,
          data: { reason: "budget_breach", nodeId: stepId },
        });
      }

      return true;
    });
  } catch (err) {
    if (needsInputPath) {
      await unlink(needsInputPath).catch(() => undefined);
    }
    throw err;
  }

  if (!paused) {
    if (needsInputPath) {
      await unlink(needsInputPath).catch(() => undefined);
    }
    log.debug(
      { runId: candidate.id },
      "[budget] escalate claim lost — run advanced concurrently",
    );

    return false;
  }

  // run.escalated emitted AFTER the pause commit (best-effort notification, not
  // bound to the idempotent state transition).
  if (candidate.projectId) {
    const meter = { scope: verdict.scope, meter: verdict.meter };

    await emitDomainEvent({
      db,
      kind: "run.escalated",
      projectId: candidate.projectId,
      runId: candidate.id,
      taskId: candidate.taskId,
      actor: { type: "system", id: null },
      payload: {
        runId: candidate.id,
        reason: "budget_exceeded",
        scope: verdict.scope,
        meter,
      },
    });
    await emitWebhookEvent({
      db,
      type: "run.escalated",
      projectId: candidate.projectId,
      runId: candidate.id,
      data: { reason: "budget_exceeded", scope: verdict.scope, meter },
    });
  }

  logExecPolicyAction({
    runId: candidate.id,
    kind: "budget_escalated",
    detail: {
      scope: verdict.scope,
      meter: verdict.meter,
      current: verdict.current,
      limit: verdict.limit,
    },
  });
  log.warn(
    { runId: candidate.id, scope: verdict.scope, meter: verdict.meter },
    "[budget] escalated → NeedsInput (budget_breach HITL)",
  );

  return true;
}

// TERMINATE (run/task scope → terminate the offending run): mirror
// runTimeLimitPass — match the live session, deleteSession (EXECUTOR_UNAVAILABLE
// → leave Running for next tick; 404 → proceed), CAS the run terminal, then the
// per-run_kind terminal in the SAME tx. NEVER mark terminal before deleteSession
// confirms stopped/absent.
async function actBudgetTerminateRun(
  db: Db,
  records: SupervisorSessionRecord[],
  candidate: BudgetCandidate,
  verdict: BudgetVerdict,
): Promise<boolean> {
  const live = liveRecordFor(records, candidate);

  if (live) {
    try {
      await deleteSession(live.sessionId);
    } catch (err) {
      if (isMaisterError(err) && err.code === "EXECUTOR_UNAVAILABLE") {
        log.warn(
          { runId: candidate.id, err: err.message },
          "[budget] terminate deleteSession 5xx — leaving Running for next tick",
        );

        return false;
      }
      log.warn(
        {
          runId: candidate.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "[budget] terminate deleteSession terminal failure — session unrecoverable, proceeding",
      );
    }
  }

  const notified = mergedBudgetState(
    candidate.budgetState,
    verdict.scope,
    "terminate",
  );

  // agent: the canonical agent terminal finalizer owns the CAS + HITL close +
  // run.failed emits + promote. No separate budget_state pre-stamp — the
  // terminal status IS the idempotency (a Failed run is not a candidate next
  // tick, so notified.terminate is never read); pre-stamping before a finalize
  // that can lose the status race would strand the run.
  if (candidate.runKind === "agent") {
    const { finalizeAgentRun } = await import("@/lib/agents/launch");
    const result = await finalizeAgentRun(candidate.id, "Failed", {
      db,
      reason: "budget_breach",
      closeOpenHitl: true,
      closeAssignments: { kind: "system", reason: "budget_breach" },
    });

    if (!result.finalized) {
      log.debug(
        { runId: candidate.id },
        "[budget] agent terminate finalize mismatch — concurrent transition won",
      );

      return false;
    }
    logBudgetTerminated(candidate, verdict);

    return true;
  }

  // scratch: a budget-kill is a DELIBERATE terminal, so it must be
  // NON-recoverable — `terminal:"failed"` sets runs.status=`Failed` (Recover
  // gates on runs.status='Crashed', so Failed structurally disables it) and emits
  // run.failed, matching flow/agent. The scratch dialog FSM has no Failed state,
  // so scratch_runs.dialog_status stays `Crashed` (the scratch-UI terminal) with
  // error_code=BUDGET_EXCEEDED. markScratchCrashed's own CAS is the idempotency
  // — no budget_state pre-stamp (terminal status is never re-evaluated).
  if (candidate.runKind === "scratch") {
    const { markScratchCrashed } = await import("@/lib/scratch-runs/service");

    await markScratchCrashed({
      db,
      runId: candidate.id,
      err: new MaisterError("BUDGET_EXCEEDED", budgetBreachPrompt(verdict)),
      clearSupervisorSession: true,
      terminal: "failed",
    });
    await promoteAfterTimeoutKill(db);
    logBudgetTerminated(candidate, verdict);

    return true;
  }

  // flow: CAS Failed + markNodeFailed(BUDGET_EXCEEDED) + close assignments +
  // run.failed (webhook + domain) all in ONE tx, guarded on Running + the same
  // node (a concurrently-advanced run matches zero rows → no ledger clobber).
  // The flow arm sets budget_state.notified INSIDE the atomic CAS tx (safe —
  // same row, same transaction as the terminal flip).
  const attempt = candidate.currentStepId
    ? await fetchActiveAttempt(db, candidate.id, candidate.currentStepId)
    : null;
  const claimed: boolean = await db.transaction(async (tx: Db) => {
    const upd = await tx
      .update(runs)
      .set({
        status: "Failed",
        endedAt: new Date(),
        currentStepId: null,
        budgetState: notified,
      })
      .where(
        and(
          eq(runs.id, candidate.id),
          eq(runs.status, "Running"),
          candidate.currentStepId
            ? eq(runs.currentStepId, candidate.currentStepId)
            : isNull(runs.currentStepId),
        ),
      )
      .returning({
        id: runs.id,
        projectId: runs.projectId,
        taskId: runs.taskId,
        flowId: runs.flowId,
        runKind: runs.runKind,
        parentRunId: runs.parentRunId,
      });

    if (upd.length === 0) return false;

    if (attempt) {
      await markNodeFailed(attempt.id, { errorCode: "BUDGET_EXCEEDED" }, tx);
    }
    await systemCloseActiveAssignmentsForRun({
      db: tx,
      runId: candidate.id,
      reason: "budget exceeded",
    });

    if (upd[0].projectId) {
      await emitWebhookEvent({
        db: tx,
        type: "run.failed",
        projectId: upd[0].projectId,
        runId: candidate.id,
        data: { errorCode: "BUDGET_EXCEEDED" },
      });
      await emitDomainEvent({
        db: tx,
        kind: "run.failed",
        projectId: upd[0].projectId,
        runId: candidate.id,
        taskId: upd[0].taskId,
        actor: { type: "system", id: null },
        parentRunId: upd[0].parentRunId,
        payload: {
          runId: candidate.id,
          taskId: upd[0].taskId,
          flowId: upd[0].flowId,
          runKind: upd[0].runKind,
          reason: "BUDGET_EXCEEDED",
        },
      });
    }

    return true;
  });

  if (!claimed) {
    log.debug(
      { runId: candidate.id, nodeId: candidate.currentStepId },
      "[budget] flow terminate claim lost — run advanced concurrently",
    );

    return false;
  }
  await promoteAfterTimeoutKill(db);
  logBudgetTerminated(candidate, verdict);

  return true;
}

// TREE-scope TERMINATE: cascade-abandon the whole sub-tree (children-first, one
// tx, per-pool promote) then flip the root terminal. cascadeAbandonRunTree does
// NOT touch the root, so the root is flipped here (Failed for flow/agent; the
// scratch finalizer is never a tree root).
async function actBudgetTerminateTree(
  db: Db,
  candidate: BudgetCandidate,
  verdict: BudgetVerdict,
): Promise<boolean> {
  await cascadeAbandonRunTree(
    candidate.id,
    candidate.taskId,
    "budget_exceeded",
    { db },
  );

  const notified = mergedBudgetState(
    candidate.budgetState,
    "tree",
    "terminate",
  );
  const upd: Array<{
    id: string;
    projectId: string | null;
    taskId: string | null;
    flowId: string | null;
    runKind: string;
    parentRunId: string | null;
  }> = await db.transaction(async (tx: Db) => {
    const rows = await tx
      .update(runs)
      .set({
        status: "Failed",
        endedAt: new Date(),
        currentStepId: null,
        budgetState: notified,
      })
      .where(
        and(
          eq(runs.id, candidate.id),
          inArray(runs.status, ["Running", "WaitingOnChildren"]),
        ),
      )
      .returning({
        id: runs.id,
        projectId: runs.projectId,
        taskId: runs.taskId,
        flowId: runs.flowId,
        runKind: runs.runKind,
        parentRunId: runs.parentRunId,
      });

    if (rows.length === 0) return [];

    await systemCloseActiveAssignmentsForRun({
      db: tx,
      runId: candidate.id,
      reason: "budget exceeded (tree)",
    });

    if (rows[0].projectId) {
      await emitWebhookEvent({
        db: tx,
        type: "run.failed",
        projectId: rows[0].projectId,
        runId: candidate.id,
        data: { errorCode: "BUDGET_EXCEEDED" },
      });
      await emitDomainEvent({
        db: tx,
        kind: "run.failed",
        projectId: rows[0].projectId,
        runId: candidate.id,
        taskId: rows[0].taskId,
        actor: { type: "system", id: null },
        parentRunId: rows[0].parentRunId,
        payload: {
          runId: candidate.id,
          taskId: rows[0].taskId,
          flowId: rows[0].flowId,
          runKind: rows[0].runKind,
          reason: "BUDGET_EXCEEDED",
        },
      });
    }

    return rows;
  });

  if (upd.length === 0) {
    log.debug(
      { runId: candidate.id },
      "[budget] tree-root flip claim lost — concurrent transition won",
    );

    return false;
  }
  await promoteAfterTimeoutKill(db);
  logBudgetTerminated(candidate, verdict);

  return true;
}

function logBudgetTerminated(
  candidate: BudgetCandidate,
  verdict: BudgetVerdict,
): void {
  logExecPolicyAction({
    runId: candidate.id,
    kind: "budget_terminated",
    detail: {
      scope: verdict.scope,
      meter: verdict.meter,
      current: verdict.current,
      limit: verdict.limit,
    },
  });
  log.warn(
    {
      runId: candidate.id,
      scope: verdict.scope,
      meter: verdict.meter,
      runKind: candidate.runKind,
    },
    "[budget] terminated run past hard ceiling",
  );
}

async function runBudgetPass(db: Db): Promise<number> {
  const candidates = await fetchBudgetCandidates(db);

  if (candidates.length === 0) return 0;

  const records = await loadSupervisorSessionRecords();

  if (records === null) {
    log.warn(
      { candidateCount: candidates.length },
      "budget watchdog aborted — listSessions failed; leaving candidates for next tick",
    );

    return 0;
  }

  let acted = 0;

  await runWithConcurrency(
    candidates,
    PER_PASS_CONCURRENCY,
    async (candidate) => {
      const snapshotBudget = budgetFromSnapshot(candidate.executionPolicy);
      const override = candidate.budgetState?.ceilingOverride;

      // Fail-OPEN fast path: no scope carries any positive meter → never touch.
      const anySet = (["run", "task", "tree"] as const).some((scope) =>
        (
          [
            "maxTokens",
            "hardMaxTokens",
            "consecutiveFailures",
            "wallClockMinutes",
          ] as const
        ).some((meter) =>
          isSetLimit(effectiveLimit(snapshotBudget, override, scope, meter)),
        ),
      );

      if (!anySet) return;

      // Force-reconcile the candidate run's rollups before reading (throttled to
      // a stale source cursor would avoid disk I/O across a large tree; the
      // correct-first version reconciles the candidate run each evaluation, a
      // no-op `missing-cost-file` when nothing is on disk). Task/tree member runs
      // are read from their existing rollups (reconciled by their own candidacy /
      // the runner's write path) — see spec E11 throttle note.
      try {
        await reconcileRunCostRollups(candidate.id, { client: db });
      } catch (err) {
        log.warn(
          {
            runId: candidate.id,
            err: err instanceof Error ? err.message : String(err),
          },
          "[budget] reconcile before read failed — evaluating on existing rollups",
        );
      }

      const verdict = await evaluateBudgetForCandidate(
        db,
        candidate,
        snapshotBudget,
        override,
      );

      if (!verdict) return;
      if (alreadyActioned(candidate.budgetState, verdict.scope, verdict.rung)) {
        return;
      }

      let didAct = false;

      if (verdict.rung === "warn") {
        didAct = await actBudgetWarn(db, candidate, verdict);
      } else if (verdict.rung === "escalate") {
        // escalate only reaches run/task scope (tree escalate was promoted to
        // terminate in evaluateBudgetForCandidate).
        didAct = await actBudgetEscalate(db, records, candidate, verdict);
      } else if (verdict.scope === "tree") {
        didAct = await actBudgetTerminateTree(db, candidate, verdict);
      } else {
        didAct = await actBudgetTerminateRun(db, records, candidate, verdict);
      }

      if (didAct) acted += 1;
    },
  );

  return acted;
}

export type SweepResult = {
  scannedRunsCount: number;
  idledCount: number;
  abandonedCount: number;
  killedCount: number;
  budgetActedCount: number;
};

export async function runSweepTick(
  opts: { db?: Db } = {},
): Promise<SweepResult> {
  const db = opts.db ?? getDb();
  const idledCount = await runPass1(db);
  const abandonedCount = await runPass2(db);
  const killedCount = await runTimeLimitPass(db);
  const budgetActedCount = await runBudgetPass(db);
  const scannedRunsCount =
    idledCount + abandonedCount + killedCount + budgetActedCount;

  log.info(
    {
      scannedRunsCount,
      idledCount,
      abandonedCount,
      killedCount,
      budgetActedCount,
      sweepIntervalSeconds: sweepIntervalSeconds(),
    },
    "sweeper tick complete",
  );

  return {
    scannedRunsCount,
    idledCount,
    abandonedCount,
    killedCount,
    budgetActedCount,
  };
}

// Singleton on globalThis so Next.js HMR does not multiply timers. The
// sweeper is a server-only side-effect; UI never touches it.
type GlobalSweeperState = {
  handle: NodeJS.Timeout | null;
  intervalSeconds: number;
};

const SWEEPER_GLOBAL_KEY = Symbol.for("maister.keepalive-sweeper.v1");

function globalState(): GlobalSweeperState {
  const g = globalThis as unknown as Record<symbol, GlobalSweeperState>;

  if (!g[SWEEPER_GLOBAL_KEY]) {
    g[SWEEPER_GLOBAL_KEY] = { handle: null, intervalSeconds: 0 };
  }

  return g[SWEEPER_GLOBAL_KEY];
}

export function startKeepaliveSweeper(): void {
  const state = globalState();
  const intervalSeconds = sweepIntervalSeconds();

  if (state.handle) {
    if (state.intervalSeconds === intervalSeconds) {
      log.debug(
        { intervalSeconds },
        "startKeepaliveSweeper: already running with the same interval — no-op",
      );

      return;
    }
    log.info(
      {
        prevIntervalSeconds: state.intervalSeconds,
        intervalSeconds,
      },
      "startKeepaliveSweeper: interval changed — restarting timer",
    );
    clearInterval(state.handle);
    state.handle = null;
  }

  state.intervalSeconds = intervalSeconds;
  state.handle = setInterval(() => {
    void runSweepTick().catch((err: unknown) => {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "sweeper tick threw — continuing on next interval",
      );
    });
  }, intervalSeconds * 1_000);
  state.handle.unref?.();
  log.info(
    { intervalSeconds, perTickLimit: PER_TICK_LIMIT },
    "keepalive-sweeper started",
  );
}

export function stopKeepaliveSweeper(): void {
  const state = globalState();

  if (state.handle) {
    clearInterval(state.handle);
    state.handle = null;
    log.info({}, "keepalive-sweeper stopped");
  }
}
