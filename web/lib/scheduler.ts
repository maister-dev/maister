import "server-only";

import { and, asc, count, eq, inArray, lt, sql } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "scheduler",
  level: process.env.LOG_LEVEL ?? "info",
});

// M33: owner-requested default bump 3 → 6 (env semantics unchanged).
const DEFAULT_CAP = 6;
// M33 (ADR-087): separate budget for platform-agent runs (run_kind='agent').
const DEFAULT_AGENT_CAP = 3;

export type SchedulerPool = "flow" | "agent";

// The flow pool covers delivery + scratch runs; agent runs never consume it.
const POOL_RUN_KINDS: Record<SchedulerPool, string[]> = {
  flow: ["flow", "scratch"],
  agent: ["agent"],
};

export function poolForRunKind(runKind: string): SchedulerPool {
  return runKind === "agent" ? "agent" : "flow";
}

// Fixed pg_advisory_xact_lock key for the global scheduler. Both
// tryStartRun and promoteNextPending take this lock at the start of
// their transactions so the count-then-update pattern is serialized
// across concurrent launches. Postgres releases it automatically when
// the transaction ends (commit or rollback). On sqlite the lock call
// is silently skipped — sqlite already serializes writes via a single
// writer lock so the count+update is safe there too.
const SCHEDULER_LOCK_KEY = 0x6d61_6973;

function isPostgresDb(): boolean {
  const url = process.env.DB_URL ?? "";

  return url.startsWith("postgres://") || url.startsWith("postgresql://");
}

