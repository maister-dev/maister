import { Pool } from "pg";

import { E2E_DB_URL } from "./db-url";

export async function withE2EDb<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: E2E_DB_URL });

  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

export async function countRows(
  tableName:
    | "projects"
    | "runs"
    | "scratch_runs"
    | "tasks"
    | "users"
    | "workspaces",
  whereSql: string,
  values: readonly unknown[],
): Promise<number> {
  return withE2EDb(async (pool) => {
    const result = await pool.query<{ value: string }>(
      `SELECT count(*)::text AS value FROM ${tableName} WHERE ${whereSql}`,
      [...values],
    );

    return Number(result.rows[0]?.value ?? 0);
  });
}

export async function singleValue<T>(
  sql: string,
  values: readonly unknown[],
): Promise<T | null> {
  return withE2EDb(async (pool) => {
    const result = await pool.query<{ value: T }>(sql, [...values]);

    return result.rows[0]?.value ?? null;
  });
}

// The standard single-runner `claude` snapshot shape the UI rail/list readers
// expect (executorDisplay needs both `id` and `model`).
export function e2eClaudeRunnerSnapshot(runnerId: string) {
  return {
    id: runnerId,
    adapter: "claude",
    capabilityAgent: "claude",
    model: "claude-sonnet-4-6",
    provider: { kind: "anthropic" },
    providerKind: "anthropic",
    permissionPolicy: "default",
    sidecar: null,
    sidecarId: null,
  };
}

// M42 (ADR-114): `runs` no longer carries the runner/resume mirror columns
// (runner_id, runner_resolution_tier, capability_agent, runner_snapshot,
// acp_session_id) — `run_sessions` is the SOLE source of truth. Spec seeds insert
// the run WITHOUT those columns, then add the run's `default` session here
// (mirrors the production insert in lib/services/runs.ts).
export async function seedDefaultRunSession(
  pool: Pool,
  args: {
    acpSessionId?: string | null;
    capabilityAgent?: string | null;
    runId: string;
    runnerId: string | null;
    runnerResolutionTier?: string | null;
    runnerSnapshot?: unknown;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO run_sessions (id, run_id, session_name, runner_id, runner_resolution_tier, capability_agent, runner_snapshot, acp_session_id)
     VALUES ($1, $2, 'default', $3, $4, $5, $6, $7)
     ON CONFLICT (run_id, session_name) DO NOTHING`,
    [
      `${args.runId}-default`,
      args.runId,
      args.runnerId,
      args.runnerResolutionTier ?? null,
      args.capabilityAgent ?? null,
      args.runnerSnapshot != null ? JSON.stringify(args.runnerSnapshot) : null,
      args.acpSessionId ?? null,
    ],
  );
}
