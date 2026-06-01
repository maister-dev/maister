import { Pool } from "pg";

import { E2E_DB_URL } from "./db-url";

export async function withE2EDb<T>(
  fn: (pool: Pool) => Promise<T>,
): Promise<T> {
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
