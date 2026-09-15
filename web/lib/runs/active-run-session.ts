import "server-only";

import type { AdapterId } from "@/lib/acp-runners/adapter-support";
import type { RunnerSnapshot } from "@/lib/db/schema";
import type { AnyColumn, SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { desc, eq, getTableName, inArray, sql } from "drizzle-orm";

import { runSessionIncarnations, runSessions } from "@/lib/db/schema";
import * as schema from "@/lib/db/schema";

type ReadDb = Pick<NodePgDatabase<typeof schema>, "select">;

// M42 (ADR-114): the per-session runner/resume state for one logical session.
// After the contract migration drops the `runs.{runner_id,
// runner_resolution_tier, capability_agent, runner_snapshot, acp_session_id}`
// mirror, `run_sessions` is the SOLE source of truth — every reader that used
// to read those run-level columns reads a session here instead.
export interface ActiveRunSession {
  id: string;
  executionAssignmentId: string | null;
  sessionName: string;
  acpSessionId: string | null;
  // ADR-166: the supervisor's own session id (URL key of every host-bound
  // session command) — distinct from the ACP resume handle above.
  hostSessionId: string | null;
  runnerSnapshot: RunnerSnapshot | null;
  capabilityAgent: string | null;
  runnerId: string | null;
  runnerResolutionTier: string | null;
}

function toActiveRunSession(row: Record<string, unknown>): ActiveRunSession {
  return {
    id: row.id as string,
    executionAssignmentId: (row.executionAssignmentId ?? null) as string | null,
    sessionName: row.sessionName as string,
    acpSessionId: (row.acpSessionId ?? null) as string | null,
    hostSessionId: (row.hostSessionId ?? null) as string | null,
    runnerSnapshot: (row.runnerSnapshot ?? null) as RunnerSnapshot | null,
    capabilityAgent: (row.capabilityAgent ?? null) as string | null,
    runnerId: (row.runnerId ?? null) as string | null,
    runnerResolutionTier: (row.runnerResolutionTier ?? null) as string | null,
  };
}

// Liveness, as the incarnation ledger defines it: a session is live when it
// holds a non-terminal incarnation. That is the SAME state set as the partial
// unique index `run_session_incarnations_active_run_session_uq`, so at most one
// incarnation per session qualifies.
//
// `acp_session_id IS NOT NULL` is NOT liveness — it means "has been prompted at
// least once", and it deliberately OUTLIVES the process: it is the
// `session/resume` checkpoint handle, so nothing clears it when an incarnation
// goes terminal. Ranking on it alone let a FINISHED substep session (a consensus
// verification, a gate evaluation) outrank the node's own — it keeps its handle
// and carries a newer `updated_at`, since `updated_at` is bumped only by the
// create ack. Liveness is therefore the first key, the resume handle only breaks
// ties within a liveness class, and a checkpointed session still ranks live
// (`checkpointed` is non-terminal) so idle resume keeps finding it.
function liveIncarnationFor(sessionIdRef: SQL | AnyColumn): SQL {
  return sql`EXISTS (SELECT 1 FROM ${runSessionIncarnations} rsi WHERE rsi.run_session_id = ${sessionIdRef} AND rsi.state IN ('created', 'active', 'checkpointed'))`;
}

// Ordering for the correlated-subquery form, where the row is aliased `rs`.
const ACTIVE_SESSION_ORDER = sql`${liveIncarnationFor(sql`rs.id`)} DESC, (rs.acp_session_id IS NOT NULL) DESC, rs.updated_at DESC`;

// Same three keys for the query-builder form, which addresses real columns.
function activeSessionOrderBy(): SQL[] {
  return [
    sql`${liveIncarnationFor(runSessions.id)} DESC`,
    sql`(${runSessions.acpSessionId} IS NOT NULL) DESC`,
    sql`${runSessions.updatedAt} DESC`,
  ];
}

// M42 (ADR-114): a correlated scalar subquery for a column of a run's ACTIVE
// session (live-first, then resumable, then newest), keyed on a `runs.id` column
// in the outer query. Drop-in replacement for the dropped `runs.<mirror>` columns
// in display/list selects — keeps the select's projected shape identical.
// `runIdCol` is a trusted schema column (never user input); the column names are
// literal.
function activeRunSessionScalar<T>(
  runIdCol: AnyColumn,
  sessionColumn: SQL,
): SQL<T | null> {
  const qualifiedRunId = sql`${sql.identifier(
    getTableName(runIdCol.table),
  )}.${sql.identifier(runIdCol.name)}`;

  return sql<T | null>`(SELECT ${sessionColumn} FROM ${runSessions} rs WHERE rs.run_id = ${qualifiedRunId} ORDER BY ${ACTIVE_SESSION_ORDER} LIMIT 1)`;
}

export function activeSessionAcpSessionId(
  runIdCol: AnyColumn,
): SQL<string | null> {
  return activeRunSessionScalar<string>(runIdCol, sql`rs.acp_session_id`);
}

export function activeSessionCapabilityAgent(
  runIdCol: AnyColumn,
): SQL<AdapterId | null> {
  return activeRunSessionScalar<AdapterId>(runIdCol, sql`rs.capability_agent`);
}

export function activeSessionRunnerSnapshot(
  runIdCol: AnyColumn,
): SQL<RunnerSnapshot | null> {
  return activeRunSessionScalar<RunnerSnapshot>(
    runIdCol,
    sql`rs.runner_snapshot`,
  );
}

export function activeSessionRunnerId(runIdCol: AnyColumn): SQL<string | null> {
  return activeRunSessionScalar<string>(runIdCol, sql`rs.runner_id`);
}

// The run's ACTIVE logical session — the one whose ACP process is live/paused.
// Ranked by `activeSessionOrderBy`: a session holding a non-terminal incarnation
// first (a checkpointed one still counts, so idle resume finds it), then one
// holding a `session/resume` handle, then the most recently bound. When nothing
// is live it still falls back to the newest row so the resolved
// `runner_snapshot` / agent stay available, and to null only when the run has no
// sessions at all.
export async function loadActiveRunSession(
  db: ReadDb,
  runId: string,
): Promise<ActiveRunSession | null> {
  const rows = await db
    .select()
    .from(runSessions)
    .where(eq(runSessions.runId, runId))
    .orderBy(...activeSessionOrderBy())
    .limit(1);

  return rows[0] ? toActiveRunSession(rows[0]) : null;
}

// Every logical session of a run, newest first — the terminal/promote/abandon
// paths iterate this to close EVERY live ACP process + cancel its deferreds (a
// run may hold N sessions; only the active one is live, the rest already exited).
export async function loadRunSessions(
  db: ReadDb,
  runId: string,
): Promise<ActiveRunSession[]> {
  const rows = await db
    .select()
    .from(runSessions)
    .where(eq(runSessions.runId, runId))
    .orderBy(desc(runSessions.updatedAt));

  return rows.map(toActiveRunSession);
}

// Batch variant for list/sweep readers: the ACTIVE session per run id, ranked by
// the same three keys as `loadActiveRunSession`. Because the rows arrive already
// ordered, the FIRST row per run is that run's active session — no second-guess
// merge rule. Runs with no `run_sessions` row are simply absent from the map.
export async function loadActiveRunSessionsByRunId(
  db: ReadDb,
  runIds: readonly string[],
): Promise<Map<string, ActiveRunSession>> {
  const out = new Map<string, ActiveRunSession>();

  if (runIds.length === 0) return out;

  const rows = await db
    .select()
    .from(runSessions)
    .where(inArray(runSessions.runId, [...new Set(runIds)]))
    .orderBy(...activeSessionOrderBy());

  for (const row of rows) {
    const runId = row.runId as string;

    if (!out.has(runId)) out.set(runId, toActiveRunSession(row));
  }

  return out;
}
