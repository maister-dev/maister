import "server-only";

import { and, desc, eq, gt, isNotNull, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import pino from "pino";

import { scheduleResumedSessionDrive } from "./resume-driver";
import { rollbackResumedRun } from "./state-transitions";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import {
  listSessions,
  type SupervisorSessionRecord,
} from "@/lib/supervisor-client";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { gateResults, hitlRequests, nodeAttempts, runs } =
  schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "resume-recovery",
  level: process.env.LOG_LEVEL ?? "info",
});

// M8 Codex review fix #2: startup-recovery sweep.
//
// The /respond idle branch claims the operator's response durably
// (hitl_requests.response set, respondedAt null), transitions the run
// NeedsInputIdle → NeedsInput, spawns a fresh supervisor session, and
// returns 202 — but the driver that actually delivers the intent is
// only scheduled via queueMicrotask (`scheduleResumedSessionDrive`).
// If the Next.js process restarts between the 202 response and the
// microtask attaching, the durable DB state is left as `NeedsInput
// AND latest hitl_requests.response IS NOT NULL AND respondedAt IS NULL`
// with no one reading the supervisor's SSE stream.
//
// This sweep runs ONCE per process boot, BEFORE the keep-alive sweeper
// starts triggering new checkpoints. For each "claimed-but-undelivered"
// row:
//   - Live supervisor session → re-schedule the driver (it owns the
//     pickup and auto-deliver).
//   - Supervisor session gone → atomic rollback to NeedsInputIdle so
//     the operator's same-payload retry can succeed via the normal
//     /respond path. The hitl_requests.response stays in place — it's
//     still the operator's intent.
//   - Supervisor transient 5xx → skip this tick; the keep-alive
//     sweeper's TTL Pass 2 is the long-term safety net.

const PER_PASS_CONCURRENCY = 4;

type RecoveryCandidate = {
  runId: string;
  acpSessionId: string;
  stepId: string;
  hitlRequestId: string;
};

async function fetchCandidates(db: Db): Promise<RecoveryCandidate[]> {
  // SELECT every NeedsInput row that has at least one hitl_requests row
  // where response IS NOT NULL AND respondedAt IS NULL (claimed but not
  // delivered). The web tier currently has at most one open intent per
  // run by construction (one HITL per current step), but ORDER BY
  // createdAt DESC + LIMIT 1 in the per-row sub-query is the safe
  // pattern.
  //
  // M11b (ADR-030 invariant 1): the status filter is `NeedsInput`, so a
  // `HumanWorking` run is NEVER a candidate here — it is session-less by
  // design yet holds a worktree, and must survive a restart without being
  // classified `Crashed`. The exclusion is by construction; the
  // takeover-return stranded-`Running` recovery is a SEPARATE sweep
  // (runTakeoverReturnRecoverySweep) that re-dispatches rather than crashes.
  const rows: Array<{
    id: string;
    acpSessionId: string | null;
    currentStepId: string | null;
  }> = await db
    .select({
      id: runs.id,
      acpSessionId: runs.acpSessionId,
      currentStepId: runs.currentStepId,
    })
    .from(runs)
    .where(and(eq(runs.status, "NeedsInput"), isNotNull(runs.acpSessionId)));

  const candidates: RecoveryCandidate[] = [];

  for (const row of rows) {
    if (!row.acpSessionId) continue;

    const hitlRows: Array<{
      id: string;
      stepId: string;
    }> = await db
      .select({ id: hitlRequests.id, stepId: hitlRequests.stepId })
      .from(hitlRequests)
      .where(
        and(
          eq(hitlRequests.runId, row.id),
          isNotNull(hitlRequests.response),
          isNull(hitlRequests.respondedAt),
        ),
      )
      .orderBy(desc(hitlRequests.createdAt))
      .limit(1);

    const hitl = hitlRows[0];

    if (!hitl) continue;

    candidates.push({
      runId: row.id,
      acpSessionId: row.acpSessionId,
      stepId: hitl.stepId,
      hitlRequestId: hitl.id,
    });
  }

  return candidates;
}

