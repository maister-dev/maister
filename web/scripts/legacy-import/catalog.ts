import type { Client } from "pg";

import type { RuntimeObjectKind } from "@/lib/execution-host/types";

// S4.8 / D9 steps 5-6: "the manager performs real object metadata". A sealed
// import object is invisible to the ordinary read path until the manager's
// catalogue (`execution_runtime_objects`) names it, so the association phase
// writes that row — on the host whose key the host itself stated, under the
// kind the frozen source class maps to. The mapping is closed and the host
// binding is evidence, never an assumption: an unknown class or an unknown host
// refuses before any write.

export type CatalogRefusal =
  | "catalog_kind_unknown"
  | "execution_host_missing"
  | "catalog_row_conflict";

export class CatalogError extends Error {
  readonly details: { reason: CatalogRefusal };

  constructor(message: string, reason: CatalogRefusal) {
    super(message);
    this.name = "CatalogError";
    this.details = { reason };
  }
}

const KIND_BY_SOURCE_CLASS: Readonly<Record<string, RuntimeObjectKind>> = {
  raw_transcript: "raw_transcript",
  cost_diagnostic: "cost_diagnostic",
  step_log: "session_log",
  session_metadata: "checkpoint",
  upload: "attachment",
  file_evidence: "evidence",
  manager_owned: "evidence",
};

export function catalogKindFor(sourceClass: string): RuntimeObjectKind {
  const kind = KIND_BY_SOURCE_CLASS[sourceClass];

  if (!kind) {
    throw new CatalogError(
      `catalog_kind_unknown: no catalogue kind for source class ${sourceClass}`,
      "catalog_kind_unknown",
    );
  }

  return kind;
}

// The manager knows a host by the key it registered from the supervisor's own
// identity. Binding to the key the import protocol reported means the row
// names the host that holds the bytes, not whichever host happens to be local.
export async function resolveSealingHost(
  client: Client,
  hostKey: string,
): Promise<string> {
  const rows = await client.query<{ id: string }>(
    `SELECT id FROM execution_hosts WHERE host_key = $1 AND retired_at IS NULL`,
    [hostKey],
  );
  const id = rows.rows[0]?.id;

  if (!id) {
    throw new CatalogError(
      "execution_host_missing: the manager knows no live host with the key that sealed the bytes",
      "execution_host_missing",
    );
  }

  return id;
}

export type CatalogueEntry = {
  objectId: string;
  runId: string;
  hostId: string;
  kind: RuntimeObjectKind;
  logicalName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
};

// Idempotent on the object id: a row that already says exactly this is the
// re-run case; a row that says something else is a conflict, never overwritten.
export async function catalogueSealedObject(
  client: Client,
  entry: CatalogueEntry,
): Promise<"catalogued" | "already"> {
  const inserted = await client.query(
    `INSERT INTO execution_runtime_objects
      (id, run_id, execution_host_id, kind, logical_name, mime_type, size_bytes,
       sha256, generation, retention_class, state, sealed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, 'run', 'available', now())
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [
      entry.objectId,
      entry.runId,
      entry.hostId,
      entry.kind,
      entry.logicalName,
      entry.mimeType,
      String(entry.sizeBytes),
      entry.sha256,
    ],
  );

  if (inserted.rowCount === 1) return "catalogued";

  const existing = await client.query<{
    runId: string;
    hostId: string;
    kind: string;
    sizeBytes: string;
    sha256: string | null;
    state: string;
  }>(
    `SELECT run_id AS "runId", execution_host_id AS "hostId", kind,
        size_bytes::text AS "sizeBytes", sha256, state
     FROM execution_runtime_objects WHERE id = $1`,
    [entry.objectId],
  );
  const row = existing.rows[0];

  if (
    row &&
    row.runId === entry.runId &&
    row.hostId === entry.hostId &&
    row.kind === entry.kind &&
    row.sizeBytes === String(entry.sizeBytes) &&
    row.sha256 === entry.sha256 &&
    row.state === "available"
  )
    return "already";

  throw new CatalogError(
    "catalog_row_conflict: the catalogue already names this object with another identity",
    "catalog_row_conflict",
  );
}
