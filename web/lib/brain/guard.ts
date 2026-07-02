import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { MaisterError } from "@/lib/errors";

// Project Brain (ADR-122, D3): the Brain is Postgres + pgvector only. In SQLite
// mode (`DB_URL=file:`) it is disabled — the brain migration lineage is never
// provisioned, so every brain service entrypoint MUST fail closed rather than
// query a table that does not exist. This mirrors the dialect decision in
// `web/lib/db/client.ts` `buildClient` (DB_URL prefix is the source of truth).

export function isBrainProvisioned(): boolean {
  return (process.env.DB_URL ?? "").startsWith("postgres");
}

// Throw the fail-closed `PRECONDITION` at a brain service entrypoint when the
// dialect is not Postgres. E-11: routes/services refuse `PRECONDITION`; MCP
// memory tools fail closed (the facade still lists the tools statically).
export function assertBrainProvisioned(): void {
  if (!isBrainProvisioned()) {
    throw new MaisterError(
      "PRECONDITION",
      "Project Brain is disabled in SQLite mode — Postgres + pgvector is required (ADR-122, D3)",
    );
  }
}

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
