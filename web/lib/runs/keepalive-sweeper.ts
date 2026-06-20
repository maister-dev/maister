import "server-only";

import type { FlowYamlV1 } from "@/lib/config.schema";

import { and, asc, eq, isNotNull, isNull, lt } from "drizzle-orm";
import pino from "pino";

import { markCheckpointed } from "./state-transitions";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { isMaisterError } from "@/lib/errors";
import { systemCloseActiveAssignmentsForRun } from "@/lib/assignments/service";
import { compileManifest } from "@/lib/flows/graph/compile";
import { markNodeFailed } from "@/lib/flows/graph/ledger";
import { promoteNextPending, releaseSlotOnIdle } from "@/lib/scheduler";
import {
  checkpointSession,
  deleteSession,
  listSessions,
  type SupervisorSessionRecord,
} from "@/lib/supervisor-client";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { flowRevisions, flows, hitlRequests, nodeAttempts, runs } =
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
        // M36 Phase 8 (ADR-096): a persistent swarm member parks INDEFINITELY
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

export type SweepResult = {
  scannedRunsCount: number;
  idledCount: number;
  abandonedCount: number;
  killedCount: number;
};

export async function runSweepTick(
  opts: { db?: Db } = {},
): Promise<SweepResult> {
  const db = opts.db ?? getDb();
  const idledCount = await runPass1(db);
  const abandonedCount = await runPass2(db);
  const killedCount = await runTimeLimitPass(db);
  const scannedRunsCount = idledCount + abandonedCount + killedCount;

  log.info(
    {
      scannedRunsCount,
      idledCount,
      abandonedCount,
      killedCount,
      sweepIntervalSeconds: sweepIntervalSeconds(),
    },
    "sweeper tick complete",
  );

  return { scannedRunsCount, idledCount, abandonedCount, killedCount };
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