async function loadSupervisorSessionMap(): Promise<
  | {
      ok: true;
      map: Map<string, SupervisorSessionRecord>;
    }
  | { ok: false; reason: string }
> {
  try {
    const records = await listSessions();
    const map = new Map<string, SupervisorSessionRecord>();

    for (const rec of records) {
      if (rec.status === "live" && rec.acpSessionId) {
        map.set(rec.acpSessionId, rec);
      }
    }

    return { ok: true, map };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    return { ok: false, reason: msg };
  }
}

async function runWithConcurrency<T>(
  items: ReadonlyArray<T>,
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers: Promise<void>[] = [];

  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++;

      if (idx >= items.length) return;
      await fn(items[idx]);
    }
  }

  for (let i = 0; i < Math.min(limit, items.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
}

export type ResumeRecoverySweepResult = {
  candidatesFound: number;
  rescheduled: number;
  rolledBack: number;
  skipped: number;
};

export type ResumeRecoverySweepOptions = {
  db?: Db;
  // Override for tests — by default uses the real supervisor-client.
  loadSessions?: typeof loadSupervisorSessionMap;
  scheduleDriver?: typeof scheduleResumedSessionDrive;
};

export async function runResumeRecoverySweep(
  opts: ResumeRecoverySweepOptions = {},
): Promise<ResumeRecoverySweepResult> {
  const db = opts.db ?? getDb();
  const loadSessions = opts.loadSessions ?? loadSupervisorSessionMap;
  const scheduleDriver = opts.scheduleDriver ?? scheduleResumedSessionDrive;

  const candidates = await fetchCandidates(db);

  if (candidates.length === 0) {
    log.info({}, "resume-recovery sweep: no claimed-but-undelivered rows");

    return {
      candidatesFound: 0,
      rescheduled: 0,
      rolledBack: 0,
      skipped: 0,
    };
  }

  log.info(
    { candidates: candidates.length },
    "resume-recovery sweep: claimed-but-undelivered rows found",
  );

  const sessionLoad = await loadSessions();

  // Transient supervisor unavailability: skip this boot. The keepalive
  // sweeper's TTL Pass 2 is the long-term safety net (NeedsInput rows
  // stuck past keepaliveUntil → NeedsInputIdle → eventually Abandoned).
  if (!sessionLoad.ok) {
    log.warn(
      { candidates: candidates.length, reason: sessionLoad.reason },
      "resume-recovery sweep: supervisor listSessions failed — skipping all candidates this boot",
    );

    return {
      candidatesFound: candidates.length,
      rescheduled: 0,
      rolledBack: 0,
      skipped: candidates.length,
    };
  }

  let rescheduled = 0;
  let rolledBack = 0;
  let skipped = 0;

  await runWithConcurrency(candidates, PER_PASS_CONCURRENCY, async (cand) => {
    const live = sessionLoad.map.get(cand.acpSessionId);

    if (live) {
      // Re-attach the driver to the live supervisor session.
      const driveId = scheduleDriver({
        runId: cand.runId,
        supervisorSessionId: live.sessionId,
        acpSessionId: cand.acpSessionId,
        stepId: cand.stepId,
        db,
      });

      rescheduled += 1;
      log.info(
        {
          runId: cand.runId,
          acpSessionId: cand.acpSessionId,
          supervisorSessionId: live.sessionId,
          hitlRequestId: cand.hitlRequestId,
          driveId,
        },
        "resume-recovery: driver re-scheduled against live supervisor session",
      );

      return;
    }

    // Supervisor session is GONE (process exited, supervisor restarted).
    // Roll the run back to NeedsInputIdle (status-guarded) so the
    // operator's same-payload retry on /respond can re-resume cleanly.
    // hitl_requests.response stays in place — it's still a valid intent.
    const rb = await rollbackResumedRun(cand.runId, { db });

    if (rb.ok) {
      rolledBack += 1;
      log.warn(
        {
          runId: cand.runId,
          acpSessionId: cand.acpSessionId,
          hitlRequestId: cand.hitlRequestId,
        },
        "resume-recovery: supervisor session gone — rolled back to NeedsInputIdle, intent preserved",
      );
    } else {
      skipped += 1;
      log.warn(
        {
          runId: cand.runId,
          acpSessionId: cand.acpSessionId,
          reason: rb.reason,
        },
        "resume-recovery: rollback status-guard mismatch — concurrent transition won, leaving row alone",
      );
    }
  });

  log.info(
    {
      candidatesFound: candidates.length,
      rescheduled,
      rolledBack,
      skipped,
    },
    "resume-recovery sweep complete",
  );

  return {
    candidatesFound: candidates.length,
    rescheduled,
    rolledBack,
    skipped,
  };
}

// --- M11b F3 (ADR-030 invariant 6): takeover-return stranded-Running sweep --
//
// If the process dies AFTER the return route's AFTER-side `HumanWorking →
// Running` flip but BEFORE `queueMicrotask(runFlow)` attaches, the run is
// stranded in `Running` holding a cap slot with no live runner. This sweep
// detects that state and RE-DISPATCHES the graph runner (resume at
// `runs.current_step_id` — the `transitions.takeover` re-entry).
//
// A candidate is a `Running` run whose most-recent ledger activity is a
// RECORDED takeover return — its takeover `node_attempts` row has
// `returned_diff` AND `ended_at` set — whose re-entry node's `gate_results`
// are still `stale`, AND which has NO re-entry (`current_step_id`)
// `node_attempts` row created after the return (i.e. the resume never
// progressed). Re-dispatch is SAFE because M11a's resume is CAS-guarded and
// idempotent: a live runner makes the re-dispatch a no-op; a genuinely stale
// pointer fails closed to `Crashed` (runner-graph.ts). A naive
// "Running + no live session → Crashed" sweep is FORBIDDEN — it would
// false-positive on a session-less `command_check` gate executing after the
// return.

export type TakeoverReturnRecoverySweepResult = {
  candidatesFound: number;
  reDispatched: number;
};

// FIXME(any): dual drizzle-orm peer-dep variants — runner entry signature.
type RunFlowEntry = (runId: string, opts: { db?: Db }) => Promise<void>;

export type TakeoverReturnRecoverySweepOptions = {
  db?: Db;
  // Override for tests — by default the real graph-runner entry (runFlow),
  // the SAME entry the Phase-3 return route uses for queueMicrotask.
  runFlow?: RunFlowEntry;
};

async function fetchStrandedTakeoverRuns(db: Db): Promise<string[]> {
  // Running rows that carry a recorded takeover return on the node ledger.
  // We read the takeover row's `started_at` (DB clock) as the temporal
  // boundary for "is there a post-return re-entry attempt" — both that and
  // the re-entry attempts' `started_at` come from Postgres `now()`, so the
  // comparison is free of host-vs-DB clock skew (unlike `ended_at`, which a
  // helper writes from the app's `new Date()`). The takeover claim+return
  // always start after the pre-takeover re-entry attempt and before any
  // genuine post-return re-entry attempt.
  const rows: Array<{
    runId: string;
    currentStepId: string | null;
    takeoverAttemptId: string;
    takeoverStartedAt: Date | null;
  }> = await db
    .select({
      runId: runs.id,
      currentStepId: runs.currentStepId,
      takeoverAttemptId: nodeAttempts.id,
      takeoverStartedAt: nodeAttempts.startedAt,
    })
    .from(runs)
    .innerJoin(nodeAttempts, eq(nodeAttempts.runId, runs.id))
    .where(
      and(
        eq(runs.status, "Running"),
        isNotNull(nodeAttempts.ownerUserId),
        isNotNull(nodeAttempts.returnedDiff),
        isNotNull(nodeAttempts.endedAt),
      ),
    );

  const takeoverRow = alias(nodeAttempts, "takeover_row");

  const stranded: string[] = [];

  for (const row of rows) {
    const reentryNodeId = row.currentStepId;

    if (!reentryNodeId || !row.takeoverStartedAt) continue;

    // The re-entry node's gate_results must still be `stale` — the return
    // staled them and the resume never re-ran them.
    const staleGates: Array<{ id: string }> = await db
      .select({ id: gateResults.id })
      .from(gateResults)
      .innerJoin(nodeAttempts, eq(gateResults.nodeAttemptId, nodeAttempts.id))
      .where(
        and(
          eq(gateResults.runId, row.runId),
          eq(nodeAttempts.nodeId, reentryNodeId),
          eq(gateResults.status, "stale"),
        ),
      )
      .limit(1);

    if (staleGates.length === 0) continue;

    // NO fresh re-entry attempt created AFTER the takeover → the resume never
    // progressed past the return flip. A non-takeover (`owner_user_id IS
    // NULL`) re-entry-node attempt started after the takeover row means the
    // runner already re-attached; that run is NOT stranded. The temporal
    // guard is REQUIRED: the prior (pre-takeover) re-entry attempt whose gate
    // got staled also has a null owner, so a bare "no null-owner attempt"
    // check would wrongly reject the candidate. The comparison joins the
    // takeover row so started_at is compared column-to-column at full Postgres
    // microsecond precision — reading row.takeoverStartedAt (schema mode:"date")
    // truncates to milliseconds, and a same-millisecond pre-takeover attempt
    // would then spuriously match as "fresh", leaving a stranded run
    // unrecovered.
    const freshReentry: Array<{ id: string }> = await db
      .select({ id: nodeAttempts.id })
      .from(nodeAttempts)
      .innerJoin(takeoverRow, eq(takeoverRow.id, row.takeoverAttemptId))
      .where(
        and(
          eq(nodeAttempts.runId, row.runId),
          eq(nodeAttempts.nodeId, reentryNodeId),
          isNull(nodeAttempts.ownerUserId),
          gt(nodeAttempts.startedAt, takeoverRow.startedAt),
        ),
      )
      .limit(1);

    if (freshReentry.length > 0) continue;

    stranded.push(row.runId);
  }

  return stranded;
}

export async function runTakeoverReturnRecoverySweep(
  opts: TakeoverReturnRecoverySweepOptions = {},
): Promise<TakeoverReturnRecoverySweepResult> {
  const db = opts.db ?? getDb();

  const stranded = await fetchStrandedTakeoverRuns(db);

  if (stranded.length === 0) {
    log.info({}, "takeover-return recovery sweep: no stranded-Running rows");

    return { candidatesFound: 0, reDispatched: 0 };
  }

  log.info(
    { candidates: stranded.length },
    "takeover-return recovery sweep: stranded-Running rows found — re-dispatching",
  );

  const runFlow: RunFlowEntry =
    opts.runFlow ??
    (async (runId, runOpts) => {
      const mod = await import("@/lib/flows/runner");

      await mod.runFlow(runId, runOpts);
    });

  let reDispatched = 0;

  await runWithConcurrency(stranded, PER_PASS_CONCURRENCY, async (runId) => {
    try {
      await runFlow(runId, { db });
      reDispatched += 1;
      log.info(
        { runId },
        "takeover-return recovery: re-dispatched graph runner at current_step_id",
      );
    } catch (err) {
      log.warn(
        { runId, err: err instanceof Error ? err.message : String(err) },
        "takeover-return recovery: re-dispatch threw (non-fatal — CAS guards idempotency)",
      );
    }
  });

  log.info(
    { candidatesFound: stranded.length, reDispatched },
    "takeover-return recovery sweep complete",
  );

  return { candidatesFound: stranded.length, reDispatched };
}
