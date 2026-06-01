import "server-only";

import { and, asc, count, eq, inArray, lt, sql } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "scheduler",
  level: process.env.LOG_LEVEL ?? "info",
});

const DEFAULT_CAP = 3;

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

async function takeSchedulerLock(tx: Db): Promise<void> {
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

function capFromEnv(): number {
  const raw = process.env.MAISTER_MAX_CONCURRENT_RUNS;

  if (!raw) return DEFAULT_CAP;
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_CAP;

  return parsed;
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
    .where(inArray(runs.status, ["Running", "NeedsInput"]));

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
  const cap = capFromEnv();

  return db.transaction(async (tx: Db) => {
    await takeSchedulerLock(tx);

    const liveRows: Array<{ count: number }> = await tx
      .select({ count: count() })
      .from(runs)
      .where(inArray(runs.status, ["Running", "NeedsInput", "HumanWorking"]));

    const liveCount = Number(liveRows[0]?.count ?? 0);

    log.debug({ runId, liveCount, cap }, "tryStartRun cap-check");

    if (liveCount < cap) {
      await tx
        .update(runs)
        .set({ status: "Running", startedAt: new Date() })
        .where(and(eq(runs.id, runId), eq(runs.status, "Pending")));

      log.info({ runId, liveCount, cap }, "tryStartRun → started");

      return { started: true } satisfies TryStartRunResult;
    }

    const targetRows: Array<{ startedAt: Date }> = await tx
      .select({ startedAt: runs.startedAt })
      .from(runs)
      .where(eq(runs.id, runId));

    const targetStartedAt = targetRows[0]?.startedAt ?? new Date();

    const aheadRows: Array<{ count: number }> = await tx
      .select({ count: count() })
      .from(runs)
      .where(
        and(eq(runs.status, "Pending"), lt(runs.startedAt, targetStartedAt)),
      );

    const queuePosition = Number(aheadRows[0]?.count ?? 0) + 1;

    log.info({ runId, liveCount, cap, queuePosition }, "tryStartRun → queued");

    return { started: false, queuePosition } satisfies TryStartRunResult;
  });
}

export type PromoteNextPendingOptions = {
  db?: Db;
  runFlow?: (runId: string) => void;
  resumeRun?: (runId: string) => void;
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

  return promoteNextPending({ db: opts.db, runFlow: opts.runFlow });
}

export async function promoteNextPending(
  opts: PromoteNextPendingOptions = {},
): Promise<{ promotedRunId: string | null }> {
  const db = opts.db ?? getDb();

  const cap = capFromEnv();

  const promoted = await db.transaction(async (tx: Db) => {
    await takeSchedulerLock(tx);

    // Recheck cap under the lock — a Running/NeedsInput/HumanWorking run
    // could have started between this terminal transition and the
    // promote call (e.g. another tryStartRun acquired the lock
    // ahead of us), and we must respect the cap globally.
    const liveRows: Array<{ count: number }> = await tx
      .select({ count: count() })
      .from(runs)
      .where(inArray(runs.status, ["Running", "NeedsInput", "HumanWorking"]));

    const liveCount = Number(liveRows[0]?.count ?? 0);

    if (liveCount >= cap) {
      log.debug(
        { liveCount, cap },
        "promoteNextPending → cap reached, leaving Pending in place",
      );

      return null;
    }

    // M19 Phase 1 (T1.B, Codex F2): fetch acp_session_id alongside the id so
    // a checkpointed Pending row (queued after an idle-resume claim) is
    // resumed via --resume rather than re-run from the start of the flow.
    const oldest: Array<{ id: string; acpSessionId: string | null }> = await tx
      .select({ id: runs.id, acpSessionId: runs.acpSessionId })
      .from(runs)
      .where(eq(runs.status, "Pending"))
      .orderBy(asc(runs.startedAt))
      .limit(1)
      .for("update", { skipLocked: true } as never);

    const target = oldest[0];

    if (!target) return null;

    const isResume = target.acpSessionId != null;
    const now = new Date();

    await tx
      .update(runs)
      .set(
        isResume
          ? { status: "Running", startedAt: now, resumeStartedAt: now }
          : { status: "Running", startedAt: now },
      )
      .where(and(eq(runs.id, target.id), eq(runs.status, "Pending")));

    return { id: target.id, isResume };
  });

  if (promoted && promoted.isResume) {
    log.info(
      { runId: promoted.id },
      "[scheduler] promoting queued resume",
    );
    queueMicrotask(() => {
      try {
        opts.resumeRun?.(promoted.id);
      } catch (err) {
        log.error(
          { err: (err as Error).message, promotedRunId: promoted.id },
          "promoteNextPending resumeRun dispatch failed",
        );
      }
    });
  } else if (promoted && opts.runFlow) {
    log.info({ promotedRunId: promoted.id }, "promoteNextPending → promoting");
    queueMicrotask(() => {
      try {
        opts.runFlow?.(promoted.id);
      } catch (err) {
        log.error(
          { err: (err as Error).message, promotedRunId: promoted.id },
          "promoteNextPending runFlow dispatch failed",
        );
      }
    });
  } else if (!promoted) {
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