export async function takeSchedulerLock(tx: Db): Promise<void> {
  if (!isPostgresDb()) return;

  try {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${SCHEDULER_LOCK_KEY})`);
  } catch (err) {
    log.warn(
      { err: (err as Error).message },
      "advisory-lock-failed (continuing without serialization)",
    );
  }
}

function parseCapEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed < 1) return fallback;

  return parsed;
}

function capFromEnv(): number {
  return parseCapEnv(process.env.MAISTER_MAX_CONCURRENT_RUNS, DEFAULT_CAP);
}

function agentCapFromEnv(): number {
  return parseCapEnv(
    process.env.MAISTER_MAX_CONCURRENT_AGENTS,
    DEFAULT_AGENT_CAP,
  );
}

export function maxConcurrentRunsCap(): number {
  return capFromEnv();
}

export function maxConcurrentAgentRunsCap(): number {
  return agentCapFromEnv();
}

export function capForPool(pool: SchedulerPool): number {
  return pool === "agent" ? agentCapFromEnv() : capFromEnv();
}

// The one cap predicate: a run holds a scheduler slot while it is in any of
// these statuses. Counted per pool (M33): flow/scratch and agent runs hold
// independent budgets. Takes the caller's db/tx handle so tryStartRun /
// promoteNextPending keep counting INSIDE their advisory-lock transactions.
export async function countLiveRuns(
  dbOrTx: Db,
  pool: SchedulerPool = "flow",
): Promise<number> {
  const liveRows: Array<{ count: number }> = await dbOrTx
    .select({ count: count() })
    .from(runs)
    .where(
      and(
        inArray(runs.status, ["Running", "NeedsInput", "HumanWorking"]),
        inArray(runs.runKind, POOL_RUN_KINDS[pool]),
      ),
    );

  return Number(liveRows[0]?.count ?? 0);
}

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

export type TryStartRunResult =
  | { started: true }
  | { started: false; queuePosition: number };

export type ScratchCapacityDecision = {
  allowed: boolean;
  cap: number;
  liveCount: number;
};

export function scratchCapacityDecision(
  liveCount: number,
  cap: number,
): ScratchCapacityDecision {
  return {
    allowed: liveCount < cap,
    cap,
    liveCount,
  };
}

export async function assertScratchCapacityAvailable(
  opts: { db?: Db } = {},
): Promise<ScratchCapacityDecision> {
  const db = opts.db ?? getDb();

  return db.transaction(async (tx: Db) =>
    assertScratchCapacityAvailableInTransaction(tx),
  );
}

export async function assertScratchCapacityAvailableInTransaction(
  tx: Db,
): Promise<ScratchCapacityDecision> {
  const cap = capFromEnv();

  await takeSchedulerLock(tx);

  const liveRows: Array<{ count: number }> = await tx
    .select({ count: count() })
    .from(runs)
    .where(
      and(
        inArray(runs.status, ["Running", "NeedsInput"]),
        inArray(runs.runKind, POOL_RUN_KINDS.flow),
      ),
    );

  const liveCount = Number(liveRows[0]?.count ?? 0);
  const decision = scratchCapacityDecision(liveCount, cap);

  log.debug(
    { liveCount: decision.liveCount, cap: decision.cap },
    "scratch capacity cap-check",
  );

  if (!decision.allowed) {
    throw new MaisterError(
      "CONFLICT",
      `scratch run capacity is full: liveCount=${liveCount}, cap=${cap}`,
    );
  }

  return decision;
}

export async function tryStartRun(
  runId: string,
  opts: { db?: Db } = {},
): Promise<TryStartRunResult> {
  const db = opts.db ?? getDb();

  return db.transaction(async (tx: Db) => {
    await takeSchedulerLock(tx);

    const targetRows: Array<{ runKind: string; startedAt: Date }> = await tx
      .select({ runKind: runs.runKind, startedAt: runs.startedAt })
      .from(runs)
      .where(eq(runs.id, runId));
    const pool = poolForRunKind(targetRows[0]?.runKind ?? "flow");
    const cap = capForPool(pool);

    const liveCount = await countLiveRuns(tx, pool);

    log.debug({ runId, pool, liveCount, cap }, "tryStartRun cap-check");

    if (liveCount < cap) {
      const startedRows: Array<{ projectId: string }> = await tx
        .update(runs)
        .set({ status: "Running", startedAt: new Date() })
        .where(and(eq(runs.id, runId), eq(runs.status, "Pending")))
        .returning({ projectId: runs.projectId });

      if (startedRows.length > 0) {
        await emitWebhookEvent({
          db: tx,
          type: "run.started",
          projectId: startedRows[0].projectId,
          runId,
          data: { trigger: "direct" },
        });
      }

      log.info({ runId, pool, liveCount, cap }, "tryStartRun → started");

      return { started: true } satisfies TryStartRunResult;
    }

    const targetStartedAt = targetRows[0]?.startedAt ?? new Date();

    // Queue position is computed within the run's own pool — agent runs
    // never queue behind flow runs and vice versa.
    const aheadRows: Array<{ count: number }> = await tx
      .select({ count: count() })
      .from(runs)
      .where(
        and(
          eq(runs.status, "Pending"),
          inArray(runs.runKind, POOL_RUN_KINDS[pool]),
          lt(runs.startedAt, targetStartedAt),
        ),
      );

    const queuePosition = Number(aheadRows[0]?.count ?? 0) + 1;

    log.info(
      { runId, pool, liveCount, cap, queuePosition },
      "tryStartRun → queued",
    );

    return { started: false, queuePosition } satisfies TryStartRunResult;
  });
}

export type PromoteNextPendingOptions = {
  db?: Db;
  runFlow?: (runId: string) => void;
  resumeRun?: (runId: string) => void;
  // M33: which budget pool to promote within (default flow — every
  // pre-existing caller frees a flow/scratch slot).
  pool?: SchedulerPool;
  startAgentRun?: (runId: string) => void;
};

// M8 D2: NeedsInputIdle does NOT count toward the cap. When the keep-alive
// sweeper checkpoints a NeedsInput row into NeedsInputIdle the slot is
// freed; this helper logs the transition AND drives promoteNextPending so
// any queued Pending row can move into the freed slot.
export type ReleaseSlotOnIdleOptions = {
  runId: string;
  db?: Db;
  runFlow?: (runId: string) => void;
};

export async function releaseSlotOnIdle(
  opts: ReleaseSlotOnIdleOptions,
): Promise<{ promotedRunId: string | null }> {
  log.debug(
    { runId: opts.runId },
    "releaseSlotOnIdle — NeedsInputIdle transition freed scheduler slot",
  );

  // The freed slot belongs to the idled run's own pool (M33).
  const db = opts.db ?? getDb();
  const rows: Array<{ runKind: string }> = await db
    .select({ runKind: runs.runKind })
    .from(runs)
    .where(eq(runs.id, opts.runId));
  const pool = poolForRunKind(rows[0]?.runKind ?? "flow");

  return promoteNextPending({ db: opts.db, runFlow: opts.runFlow, pool });
}

export async function promoteNextPending(
  opts: PromoteNextPendingOptions = {},
): Promise<{ promotedRunId: string | null }> {
  const db = opts.db ?? getDb();

  const pool: SchedulerPool = opts.pool ?? "flow";
  const cap = capForPool(pool);

  // M19 Phase 3: lazy dispatch defaults so the queued-resume loop closes for
  // ALL callers (e.g. the discard route) without per-caller wiring. Dynamic
  // imports break the runner/recover import cycle (scheduler is imported by
  // both). Explicit opts.runFlow/opts.resumeRun (tests, abandon route) still win.
  const runFlowFn =
    opts.runFlow ??
    ((id: string) => {
      void import("@/lib/flows/runner")
        .then((m) => m.runFlow(id))
        .catch((err: unknown) => {
          log.error(
            { err: (err as Error).message, promotedRunId: id },
            "promoteNextPending default runFlow dispatch threw",
          );
        });
    });
  const resumeFn =
    opts.resumeRun ??
    ((id: string) => {
      void import("@/lib/runs/recover")
        .then((m) => m.driveResume(id))
        .catch((err: unknown) => {
          log.error(
            { err: (err as Error).message, promotedRunId: id },
            "promoteNextPending default resumeRun dispatch threw",
          );
        });
    });
  // M33: agent-pool promotions dispatch the agent session starter — it
  // resumes via acpSessionId itself, so one dispatch fn covers both paths.
  const startAgentFn =
    opts.startAgentRun ??
    ((id: string) => {
      void import("@/lib/agents/launch")
        .then((m) => m.startAgentSession(id))
        .catch((err: unknown) => {
          log.error(
            { err: (err as Error).message, promotedRunId: id },
            "promoteNextPending default startAgentRun dispatch threw",
          );
        });
    });

  const promoted = await db.transaction(async (tx: Db) => {
    await takeSchedulerLock(tx);

    // Recheck cap under the lock — a Running/NeedsInput/HumanWorking run
    // could have started between this terminal transition and the
    // promote call (e.g. another tryStartRun acquired the lock
    // ahead of us), and we must respect the cap globally.
    const liveCount = await countLiveRuns(tx, pool);

    if (liveCount >= cap) {
      log.debug(
        { pool, liveCount, cap },
        "promoteNextPending → cap reached, leaving Pending in place",
      );

      return null;
    }

    // M19 Phase 1 (T1.B, Codex F2): fetch acp_session_id alongside the id so
    // a checkpointed Pending row (queued after an idle-resume claim) is
    // resumed via --resume rather than re-run from the start of the flow.
    const oldest: Array<{
      id: string;
      acpSessionId: string | null;
      runKind: string;
    }> = await tx
      .select({
        id: runs.id,
        acpSessionId: runs.acpSessionId,
        runKind: runs.runKind,
      })
      .from(runs)
      .where(
        and(
          eq(runs.status, "Pending"),
          inArray(runs.runKind, POOL_RUN_KINDS[pool]),
        ),
      )
      .orderBy(asc(runs.startedAt))
      .limit(1)
      .for("update", { skipLocked: true } as never);

    const target = oldest[0];

    if (!target) return null;

    const isAgent = target.runKind === "agent";
    const isResume = !isAgent && target.acpSessionId != null;
    const now = new Date();

    const promotedRows: Array<{ projectId: string }> = await tx
      .update(runs)
      .set(
        isResume
          ? { status: "Running", startedAt: now, resumeStartedAt: now }
          : { status: "Running", startedAt: now },
      )
      .where(and(eq(runs.id, target.id), eq(runs.status, "Pending")))
      .returning({ projectId: runs.projectId });

    if (promotedRows.length === 0) return null;

    await emitWebhookEvent({
      db: tx,
      type: "run.started",
      projectId: promotedRows[0].projectId,
      runId: target.id,
      data: { trigger: "queue_promote" },
    });

    return { id: target.id, isResume, isAgent };
  });

  if (promoted && promoted.isAgent) {
    log.info({ runId: promoted.id }, "[scheduler] promoting queued agent run");
    queueMicrotask(() => {
      try {
        startAgentFn(promoted.id);
      } catch (err) {
        log.error(
          { err: (err as Error).message, promotedRunId: promoted.id },
          "promoteNextPending startAgentRun dispatch failed",
        );
      }
    });
  } else if (promoted && promoted.isResume) {
    log.info({ runId: promoted.id }, "[scheduler] promoting queued resume");
    queueMicrotask(() => {
      try {
        resumeFn(promoted.id);
      } catch (err) {
        log.error(
          { err: (err as Error).message, promotedRunId: promoted.id },
          "promoteNextPending resumeRun dispatch failed",
        );
      }
    });
  } else if (promoted) {
    log.info({ promotedRunId: promoted.id }, "promoteNextPending → promoting");
    queueMicrotask(() => {
      try {
        runFlowFn(promoted.id);
      } catch (err) {
        log.error(
          { err: (err as Error).message, promotedRunId: promoted.id },
          "promoteNextPending runFlow dispatch failed",
        );
      }
    });
  } else {
    log.debug({}, "promoteNextPending → nothing to promote");
  }

  return { promotedRunId: promoted?.id ?? null };
}

// Helper exported so tests can compute cap without env mocking.
export function _maxConcurrentRunsFromEnv(): number {
  return capFromEnv();
}

// Reserved drizzle sql helper kept exported so the runner can build
// custom queries without a second import line. Currently unused
// externally — keep for follow-up M5+ work where the scheduler grows
// the cap into a per-project policy.
export const _sqlBuilder = sql;
