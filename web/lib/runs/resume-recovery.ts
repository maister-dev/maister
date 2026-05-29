import "server-only";

import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
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
const { hitlRequests, runs } = schemaModule as unknown as Record<string, any>;

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
    log.info(
      {},
      "[FIX] resume-recovery sweep: no claimed-but-undelivered rows",
    );

    return {
      candidatesFound: 0,
      rescheduled: 0,
      rolledBack: 0,
      skipped: 0,
    };
  }

  log.info(
    { candidates: candidates.length },
    "[FIX] resume-recovery sweep: claimed-but-undelivered rows found",
  );

  const sessionLoad = await loadSessions();

  // Transient supervisor unavailability: skip this boot. The keepalive
  // sweeper's TTL Pass 2 is the long-term safety net (NeedsInput rows
  // stuck past keepaliveUntil → NeedsInputIdle → eventually Abandoned).
  if (!sessionLoad.ok) {
    log.warn(
      { candidates: candidates.length, reason: sessionLoad.reason },
      "[FIX] resume-recovery sweep: supervisor listSessions failed — skipping all candidates this boot",
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
        "[FIX] resume-recovery: driver re-scheduled against live supervisor session",
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
        "[FIX] resume-recovery: supervisor session gone — rolled back to NeedsInputIdle, intent preserved",
      );
    } else {
      skipped += 1;
      log.warn(
        {
          runId: cand.runId,
          acpSessionId: cand.acpSessionId,
          reason: rb.reason,
        },
        "[FIX] resume-recovery: rollback status-guard mismatch — concurrent transition won, leaving row alone",
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
    "[FIX] resume-recovery sweep complete",
  );

  return {
    candidatesFound: candidates.length,
    rescheduled,
    rolledBack,
    skipped,
  };
}
