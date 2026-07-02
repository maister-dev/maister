import "server-only";

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
