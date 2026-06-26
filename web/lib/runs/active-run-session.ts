import "server-only";

import type { RunnerSnapshot } from "@/lib/db/schema";

import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";

import { runSessions } from "@/lib/db/schema";

// FIXME(any): getDb() returns a pg|sqlite drizzle union and callers also pass a
// transaction handle; mirrors the `Db = any` already used by runner-core /
// gate-chat. POC target = Postgres.
type Db = any;

// M42 (ADR-114): the per-session runner/resume state for one logical session.
// After the contract migration drops the `runs.{runner_id,
// runner_resolution_tier, capability_agent, runner_snapshot, acp_session_id}`
// mirror, `run_sessions` is the SOLE source of truth — every reader that used
// to read those run-level columns reads a session here instead.
export interface ActiveRunSession {
  sessionName: string;
  acpSessionId: string | null;
  runnerSnapshot: RunnerSnapshot | null;
  capabilityAgent: string | null;
  runnerId: string | null;
  runnerResolutionTier: string | null;
}

function toActiveRunSession(row: Record<string, unknown>): ActiveRunSession {
  return {
    sessionName: row.sessionName as string,
    acpSessionId: (row.acpSessionId ?? null) as string | null,
    runnerSnapshot: (row.runnerSnapshot ?? null) as RunnerSnapshot | null,
    capabilityAgent: (row.capabilityAgent ?? null) as string | null,
    runnerId: (row.runnerId ?? null) as string | null,
    runnerResolutionTier: (row.runnerResolutionTier ?? null) as string | null,
  };
}

// The run's ACTIVE logical session — the one whose ACP process is live/paused.
// Sessions are sequential, so the active one is the most-recently-updated
// `run_sessions` row that still holds a live `acp_session_id`. When no session
// has a live handle (a fresh launch, or all sessions exited) it falls back to
// the most-recently-updated row so the resolved `runner_snapshot` / agent stay
// available, and to null only when the run has no sessions at all.
export async function loadActiveRunSession(
  db: Db,
  runId: string,
): Promise<ActiveRunSession | null> {
  const live = await db
    .select()
    .from(runSessions)
    .where(
      and(eq(runSessions.runId, runId), isNotNull(runSessions.acpSessionId)),
    )
    .orderBy(desc(runSessions.updatedAt))
    .limit(1);

  if (live[0]) return toActiveRunSession(live[0]);

  const latest = await db
    .select()
    .from(runSessions)
    .where(eq(runSessions.runId, runId))
    .orderBy(desc(runSessions.updatedAt))
    .limit(1);

  return latest[0] ? toActiveRunSession(latest[0]) : null;
}

// Every logical session of a run, newest first — the terminal/promote/abandon
// paths iterate this to close EVERY live ACP process + cancel its deferreds (a
// run may hold N sessions; only the active one is live, the rest already exited).
export async function loadRunSessions(
  db: Db,
  runId: string,
): Promise<ActiveRunSession[]> {
  const rows = await db
    .select()
    .from(runSessions)
    .where(eq(runSessions.runId, runId))
    .orderBy(desc(runSessions.updatedAt));

  return rows.map(toActiveRunSession);
}

// Persist a dispatch's resume handle onto a logical session's row (the sole
// source of truth). The linear runner pins the run's single `default` session;
// the graph runner persists per-node inline.
export async function persistRunSessionAcpSessionId(
  db: Db,
  runId: string,
  sessionName: string,
  acpSessionId: string,
): Promise<void> {
  await db
    .update(runSessions)
    .set({ acpSessionId, updatedAt: new Date() })
    .where(
      and(
        eq(runSessions.runId, runId),
        eq(runSessions.sessionName, sessionName),
      ),
    );
}

// Batch variant for list/sweep readers: the ACTIVE session per run id (same
// "live handle wins, else newest" rule as `loadActiveRunSession`). Runs with no
// `run_sessions` row are simply absent from the map.
export async function loadActiveRunSessionsByRunId(
  db: Db,
  runIds: readonly string[],
): Promise<Map<string, ActiveRunSession>> {
  const out = new Map<string, ActiveRunSession>();

  if (runIds.length === 0) return out;

  const rows = await db
    .select()
    .from(runSessions)
    .where(inArray(runSessions.runId, [...new Set(runIds)]))
    .orderBy(desc(runSessions.updatedAt));

  for (const row of rows) {
    const runId = row.runId as string;
    const active = toActiveRunSession(row);
    const existing = out.get(runId);

    // First (most-recent) row per run wins; a later row only replaces it when
    // it carries a live acp handle the incumbent lacks.
    if (!existing) out.set(runId, active);
    else if (!existing.acpSessionId && active.acpSessionId) {
      out.set(runId, active);
    }
  }

  return out;
}
