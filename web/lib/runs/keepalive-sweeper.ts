import "server-only";

import { and, asc, eq, isNotNull, isNull, lt } from "drizzle-orm";
import pino from "pino";

import { markCheckpointed } from "./state-transitions";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { releaseSlotOnIdle } from "@/lib/scheduler";
import {
  checkpointSession,
  listSessions,
  type SupervisorSessionRecord,
} from "@/lib/supervisor-client";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { hitlRequests, runs } = schemaModule as unknown as Record<string, any>;

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

async function loadSupervisorSessions(): Promise<SessionMap | null> {
  try {
    const records = await listSessions();
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
  } catch (err) {
    log.warn(
      { err: (err as Error).message },
      "sweeper listSessions failed — pass 1 will treat all candidates as non-live and checkpoint them directly",
    );

    return null;
  }
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

type Pass2Candidate = { id: string };

async function fetchPass2Candidates(
  db: Db,
  ttlHours: number,
): Promise<Pass2Candidate[]> {
  const cutoff = new Date(Date.now() - ttlHours * 3600_000);
  const rows = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.status, "NeedsInputIdle"),
        isNotNull(runs.checkpointAt),
        lt(runs.checkpointAt, cutoff),
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

  // [FIX] M8 review finding #1: when listSessions() fails we cannot
  // distinguish "session is gone" from "supervisor is transiently
  // unreachable". Marking the row NeedsInputIdle in the latter case
  // produces a split-brain state — the agent is still alive holding
  // the original permission deferred, but the DB says the slot is
  // free and the run is idle. Refuse to act on any candidate and
  // wait for the next tick.
  if (supervisorMap === null) {
    log.warn(
      { candidateCount: candidates.length },
      "[FIX] sweeper pass1 aborted — listSessions failed; leaving candidates in NeedsInput for next tick",
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

async function runPass2(db: Db): Promise<number> {
  const ttlHours = needsInputIdleTtlHours();
  const candidates = await fetchPass2Candidates(db, ttlHours);

  if (candidates.length === 0) return 0;

  let abandoned = 0;

  await runWithConcurrency(candidates, PER_PASS_CONCURRENCY, async (row) => {
    const updated = await db
      .update(runs)
      .set({ status: "Abandoned", endedAt: new Date() })
      .where(and(eq(runs.id, row.id), eq(runs.status, "NeedsInputIdle")))
      .returning({ id: runs.id });

    if (updated.length === 0) {
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

    // M8 T12: mark any open hitl_requests row for this run with
    // respondedAt=now() so the operator UI shows the request as closed.
    // Audit metadata (abandonedReason) lives in the run-level audit
    // surface (M9+ inbox); a hitl_requests-level audit column would
    // require a migration and is intentionally deferred.
    await db
      .update(hitlRequests)
      .set({ respondedAt: new Date() })
      .where(
        and(eq(hitlRequests.runId, row.id), isNull(hitlRequests.respondedAt)),
      );
  });

  return abandoned;
}

export type SweepResult = {
  scannedRunsCount: number;
  idledCount: number;
  abandonedCount: number;
};

export async function runSweepTick(
  opts: { db?: Db } = {},
): Promise<SweepResult> {
  const db = opts.db ?? getDb();
  const idledCount = await runPass1(db);
  const abandonedCount = await runPass2(db);
  const scannedRunsCount = idledCount + abandonedCount;

  log.info(
    {
      scannedRunsCount,
      idledCount,
      abandonedCount,
      sweepIntervalSeconds: sweepIntervalSeconds(),
    },
    "sweeper tick complete",
  );

  return { scannedRunsCount, idledCount, abandonedCount };
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
