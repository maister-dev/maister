import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { SqlTransaction } from "@/lib/db/sql-types";

import { sql } from "drizzle-orm";

type Admission = "apply" | "review_required";

type ExecutionSource = Readonly<{
  trigger_source: string | null;
  external_task: boolean;
  tainted: boolean;
  user_initiated: boolean;
  parent_run_id: string | null;
  root_run_id: string | null;
  retry_of_run_id: string | null;
}>;

const MAX_LINEAGE = 128;
const DIRECT_INPUT_SOURCES = new Set([
  "manual",
  "cron",
  "domain_event",
  "scheduled",
]);

export async function executionVaultWriteAdmission(
  db: Db,
  runId: string,
): Promise<Admission> {
  const active = new Set<string>();
  const admitted = new Set<string>();

  async function isInternalInput(id: string): Promise<boolean> {
    if (admitted.has(id)) return true;
    if (active.has(id) || active.size + admitted.size >= MAX_LINEAGE)
      return false;
    const result = await db.execute<ExecutionSource>(sql`
      SELECT r.trigger_source, r.parent_run_id, r.root_run_id, r.retry_of_run_id,
        r.created_by_user_id IS NOT NULL AS user_initiated,
        EXISTS (SELECT 1 FROM agent_memory_external_tasks source WHERE source.task_id = r.task_id) AS external_task,
        EXISTS (SELECT 1 FROM agent_memory_tainted_runs source WHERE source.run_id = r.id) AS tainted
      FROM runs r
      WHERE r.id = ${id}
    `);
    const source = result.rows[0];

    if (
      !source ||
      source.trigger_source === "webhook" ||
      source.external_task ||
      source.tainted
    )
      return false;
    // Roots can carry their own ID. A self-parent or self-retry remains invalid.
    const ancestors = [
      source.parent_run_id,
      source.retry_of_run_id,
      source.root_run_id === id ? null : source.root_run_id,
    ].filter((value): value is string => value !== null);

    if (
      ancestors.length === 0 &&
      (source.trigger_source === null
        ? !source.user_initiated
        : !DIRECT_INPUT_SOURCES.has(source.trigger_source))
    )
      return false;
    active.add(id);
    for (const ancestor of new Set(ancestors)) {
      if (!(await isInternalInput(ancestor))) return false;
    }
    active.delete(id);
    admitted.add(id);

    return true;
  }

  if (await isInternalInput(runId)) return "apply";
  await db.execute(
    sql`INSERT INTO agent_memory_tainted_runs(run_id) VALUES (${runId}) ON CONFLICT DO NOTHING`,
  );

  return "review_required";
}

export async function captureVaultInputTaint(
  db: SqlTransaction,
  sourceRunId: string,
  recipientRunId: string,
): Promise<void> {
  // Parent lineage is checked at the vault boundary. Persist the fact at
  // delivery, so even later source cleanup cannot relax the receiving run.
  await db.execute(sql`
    INSERT INTO agent_memory_tainted_runs(run_id)
    SELECT ${recipientRunId} WHERE EXISTS (
      SELECT 1 FROM runs source
      WHERE source.id=${sourceRunId} AND (
        source.trigger_source='webhook'
        OR EXISTS (SELECT 1 FROM agent_memory_tainted_runs t WHERE t.run_id=source.id)
        OR EXISTS (SELECT 1 FROM agent_memory_external_tasks t WHERE t.task_id=source.task_id)
      )
    ) ON CONFLICT DO NOTHING
  `);
}
