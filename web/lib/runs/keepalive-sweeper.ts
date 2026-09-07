import "server-only";

import type { FlowYamlV1 } from "@/lib/config.schema";
import type { DelegationBounds } from "@/lib/run-results/types";

import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import path from "node:path";

import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  notExists,
  notInArray,
  or,
} from "drizzle-orm";
import pino from "pino";

import { markCheckpointed } from "./state-transitions";

import { atomicWriteJson } from "@/lib/atomic";
import {
  createHitlAssignmentForRun,
  systemCloseActiveAssignmentsForRun,
} from "@/lib/assignments/service";
import { getDb } from "@/lib/db/client";
import { loadActiveRunSessionsByRunId } from "@/lib/runs/active-run-session";
import * as schemaModule from "@/lib/db/schema";
import { RUN_SYNC_TERMINAL_PHASES, agentTurns } from "@/lib/db/schema";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { compileManifest } from "@/lib/flows/graph/compile";
import { markNodeFailed, markNodeNeedsInput } from "@/lib/flows/graph/ledger";
import { loadRunManifest } from "@/lib/queries/run-manifest";
import { runtimeRoot as configuredRuntimeRoot } from "@/lib/instance-config";
import { cascadeAbandonRunTreeAndStopSessions } from "@/lib/orchestrator/cascade";
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
  onBudgetBreachFromSnapshot,
  DEFAULT_BUDGET_WARN_PCT,
  type BudgetAxis,
  type BudgetLimits,
  type BudgetRung,
  type BudgetScope,
  type OnBudgetBreach,
} from "@/lib/runs/execution-policy";
import { logExecPolicyAction } from "@/lib/runs/exec-policy-audit";
import { runDirPath } from "@/lib/flows/graph/mutation-check";
import { promoteNextPending, releaseSlotOnIdle } from "@/lib/scheduler";
import {
  createExecutionHosts,
  isFencedError,
  releaseAssignmentForRun,
  type BoundClient,
  type ExecutionHosts,
  type SupervisorSessionRecord,
} from "@/lib/execution-host";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";
import { captureAgentPauseSource } from "@/lib/execution-host/agent-pause-source";
import {
  isAgentPermissionPause,
  supersedeAgentPausePermissions,
} from "@/lib/execution-host/agent-pause-permissions";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { hitlRequests, nodeAttempts, projects, runs, runSyncAttempts } =
  schemaModule as unknown as Record<string, any>;

// ADR-141: a run with a non-terminal `run_sync_attempts` row is owned
// by the branch-sync recovery path — NO keepalive pass may idle, checkpoint, or
// kill it. This correlated `NOT EXISTS` excludes such runs.
//
// It MUST be applied to Pass1/Pass2 as well as the Running watchdogs. An earlier
// note here reasoned that "Pass1/Pass2 select NeedsInput/NeedsInputIdle only, so
// a mid-sync Running run is invisible there" — that was WRONG in the one
// direction that matters: a resolver permission_request parks the run at exactly
// `NeedsInput` (see sync-resolver.ts persistResolverPermission) while its attempt
// stays `agent_running`. Pass1 would then idle it to `NeedsInputIdle`, after
// which the respond path's `NeedsInput`-guarded flip-back and the resolver's
// `Running`-guarded finalize BOTH silently no-op — stranding a fully synced run
// until Pass2 abandons it, and leaking the sync claim forever.
function excludeActiveSyncAttempt(db: Db) {
  return notExists(
    db
      .select({ id: runSyncAttempts.id })
      .from(runSyncAttempts)
      .where(
        and(
          eq(runSyncAttempts.runId, runs.id),
          notInArray(runSyncAttempts.phase, [...RUN_SYNC_TERMINAL_PHASES]),
        ),
      ),
  );
}

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

// ADR-166: the live host session for the candidate's CURRENT node, read through
// the client bound to the run's assignment. Matching by (runId, stepId) keeps
// the "only the exact capped node's session" rule; a lookup failure is the
// caller's "leave for the next tick" signal.
async function liveSessionFor(
  client: BoundClient,
  stepId: string | null,
): Promise<SupervisorSessionRecord | undefined> {
  const records = await client.sessionsForRun();

  return records.find((r) => r.status === "live" && r.stepId === stepId);
}

type Pass1Candidate = {
  id: string;
  hostSessionId: string | null;
};

async function fetchPass1Candidates(db: Db): Promise<Pass1Candidate[]> {
  const now = new Date();
  const rows = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.status, "NeedsInput"),
        isNotNull(runs.keepaliveUntil),
        lt(runs.keepaliveUntil, now),
        // A resolver parked on a permission_request lives at exactly this status.
        excludeActiveSyncAttempt(db),
      ),
    )
    .orderBy(asc(runs.keepaliveUntil))
    .limit(PER_TICK_LIMIT);

  // M42 (ADR-114): the checkpoint handle comes from the run's ACTIVE session —
  // the host's own session id (ADR-166), written by the create ack.
  const activeByRun = await loadActiveRunSessionsByRunId(
    db,
    rows.map((row: { id: string }) => row.id),
  );

  return rows.map((row: { id: string }) => ({
    id: row.id,
    hostSessionId: activeByRun.get(row.id)?.hostSessionId ?? null,
  }));
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
        // Defense in depth: Pass1 can no longer idle a mid-sync run into this
        // status, but never abandon one that somehow reached it.
        excludeActiveSyncAttempt(db),
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

