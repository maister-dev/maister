import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { MaisterError } from "@/lib/errors";

type GuardDb = {
  execute(query: SQL): Promise<{ rows: Array<Record<string, unknown>> }>;
};

// THE project kill-switch predicate (ADR-122). Every consumer of the Brain —
// ext route, ambient inject, harvest, and recall()/retain() themselves — must
// derive enablement from THIS function, never a re-implemented query (the F1
// bug was exactly a second consumer with its own copy).
export async function isProjectBrainEnabled(
  db: GuardDb,
  projectId: string,
): Promise<boolean> {
  const r = await db.execute(
    sql`SELECT brain_enabled FROM projects WHERE id = ${projectId}`,
  );

  return Boolean(r.rows[0]?.brain_enabled);
}

// Throw-variant for routes/services whose contract is "disabled → refuse
// CONFIG (422)".
export async function assertProjectBrainEnabled(
  db: GuardDb,
  projectId: string,
): Promise<void> {
  if (!(await isProjectBrainEnabled(db, projectId))) {
    throw new MaisterError(
      "CONFIG",
      "Project Brain is not enabled for this project",
    );
  }
}

// This probe says whether the separate brain lineage has actually been
// applied. An install that ran `db:migrate` but not
// `db:migrate:brain` is Postgres-with-no-brain-tables: the sweeps must quietly
// no-op there (not 42P01-error on every scheduler tick, even for installs that
// never enable the Brain), and the config surfaces must refuse with the exact
// command. A positive probe is memoized per process; a negative one re-probes
// (one cheap SELECT per sweep tick) so running `db:migrate:brain` takes effect
// without a web restart.
let brainSchemaApplied = false;
let brainSchemaWarned = false;

// Test hook.
export function resetBrainSchemaProbe(): void {
  brainSchemaApplied = false;
  brainSchemaWarned = false;
}

export async function isBrainSchemaApplied(db: GuardDb): Promise<boolean> {
  if (brainSchemaApplied) return true;

  const r = await db.execute(
    sql`SELECT to_regclass('public.brain_items') AS t`,
  );

  if (r.rows[0]?.t != null) brainSchemaApplied = true;

  return brainSchemaApplied;
}

// One warn per process for the missing-lineage state — callers use it to log
// once instead of every tick.
export function brainSchemaMissingWarnOnce(): boolean {
  if (brainSchemaWarned) return false;
  brainSchemaWarned = true;

  return true;
}

export async function assertBrainSchemaApplied(db: GuardDb): Promise<void> {
  if (!(await isBrainSchemaApplied(db))) {
    throw new MaisterError(
      "PRECONDITION",
      "Project Brain migration lineage is not applied — run `pnpm --filter maister-web db:migrate:brain` (after `db:migrate`)",
    );
  }
}
