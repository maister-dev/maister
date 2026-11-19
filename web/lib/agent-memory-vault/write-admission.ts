import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { sql } from "drizzle-orm";

type Admission = "apply" | "review_required";

type ExecutionSource = Readonly<{
  trigger_source: string | null;
  external_task: boolean;
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
        EXISTS (
          SELECT 1 FROM task_external_sources source
          WHERE source.task_id = r.task_id
        ) AS external_task
      FROM runs r
      WHERE r.id = ${id}
    `);
    const source = result.rows[0];

    if (!source || source.trigger_source === "webhook" || source.external_task)
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

  return (await isInternalInput(runId)) ? "apply" : "review_required";
}