async function runPass1(db: Db, hosts: ExecutionHosts): Promise<number> {
  const candidates = await fetchPass1Candidates(db);

  if (candidates.length === 0) return 0;

  let idled = 0;

  await runWithConcurrency(candidates, PER_PASS_CONCURRENCY, async (row) => {
    if (row.hostSessionId) {
      // Checkpoint under the run's assignment. An unknown outcome (5xx /
      // unreachable) must NOT idle the row: the agent may still be alive holding
      // the permission deferred while the DB would say the slot is free
      // (split-brain) — leave it for the next tick. A definitive refusal (404,
      // or a fence from a newer driver generation) means this session is no
      // longer ours to hold: proceed to markCheckpointed.
      try {
        const client = await hosts.forRun(row.id);

        await client.checkpoint(row.hostSessionId);
      } catch (err) {
        if (isMaisterError(err) && err.code === "EXECUTOR_UNAVAILABLE") {
          log.warn(
            { runId: row.id, err: err.message },
            "sweeper pass1 supervisor 5xx — retry on next tick",
          );

          return;
        }
        if (isFencedError(err)) {
          log.warn(
            { runId: row.id, hostSessionId: row.hostSessionId },
            "sweeper pass1 checkpoint fenced — a newer driver generation owns the session; proceeding to markCheckpointed",
          );
        } else {
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
      }
    } else {
      log.info(
        { runId: row.id },
        "sweeper pass1 no host session recorded — marking checkpointed directly",
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

      await releaseAssignmentForRun(tx, row.id, "abandoned");

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
};

async function fetchTimeLimitCandidates(db: Db): Promise<TimeLimitCandidate[]> {
  const rows = await db
    .select({
      id: runs.id,
      flowId: runs.flowId,
      flowRevisionId: runs.flowRevisionId,
      currentStepId: runs.currentStepId,
    })
    .from(runs)
    .where(
      and(
        eq(runs.status, "Running"),
        eq(runs.runKind, "flow"),
        isNotNull(runs.currentStepId),
        excludeActiveSyncAttempt(db),
      ),
    )
    // No session filter: a capped node that hangs before its session is
    // recorded must still be killable. deleteSession is best-effort (skipped
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
  const loaded = await loadRunManifest(candidate.id, db);

  return loaded?.compatible ? loaded.manifest : null;
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
async function runTimeLimitPass(
  db: Db,
  hosts: ExecutionHosts,
): Promise<number> {
  const candidates = await fetchTimeLimitCandidates(db);

  if (candidates.length === 0) return 0;

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

    // Match the live host session by the server-owned (runId, stepId) through
    // the run's bound client: only the EXACT capped node's session is torn
    // down, never a later node's live session. When the host cannot be asked
    // we cannot distinguish "gone" from "unreachable" — leave the run Running
    // for the next tick rather than mark it Failed with a live agent.
    let client: BoundClient;
    let live: SupervisorSessionRecord | undefined;

    try {
      client = await hosts.forRun(row.id, { teardown: true });
      live = await liveSessionFor(client, row.currentStepId);
    } catch (err) {
      log.warn(
        {
          runId: row.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "watchdog host lookup failed — leaving Running for next tick",
      );

      return;
    }

    if (live) {
      try {
        await client.deleteSession(live.sessionId);
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
        // A fence means a newer driver generation took the run over between
        // the candidate scan and the kill: it is not ours to terminate.
        if (isFencedError(err)) {
          log.warn(
            { runId: row.id },
            "watchdog deleteSession fenced — a newer driver generation owns the run; skipping",
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

      await releaseAssignmentForRun(tx, row.id, "failed");
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

/** True when any run points at `runId` as its parent — i.e. it is a real tree. */
async function hasDescendants(db: Db, runId: string): Promise<boolean> {
  const rows = (await db
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.parentRunId, runId))
    .limit(1)) as { id: string }[];

  return rows.length > 0;
}

// --- Cost-budget governance: warn → escalate → terminate watchdog (ADR-101) --
// A multi-kind pass (flow | agent | scratch) over Running / WaitingOnChildren
// runs. For each ACTIVE budget scope (run always; task when task_id; tree when
// the run IS its tree root) it evaluates the token / failure / wall-clock meters
// against the effective ceilings (snapshot ⊕ raise-and-resume override) and acts
// on the HIGHEST rung that trips. Fail-OPEN: a run with no set/non-zero meter is
// never touched. The breach mechanism branches on run_kind BEFORE routing (D7).

const DEFAULT_BUDGET_HARD_MULTIPLIER = 1.25;

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
  executionPolicy: unknown;
  // ADR-165 (D8/T6.4): the ROOT's effective delegation bounds. Its `budget` is
  // min-merged into the tree meters below. NULL = env-only, so the policy's
  // limits are the only ones.
  delegationBounds: DelegationBounds | null;
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
      delegationBounds: runs.delegationBounds,
      parentRunId: runs.parentRunId,
      flowId: runs.flowId,
      currentStepId: runs.currentStepId,
      executionPolicy: runs.executionPolicy,
      budgetState: runs.budgetState,
      projectId: runs.projectId,
    })
    .from(runs)
    .where(
      and(
        inArray(runs.status, ["Running", "WaitingOnChildren"]),
        excludeActiveSyncAttempt(db),
      ),
    )
    .orderBy(asc(runs.startedAt))
    .limit(PER_TICK_LIMIT);

  return rows;
}

function hasConfiguredBudgetMeter(candidate: BudgetCandidate): boolean {
  const snapshotBudget = budgetFromSnapshot(candidate.executionPolicy);
  const override = candidate.budgetState?.ceilingOverride;

  return (["run", "task", "tree"] as const).some((scope) =>
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
}

async function budgetReconciliationRunIds(
  db: Db,
  candidates: readonly BudgetCandidate[],
): Promise<string[]> {
  const budgeted = candidates.filter(hasConfiguredBudgetMeter);
  const runIds = new Set(budgeted.map((candidate) => candidate.id));
  const taskIds = [
    ...new Set(
      budgeted
        .map((candidate) => candidate.taskId)
        .filter((taskId): taskId is string => taskId !== null),
    ),
  ];
  const rootRunIds = budgeted
    .filter((candidate) => candidate.parentRunId === null)
    .map((candidate) => candidate.id);

  if (taskIds.length > 0) {
    const taskRuns = await db
      .select({ id: runs.id })
      .from(runs)
      .where(inArray(runs.taskId, taskIds));

    for (const run of taskRuns) runIds.add(run.id);
  }

  if (rootRunIds.length > 0) {
    const treeRuns = await db
      .select({ id: runs.id })
      .from(runs)
      .where(
        or(inArray(runs.id, rootRunIds), inArray(runs.rootRunId, rootRunIds)),
      );

    for (const run of treeRuns) runIds.add(run.id);
  }

  return [...runIds];
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
export function effectiveLimit(
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
export function isSetLimit(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

// Token escalate + terminate ceilings for one scope, accounting for a
// raise-and-resume override. The terminate (hard) ceiling RE-DERIVES from the
// effective maxTokens × multiplier whenever the winning maxTokens came from a
// raise override that did NOT also set hardMaxTokens — otherwise a run whose
// escalate ceiling was raised would still hard-terminate at the stale snapshot
// hard band, so the raise would buy almost nothing. Precedence for hard:
//   1. an explicit override hardMaxTokens (a raise that set it) always wins;
//   2. else, if a raise lifted maxTokens, hard = raised × multiplier;
//   3. else (maxTokens from the snapshot) the snapshot hardMaxTokens, or the
//      computed maxTokens × multiplier when no explicit hard exists.
// Returns null when the scope has no positive maxTokens (nothing to enforce).
function tokenCeilings(
  snapshotBudget: BudgetAxis,
  override: BudgetAxis | undefined,
  scope: BudgetScope,
  multiplier: number,
): { escalateLimit: number; hardLimit: number } | null {
  const escalateLimit = effectiveLimit(
    snapshotBudget,
    override,
    scope,
    "maxTokens",
  );

  if (!isSetLimit(escalateLimit)) return null;

  const overrideHardRaw = override?.[scope]?.hardMaxTokens;
  const overrideHard =
    typeof overrideHardRaw === "number" ? overrideHardRaw : null;
  const overrideMaxRaw = override?.[scope]?.maxTokens;
  const raisedMax = typeof overrideMaxRaw === "number" && overrideMaxRaw > 0;
  const snapshotHardRaw = snapshotBudget[scope]?.hardMaxTokens;
  const snapshotHard =
    typeof snapshotHardRaw === "number" ? snapshotHardRaw : null;

  const hardLimit = isSetLimit(overrideHard)
    ? overrideHard
    : raisedMax
      ? escalateLimit * multiplier
      : isSetLimit(snapshotHard)
        ? snapshotHard
        : escalateLimit * multiplier;

  return { escalateLimit, hardLimit };
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

// Tree scope has no escalate rung (spec E6): a breach goes straight to the
// terminate-cascade. The promotion MUST happen here, at classification, and NOT
// after arbitration — `pickHigher` keeps the FIRST verdict at an equal rung and
// run/task are folded before tree, so a post-arbitration promotion let a
// same-tick run `escalate` silently swallow a tree breach and leave the tree
// over budget, unmarked and (once the root parked in NeedsInput) never
// re-evaluated. Promoted here, a real tree breach competes as rung 3 and wins on
// merit. `warn` is never promoted.
function promoteTreeVerdict(
  verdict: BudgetVerdict | null,
): BudgetVerdict | null {
  if (!verdict || verdict.rung !== "escalate") return verdict;

  return { ...verdict, rung: "terminate" };
}

// Evaluate every active scope/meter for one candidate and return the single
// highest-rung verdict (or null = within budget). The tree scope is gated to the
// tree ROOT only (this run has no root_run_id of its own) — a non-root member
// evaluates run/task. Tree scope is force-terminate (no escalate rung):
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
  const runTokenCeilings = tokenCeilings(
    snapshotBudget,
    override,
    "run",
    multiplier,
  );

  if (runTaskActive && runTokenCeilings) {
    const current = await queryRunTokens(candidate.id, { client: db });

    verdict = pickHigher(
      verdict,
      classifyMeter({
        scope: "run",
        meter: "tokens",
        current,
        escalateLimit: runTokenCeilings.escalateLimit,
        hardLimit: runTokenCeilings.hardLimit,
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
    const taskTokenCeilings = tokenCeilings(
      snapshotBudget,
      override,
      "task",
      multiplier,
    );

    if (taskTokenCeilings) {
      const current = await queryTaskTokens(candidate.taskId, { client: db });

      verdict = pickHigher(
        verdict,
        classifyMeter({
          scope: "task",
          meter: "tokens",
          current,
          escalateLimit: taskTokenCeilings.escalateLimit,
          hardLimit: taskTokenCeilings.hardLimit,
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
        { client: db, excludeRunId: candidate.id },
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

  // --- tree scope (only at the tree root) ------------------------------------
  //
  // Rootness is PARENTAGE. It is not `rootRunId === id`: the launchers write
  // `parent.rootRunId ?? parent.id`, so a descendant carries the root's id and
  // the ROOT ITSELF carries NULL — nothing self-stamps a root, so that predicate
  // is never true in production and the whole tree ladder was unreachable.
  //
  // A root with NO descendants is still metered here. Wall-clock and failures
  // are tree-scope-only meters with no other enforcement point, and a tree
  // token ceiling STRICTER than the run's is an operator asking for a tighter
  // bound — "a tree of one spends only its own tokens" is true of the
  // measurement, not of two different ceilings over it. Only the genuinely
  // redundant tokens meter is skipped, at the meter (see `skipRedundantTreeTokens`).
  if (candidate.parentRunId === null) {
    // ADR-165 (D8): min-merge the ROOT orchestrator node's declared budget into
    // the policy's tree ceilings. The tighter of the two binds — a manifest can
    // lower an instance policy, never raise it. Spend / time / failure budgets
    // bind at the ROOT ONLY; a nested orchestrator's budget is recorded on its
    // own run row and never metered (residual R-nested).
    const nodeBudget = candidate.delegationBounds?.budget ?? null;
    const mergeTree = (
      policyLimit: number | null,
      nodeLimit: number | undefined,
    ): { limit: number | null; source: "policy" | "node" | "min" } => {
      if (!isSetLimit(nodeLimit ?? null)) {
        return { limit: policyLimit, source: "policy" };
      }
      if (!isSetLimit(policyLimit)) {
        return { limit: nodeLimit as number, source: "node" };
      }

      return {
        limit: Math.min(policyLimit, nodeLimit as number),
        source:
          (nodeLimit as number) < policyLimit
            ? "node"
            : (nodeLimit as number) === policyLimit
              ? "min"
              : "policy",
      };
    };

    const policyTreeTokens = tokenCeilings(
      snapshotBudget,
      override,
      "tree",
      multiplier,
    );
    const mergedTokens = mergeTree(
      policyTreeTokens?.escalateLimit ?? null,
      nodeBudget?.maxTokens,
    );
    const treeTokenCeilings =
      mergedTokens.limit === null
        ? null
        : {
            escalateLimit: mergedTokens.limit,
            // The hard band re-derives from the EFFECTIVE escalate limit, so a
            // node budget that lowers the escalate ceiling lowers the terminate
            // ceiling with it rather than leaving a stale, higher one.
            hardLimit:
              mergedTokens.source === "policy" && policyTreeTokens
                ? policyTreeTokens.hardLimit
                : mergedTokens.limit * multiplier,
          };

    if (mergedTokens.limit !== null) {
      log.debug(
        {
          rootRunId: candidate.id,
          limitSource: mergedTokens.source,
          escalateLimit: mergedTokens.limit,
        },
        "[budget.tree] effective token ceiling",
      );
    }

    // D2: for a root with NO descendants the tree token total is the run token
    // total by construction (`queryRunTreeTokens` covers `id = root OR
    // root_run_id = root`), so this meter is pure redundancy — and a harmful
    // one: tree scope terminates without an escalate rung, so it killed a lone
    // run whose RUN ceiling the operator had just raised (the raise lifts
    // `ceilingOverride[scope]` for the breached scope only). Skipped only when
    // run-scope tokens are actually set, so a flow configuring only
    // `budget.tree` keeps its bound. Scoped to TOKENS: wall-clock is a
    // tree-scope-only meter and failures are always 0 for a tree of one.
    // The redundancy is only real when the tree ceiling could never bind FIRST.
    // "Tree total == run total for a tree of one" is a statement about the
    // MEASUREMENT; two different ceilings over the same measurement are not
    // redundant, and a stricter tree ceiling is the operator asking for a tighter
    // bound. Skipping it silently ignored that ask.
    const skipRedundantTreeTokens =
      treeTokenCeilings !== null &&
      runTokenCeilings !== null &&
      treeTokenCeilings.escalateLimit >= runTokenCeilings.escalateLimit &&
      treeTokenCeilings.hardLimit >= runTokenCeilings.hardLimit &&
      !(await hasDescendants(db, candidate.id));

    if (treeTokenCeilings && !skipRedundantTreeTokens) {
      const current = await queryRunTreeTokens(candidate.id, { client: db });

      verdict = pickHigher(
        verdict,
        promoteTreeVerdict(
          classifyMeter({
            scope: "tree",
            meter: "tokens",
            current,
            escalateLimit: treeTokenCeilings.escalateLimit,
            hardLimit: treeTokenCeilings.hardLimit,
            warnPct: warnPct("tree"),
          }),
        ),
      );
    }

    const treeFailMerged = mergeTree(
      effectiveLimit(snapshotBudget, override, "tree", "consecutiveFailures"),
      nodeBudget?.consecutiveFailures,
    );
    const treeFailLimit = treeFailMerged.limit;

    if (isSetLimit(treeFailLimit)) {
      const current = await consecutiveFailedRuns(
        { rootRunId: candidate.id },
        { client: db, excludeRunId: candidate.id },
      );

      verdict = pickHigher(
        verdict,
        promoteTreeVerdict(
          classifyMeter({
            scope: "tree",
            meter: "failures",
            current,
            escalateLimit: treeFailLimit,
            hardLimit: null,
            warnPct: warnPct("tree"),
          }),
        ),
      );
    }

    const treeWallMerged = mergeTree(
      effectiveLimit(snapshotBudget, override, "tree", "wallClockMinutes"),
      nodeBudget?.wallClockMinutes,
    );
    const treeWallLimit = treeWallMerged.limit;

    if (isSetLimit(treeWallLimit)) {
      const current = await treeWallClockMinutes(candidate.id, { client: db });

      verdict = pickHigher(
        verdict,
        promoteTreeVerdict(
          classifyMeter({
            scope: "tree",
            meter: "wallclock",
            current,
            escalateLimit: treeWallLimit,
            hardLimit: null,
            warnPct: warnPct("tree"),
          }),
        ),
      );
    }
  }

  // The tree escalate→terminate promotion happens at CLASSIFICATION
  // (`promoteTreeVerdict`), not here: promoting after arbitration let a same-tick
  // run/task escalate win the equal-rung tie and swallow the tree breach.
  //
  // The run/task (non-tree) breach DISPOSITION is not hardcoded by run_kind: it
  // is resolved from the onBudgetBreach policy axis at dispatch (escalate |
  // terminate | terminate_restorable; ADR-106 M39 Phase 5), so a non-flow run can
  // escalate (agent resume via session/resume) or land in the recoverable
  // NeedsInputIdle instead of an unconditional terminate.
  return verdict;
}

// Resolve the run/task (non-tree) breach disposition from the onBudgetBreach
// policy axis (ADR-106). UNSET (null) reproduces the pre-M39 run_kind default:
// flow → escalate (pause + raise), non-flow → terminate (Failed). A
// `terminate_restorable` policy wins at BOTH the soft (escalate) and hard
// (terminate) rung — the owner's "no-escalate" never hard-fails on budget. At the
// hard rung, escalate/terminate both terminate (the agent already blew the hard
// ceiling); only the soft rung honors `escalate`.
function resolveBudgetDisposition(args: {
  rung: BudgetRung;
  runKind: string;
  onBudgetBreach: OnBudgetBreach | null;
}): "escalate" | "terminate" | "terminate_restorable" {
  const policy =
    args.onBudgetBreach ?? (args.runKind === "flow" ? "escalate" : "terminate");

  if (policy === "terminate_restorable") return "terminate_restorable";
  if (args.rung === "terminate") return "terminate";

  return policy === "escalate" ? "escalate" : "terminate";
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
// The candidate's bound client + its live session for the current node. A
// lookup failure (host unreachable / identity mismatch) returns null so the
// caller leaves the candidate for the next tick — never act on "unknown".
async function boundLiveSession(
  hosts: ExecutionHosts,
  candidate: BudgetCandidate,
  phase: string,
): Promise<{
  client: BoundClient;
  live: SupervisorSessionRecord | undefined;
} | null> {
  try {
    const client = await hosts.forRun(candidate.id, { teardown: true });
    const live = await liveSessionFor(
      client,
      candidate.runKind === "agent" ? "agent" : candidate.currentStepId,
    );

    return { client, live };
  } catch (err) {
    log.warn(
      {
        runId: candidate.id,
        phase,
        err: err instanceof Error ? err.message : String(err),
      },
      "[budget] host lookup failed — leaving candidate for next tick",
    );

    return null;
  }
}

// PAUSE-FOR-BUDGET (run/task scope, any run_kind — ADR-106 M39 Phase 5): halt the
// live session so spend stops (checkpoint), then pause with a budget_breach HITL —
// status flip + node attempt + HITL row + assignment + run.needs_input +
// run.escalated outbox all in ONE tx (ADR-086 exactly-once). Worktree KEPT.
// EXECUTOR_UNAVAILABLE on the checkpoint leaves the run live for the next tick
// (no split-brain). Returns true on pause.
//
// `mode` is the resolved onBudgetBreach disposition:
//   - "escalate"   → NeedsInput, the slot is HELD (raise-and-resume from a live
//                    pause; the keep-alive sweeper later idles it if unanswered).
//   - "restorable" → NeedsInputIdle (checkpointed, recoverable), the slot is
//                    FREED so a queued run promotes; restore = raise + resume.
// Both keep acp_session_id, so the resume restores context via session/resume
// (agent → startAgentSession, flow → runFlow / idle resume-driver).
async function actBudgetEscalate(
  db: Db,
  hosts: ExecutionHosts,
  candidate: BudgetCandidate,
  verdict: BudgetVerdict,
  mode: "escalate" | "restorable",
): Promise<boolean> {
  const bound = await boundLiveSession(hosts, candidate, "escalate");

  if (!bound) return false;
  const { client, live } = bound;
  const ownedSource = live
    ? await db.transaction((tx: Db) =>
        captureAgentPauseSource(tx, {
          runId: candidate.id,
          assignmentId: client.assignment.id,
          sessionId: live.sessionId,
        }),
      )
    : null;

  if (candidate.runKind === "agent" && !ownedSource) {
    const [admitted] = await db
      .select({ id: agentTurns.id })
      .from(agentTurns)
      .where(
        and(
          eq(agentTurns.runId, candidate.id),
          eq(agentTurns.executionAssignmentId, client.assignment.id),
        ),
      )
      .limit(1);

    if (admitted) return false;
  }

  if (live) {
    try {
      await client.checkpoint(live.sessionId);
    } catch (err) {
      if (isMaisterError(err) && err.code === "EXECUTOR_UNAVAILABLE") {
        log.warn(
          { runId: candidate.id, err: err.message },
          "[budget] escalate checkpoint 5xx — leaving live for next tick",
        );

        return false;
      }
      if (isFencedError(err)) {
        log.warn(
          { runId: candidate.id },
          "[budget] escalate checkpoint fenced — a newer driver generation owns the run; skipping",
        );

        return false;
      }
      if (ownedSource) throw err;
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

  // A flow run's active node attempt moves to NeedsInput for a clean resume
  // re-entry; an agent run has no node_attempts row (fetchActiveAttempt → null,
  // a no-op below) — the agent resume respawns the whole session.
  const attempt = candidate.currentStepId
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
      const source = live
        ? await captureAgentPauseSource(tx, {
            runId: candidate.id,
            assignmentId: client.assignment.id,
            sessionId: live.sessionId,
          })
        : null;
      const upd = await tx
        .update(runs)
        .set({
          status: mode === "restorable" ? "NeedsInputIdle" : "NeedsInput",
          // restorable is an idle checkpoint: stamp checkpoint_at + clear the
          // keep-alive window so it reads as a recoverable idle (the Pass2 TTL
          // still applies, the slot is freed below). escalate leaves the run a
          // held NeedsInput pause — the slot stays reserved until the raise.
          ...(mode === "restorable"
            ? { checkpointAt: new Date(), keepaliveUntil: null }
            : {}),
          budgetState: mergedBudgetState(
            candidate.budgetState,
            verdict.scope,
            verdict.rung,
          ),
        })
        // A run/task verdict is only ever reached for a Running candidate (Fix
        // A) — CAS on the EXACT observed status. A parked WaitingOnChildren root
        // has no → NeedsInput resume route, so it must never be paused here even
        // defensively.
        .where(
          and(
            eq(runs.id, candidate.id),
            eq(
              runs.status,
              source &&
                (await isAgentPermissionPause(
                  tx,
                  candidate.id,
                  source.agentPrompt.commandId,
                ))
                ? "NeedsInput"
                : "Running",
            ),
          ),
        )
        .returning({ id: runs.id, projectId: runs.projectId });

      if (upd.length === 0) return false;

      // The restorable park is an idle checkpoint: this driver generation ends
      // with it (the raise mints the next one); an escalate keeps its driver.
      if (mode === "restorable") {
        await releaseAssignmentForRun(tx, candidate.id, "checkpointed");
      }

      if (attempt) {
        await markNodeNeedsInput(attempt.id, tx);
      }

      await tx.insert(hitlRequests).values({
        id: hitlRequestId,
        runId: candidate.id,
        stepId,
        kind: "budget_breach",
        schema: { ...schema, ...source },
        prompt,
      });
      if (source) await supersedeAgentPausePermissions(tx, hitlRequestId);

      // Route the breach to a human + fire the escalation outbox events, all in
      // the SAME tx as the pause (ADR-086 exactly-once — a post-commit emit could
      // be lost by a crash with no retry, since the paused run is no longer a
      // watchdog candidate). Only scheduleResume is a post-commit notify. A
      // project-less local-package run never reaches here (no budget axis).
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
        await emitDomainEvent({
          db: tx,
          kind: "run.escalated",
          projectId: upd[0].projectId,
          runId: candidate.id,
          taskId: candidate.taskId,
          actor: { type: "system", id: null },
          payload: {
            runId: candidate.id,
            reason: "budget_exceeded",
            scope: verdict.scope,
            meter: verdict.meter,
          },
        });
        await emitWebhookEvent({
          db: tx,
          type: "run.escalated",
          projectId: upd[0].projectId,
          runId: candidate.id,
          data: {
            reason: "budget_exceeded",
            scope: verdict.scope,
            meter: verdict.meter,
          },
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
    // Claim lost — the run advanced concurrently (a racing escalate won, or it
    // completed). Do NOT unlink needs-input.json here: if a concurrent escalate
    // WON, the committed NeedsInput run depends on this file, and the loser
    // deleting it (overlapping ticks / multiple web instances) would strip the
    // winner's artifact. An orphaned file on a non-paused run is harmless —
    // nobody reads it unless the run is NeedsInput, and the run dir is GC'd. The
    // catch above still unlinks when the pause tx itself threw.
    log.debug(
      { runId: candidate.id },
      "[budget] escalate claim lost — run advanced concurrently",
    );

    return false;
  }

  // The escalation outbox events committed inside the pause tx above; only the
  // slot release (restorable only), audit log + runner wake happen post-commit.
  if (mode === "restorable") {
    // NeedsInputIdle frees the concurrency slot — promote the next queued run.
    try {
      await releaseSlotOnIdle({ runId: candidate.id, db });
    } catch (err) {
      log.warn(
        {
          runId: candidate.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "[budget] restorable releaseSlotOnIdle failed (non-fatal)",
      );
    }
  }

  logExecPolicyAction({
    runId: candidate.id,
    kind: mode === "restorable" ? "budget_restorable" : "budget_escalated",
    detail: {
      scope: verdict.scope,
      meter: verdict.meter,
      current: verdict.current,
      limit: verdict.limit,
    },
  });
  log.warn(
    { runId: candidate.id, scope: verdict.scope, meter: verdict.meter, mode },
    mode === "restorable"
      ? "[budget] restorable → NeedsInputIdle (slot freed, budget_breach HITL)"
      : "[budget] escalated → NeedsInput (budget_breach HITL)",
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
  hosts: ExecutionHosts,
  candidate: BudgetCandidate,
  verdict: BudgetVerdict,
): Promise<boolean> {
  const bound = await boundLiveSession(hosts, candidate, "terminate");

  if (!bound) return false;
  const { client, live } = bound;

  if (live) {
    try {
      await client.deleteSession(live.sessionId);
    } catch (err) {
      if (isMaisterError(err) && err.code === "EXECUTOR_UNAVAILABLE") {
        log.warn(
          { runId: candidate.id, err: err.message },
          "[budget] terminate deleteSession 5xx — leaving Running for next tick",
        );

        return false;
      }
      if (isFencedError(err)) {
        log.warn(
          { runId: candidate.id },
          "[budget] terminate deleteSession fenced — a newer driver generation owns the run; skipping",
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

    await releaseAssignmentForRun(tx, candidate.id, "failed");

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

// TREE-scope TERMINATE: stop every live session in the tree (so the swarm
// actually stops spending past the hard ceiling), cascade-abandon the whole
// sub-tree (children-first, one tx, per-pool promote), then flip the root
// terminal. cascadeAbandonRunTree does NOT touch the root or the supervisor
// sessions, so the root session + each child session are killed here and the
// root row is flipped here (Failed for flow/agent; the scratch finalizer is
// never a tree root).
async function actBudgetTerminateTree(
  db: Db,
  hosts: ExecutionHosts,
  candidate: BudgetCandidate,
  verdict: BudgetVerdict,
): Promise<boolean> {
  // Stop the spend BEFORE flipping rows terminal (E5 discipline). The root may
  // be Running mid-plan with its own live session; kill it first. An
  // EXECUTOR_UNAVAILABLE (supervisor 5xx) means we cannot confirm it stopped —
  // leave the tree for the next tick rather than mark it Failed with the agent
  // still spending. A terminal (non-5xx) failure means the session is already
  // gone; proceed.
  const bound = await boundLiveSession(hosts, candidate, "tree-terminate");

  if (!bound) return false;
  const { client, live: rootLive } = bound;

  if (rootLive) {
    try {
      await client.deleteSession(rootLive.sessionId);
    } catch (err) {
      if (isMaisterError(err) && err.code === "EXECUTOR_UNAVAILABLE") {
        log.warn(
          { runId: candidate.id, err: err.message },
          "[budget] tree-terminate root deleteSession 5xx — leaving tree for next tick",
        );

        return false;
      }
      if (isFencedError(err)) {
        log.warn(
          { runId: candidate.id },
          "[budget] tree-terminate root deleteSession fenced — a newer driver generation owns the root; skipping",
        );

        return false;
      }
      log.warn(
        {
          runId: candidate.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "[budget] tree-terminate root deleteSession terminal failure — proceeding",
      );
    }
  }

  // Rows AND sessions: without the teardown the child agents keep running to
  // completion and the tree token cap stays soft.
  await cascadeAbandonRunTreeAndStopSessions(
    candidate.id,
    candidate.taskId,
    "budget_exceeded",
    { db, executionHosts: hosts, logLabel: "[budget] tree-terminate" },
  );

  // The ROOT's own terminal flip is run-kind dispatched, exactly like the
  // run-scope arm. A tree root is any candidate with `root_run_id IS NULL` and
  // `fetchBudgetCandidates` does not filter `run_kind`, so an agent or scratch
  // singleton carrying a tree wall-clock / failure ceiling lands here. The
  // previous single raw `runs` update flipped those to Failed while leaving the
  // kind's own finalizer unrun — scratch_runs still live, and for an agent no
  // token revocation, HITL close, materialization restore, context-mount release
  // or AGENT-pool promotion.
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
        "[budget] tree-terminate agent finalize mismatch — concurrent transition won",
      );

      return false;
    }
    logBudgetTerminated(candidate, verdict);

    return true;
  }

  if (candidate.runKind === "scratch") {
    const { markScratchCrashed } = await import("@/lib/scratch-runs/service");

    await markScratchCrashed({
      db,
      runId: candidate.id,
      err: new MaisterError("BUDGET_EXCEEDED", budgetBreachPrompt(verdict)),
      terminal: "failed",
    });
    await promoteAfterTimeoutKill(db);
    logBudgetTerminated(candidate, verdict);

    return true;
  }

  // A parked WaitingOnChildren root has no current node, so there is nothing to
  // close — same guard the run-scope flow arm uses.
  const treeRootAttempt = candidate.currentStepId
    ? await fetchActiveAttempt(db, candidate.id, candidate.currentStepId)
    : null;
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
          // Guard on the node `treeRootAttempt` was resolved for, exactly like
          // the run-scope arm: a root that advanced to its next node while
          // staying Running must LOSE this CAS, or the stale (already
          // Succeeded) attempt is failed below under a run whose live node
          // keeps running.
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

    if (rows.length === 0) return [];

    await releaseAssignmentForRun(tx, candidate.id, "failed");
    // Close the ledger in the SAME tx as the status flip (rules/backend.md: a
    // terminal transition closes every store representing the lifecycle). Without
    // this the root's active attempt stayed `Running` under a `Failed` run.
    if (treeRootAttempt) {
      await markNodeFailed(
        treeRootAttempt.id,
        { errorCode: "BUDGET_EXCEEDED" },
        tx,
      );
    }

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
    // The flip lost, but the cascade above already committed: every descendant is
    // irreversibly Abandoned while this root survives non-terminal.
    //
    // Do NOT stamp `notified.tree` here. It is written only inside the CAS
    // `.set()` ON PURPOSE: `alreadyActioned` compares
    // `RUNG_ORDER[prior] >= RUNG_ORDER[rung]` and nothing outranks `terminate`, so
    // recording a terminate that never landed would permanently disable tree
    // enforcement for a root that can still resume and spawn new children. A
    // re-entry re-running the cascade is the far smaller harm —
    // `cascadeAbandonRunTree` is idempotent — so the operator signal goes in this
    // WARN, not into state that suppresses future verdicts.
    log.warn(
      { runId: candidate.id, scope: verdict.scope, meter: verdict.meter },
      "[budget] tree-root flip claim lost — concurrent transition won; descendants already cascaded, tree left enforceable",
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

async function runBudgetPass(db: Db, hosts: ExecutionHosts): Promise<number> {
  const candidates = await fetchBudgetCandidates(db);

  if (candidates.length === 0) return 0;

  const reconciliationRunIds = await budgetReconciliationRunIds(db, candidates);

  await runWithConcurrency(
    reconciliationRunIds,
    PER_PASS_CONCURRENCY,
    async (runId) => {
      try {
        await reconcileRunCostRollups(runId, { client: db });
      } catch (err) {
        log.warn(
          {
            runId,
            err: err instanceof Error ? err.message : String(err),
          },
          "[budget] reconcile before read failed — evaluating on existing rollups",
        );
      }
    },
  );

  let acted = 0;

  await runWithConcurrency(
    candidates,
    PER_PASS_CONCURRENCY,
    async (candidate) => {
      const snapshotBudget = budgetFromSnapshot(candidate.executionPolicy);
      const override = candidate.budgetState?.ceilingOverride;

      // Fail-open fast path: no scope carries any positive meter, so this run
      // neither contributes to the reconciliation set nor receives an action.
      if (!hasConfiguredBudgetMeter(candidate)) return;

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
      } else if (verdict.scope === "tree") {
        // tree breach (escalate force-promoted to terminate upstream) → cascade.
        didAct = await actBudgetTerminateTree(db, hosts, candidate, verdict);
      } else {
        // run/task (non-tree): the onBudgetBreach policy axis picks the response.
        const disposition = resolveBudgetDisposition({
          rung: verdict.rung,
          runKind: candidate.runKind,
          onBudgetBreach: onBudgetBreachFromSnapshot(candidate.executionPolicy),
        });

        if (disposition === "escalate") {
          didAct = await actBudgetEscalate(
            db,
            hosts,
            candidate,
            verdict,
            "escalate",
          );
        } else if (disposition === "terminate_restorable") {
          didAct = await actBudgetEscalate(
            db,
            hosts,
            candidate,
            verdict,
            "restorable",
          );
        } else {
          didAct = await actBudgetTerminateRun(db, hosts, candidate, verdict);
        }
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
  opts: { db?: Db; executionHosts?: ExecutionHosts } = {},
): Promise<SweepResult> {
  const db = opts.db ?? getDb();
  const hosts = opts.executionHosts ?? createExecutionHosts({ db });
  const idledCount = await runPass1(db, hosts);
  const abandonedCount = await runPass2(db);
  const killedCount = await runTimeLimitPass(db, hosts);
  const budgetActedCount = await runBudgetPass(db, hosts);
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
  running: boolean;
};

const SWEEPER_GLOBAL_KEY = Symbol.for("maister.keepalive-sweeper.v1");

function globalState(): GlobalSweeperState {
  const g = globalThis as unknown as Record<symbol, GlobalSweeperState>;

  if (!g[SWEEPER_GLOBAL_KEY]) {
    g[SWEEPER_GLOBAL_KEY] = {
      handle: null,
      intervalSeconds: 0,
      running: false,
    };
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
    // Re-entrancy guard: setInterval fires every N s regardless of whether the
    // previous tick's promise resolved. A slow tick (many candidates, heavy DB)
    // could otherwise overlap with the next — two ticks racing the SAME run. The
    // per-row CAS keeps that correct, but overlap wastes work and would let an
    // escalate loser delete the winner's needs-input.json. Skip while a tick is
    // in flight. (Cross-PROCESS overlap on a multi-instance web tier is still
    // possible — the per-row CAS + the no-unlink-on-loss path above cover it.)
    if (state.running) {
      log.debug({}, "sweeper tick still running — skipping this interval");

      return;
    }
    state.running = true;
    void runSweepTick()
      .catch((err: unknown) => {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "sweeper tick threw — continuing on next interval",
        );
      })
      .finally(() => {
        state.running = false;
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
