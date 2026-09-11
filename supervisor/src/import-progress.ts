import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { SupervisorError } from "./types";

// S4.3 / D9: the supervisor's own durable import state. It is operational
// import state — not a command or Flow ledger — so it lives in its own
// maintenance database inside the operator-owned import directory, is written
// only by the supervisor, and is removed with the import authority. Nothing
// here is on the ordinary session path.

export const IMPORT_PROGRESS_SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS import_identity (
  import_id TEXT PRIMARY KEY,
  manifest_digest TEXT NOT NULL,
  next_generation INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS import_generations (
  generation INTEGER PRIMARY KEY,
  enabled_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS import_items (
  item_id TEXT PRIMARY KEY,
  lane TEXT NOT NULL,
  run_id TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL,
  received_bytes INTEGER NOT NULL DEFAULT 0 CHECK (received_bytes >= 0),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'receiving', 'sealed')),
  sealed_object_id TEXT
);
CREATE TABLE IF NOT EXISTS import_chunks (
  item_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  byte_offset INTEGER NOT NULL CHECK (byte_offset >= 0),
  length INTEGER NOT NULL CHECK (length > 0),
  sha256 TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  PRIMARY KEY (item_id, chunk_index)
);
`;

export type ImportItemState = "pending" | "receiving" | "sealed";

export type ImportItemProgress = {
  itemId: string;
  runId: string;
  sizeBytes: number;
  sha256: string;
  receivedBytes: number;
  state: ImportItemState;
  sealedObjectId: string | null;
};

export type ImportChunkOutcome = "committed" | "duplicate";

export type ImportProgressLedger = {
  enableGeneration(): { generation: number };
  revokeGeneration(generation: number): void;
  revokedGenerations(): number[];
  registerItem(item: {
    itemId: string;
    lane: string;
    runId: string;
    sizeBytes: number;
    sha256: string;
  }): void;
  itemProgress(itemId: string): ImportItemProgress | null;
  items(): ImportItemProgress[];
  commitChunk(input: {
    itemId: string;
    chunkIndex: number;
    offset: number;
    length: number;
    sha256: string;
  }): ImportChunkOutcome;
  sealItem(input: { itemId: string; objectId: string }): void;
  snapshot(): {
    items: number;
    sealed: number;
    receivedBytes: number;
    expectedBytes: number;
  };
  close(): void;
};

function refuse(
  reason:
    | "import_manifest_mismatch"
    | "import_item_unknown"
    | "import_item_sealed"
    | "import_item_incomplete"
    | "import_offset_mismatch"
    | "import_chunk_conflict"
    | "import_seal_conflict",
): never {
  throw new SupervisorError("PRECONDITION", reason, { details: { reason } });
}

function integer(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : Number(value);
}

export function openImportProgressLedger(input: {
  file: string;
  importId: string;
  manifestDigest: string;
  now?: () => Date;
}): ImportProgressLedger {
  const now = input.now ?? (() => new Date());
  const db = new DatabaseSync(input.file);

  chmodSync(input.file, 0o600);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  db.exec(`PRAGMA user_version = ${IMPORT_PROGRESS_SCHEMA_VERSION}`);

  const identity = db
    .prepare(
      `SELECT import_id AS importId, manifest_digest AS manifestDigest,
          next_generation AS nextGeneration
       FROM import_identity WHERE import_id = ?`,
    )
    .get(input.importId) as
    | { importId: string; manifestDigest: string; nextGeneration: number }
    | undefined;

  if (!identity) {
    db.prepare(
      `INSERT INTO import_identity (import_id, manifest_digest, next_generation)
       VALUES (?, ?, 1)`,
    ).run(input.importId, input.manifestDigest);
  } else if (identity.manifestDigest !== input.manifestDigest) {
    db.close();
    refuse("import_manifest_mismatch");
  }

  const requireItem = (itemId: string): ImportItemProgress => {
    const row = db
      .prepare(
        `SELECT item_id AS itemId, run_id AS runId, size_bytes AS sizeBytes,
            sha256, received_bytes AS receivedBytes, state,
            sealed_object_id AS sealedObjectId
         FROM import_items WHERE item_id = ?`,
      )
      .get(itemId) as Record<string, unknown> | undefined;

    if (!row) refuse("import_item_unknown");

    return {
      itemId: String(row.itemId),
      runId: String(row.runId),
      sizeBytes: integer(row.sizeBytes),
      sha256: String(row.sha256),
      receivedBytes: integer(row.receivedBytes),
      state: String(row.state) as ImportItemState,
      sealedObjectId:
        row.sealedObjectId === null ? null : String(row.sealedObjectId),
    };
  };

  return {
    enableGeneration() {
      const row = db
        .prepare(
          "SELECT next_generation AS nextGeneration FROM import_identity WHERE import_id = ?",
        )
        .get(input.importId) as { nextGeneration: number };
      const generation = integer(row.nextGeneration);

      db.exec("BEGIN");
      try {
        db.prepare(
          "INSERT INTO import_generations (generation, enabled_at) VALUES (?, ?)",
        ).run(generation, now().toISOString());
        db.prepare(
          "UPDATE import_identity SET next_generation = ? WHERE import_id = ?",
        ).run(generation + 1, input.importId);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      return { generation };
    },

    revokeGeneration(generation) {
      db.prepare(
        "UPDATE import_generations SET revoked_at = ? WHERE generation = ? AND revoked_at IS NULL",
      ).run(now().toISOString(), generation);
    },

    revokedGenerations() {
      return db
        .prepare(
          "SELECT generation FROM import_generations WHERE revoked_at IS NOT NULL ORDER BY generation",
        )
        .all()
        .map((row) => integer(row.generation));
    },

    registerItem(item) {
      db.prepare(
        `INSERT INTO import_items (item_id, lane, run_id, size_bytes, sha256)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (item_id) DO NOTHING`,
      ).run(item.itemId, item.lane, item.runId, item.sizeBytes, item.sha256);
    },

    items() {
      return db
        .prepare(
          `SELECT item_id AS itemId, run_id AS runId, size_bytes AS sizeBytes,
              sha256, received_bytes AS receivedBytes, state,
              sealed_object_id AS sealedObjectId
           FROM import_items ORDER BY item_id`,
        )
        .all()
        .map((row) => ({
          itemId: String(row.itemId),
          runId: String(row.runId),
          sizeBytes: integer(row.sizeBytes),
          sha256: String(row.sha256),
          receivedBytes: integer(row.receivedBytes),
          state: String(row.state) as ImportItemState,
          sealedObjectId:
            row.sealedObjectId === null ? null : String(row.sealedObjectId),
        }));
    },

    itemProgress(itemId) {
      try {
        return requireItem(itemId);
      } catch (error) {
        if (
          error instanceof SupervisorError &&
          error.details?.reason === "import_item_unknown"
        )
          return null;
        throw error;
      }
    },

    commitChunk(chunk) {
      const item = requireItem(chunk.itemId);

      if (item.state === "sealed") refuse("import_item_sealed");

      const existing = db
        .prepare(
          `SELECT byte_offset AS byteOffset, length, sha256
           FROM import_chunks WHERE item_id = ? AND chunk_index = ?`,
        )
        .get(chunk.itemId, chunk.chunkIndex) as
        | { byteOffset: number; length: number; sha256: string }
        | undefined;

      if (existing) {
        if (
          integer(existing.byteOffset) !== chunk.offset ||
          integer(existing.length) !== chunk.length ||
          existing.sha256 !== chunk.sha256
        )
          refuse("import_chunk_conflict");

        return "duplicate";
      }
      if (
        chunk.offset !== item.receivedBytes ||
        chunk.offset + chunk.length > item.sizeBytes
      )
        refuse("import_offset_mismatch");

      db.exec("BEGIN");
      try {
        db.prepare(
          `INSERT INTO import_chunks
            (item_id, chunk_index, byte_offset, length, sha256, committed_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          chunk.itemId,
          chunk.chunkIndex,
          chunk.offset,
          chunk.length,
          chunk.sha256,
          now().toISOString(),
        );
        db.prepare(
          `UPDATE import_items
           SET received_bytes = received_bytes + ?, state = 'receiving'
           WHERE item_id = ?`,
        ).run(chunk.length, chunk.itemId);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      return "committed";
    },

    sealItem(seal) {
      const item = requireItem(seal.itemId);

      if (item.state === "sealed") {
        if (item.sealedObjectId !== seal.objectId)
          refuse("import_seal_conflict");

        return;
      }
      if (item.receivedBytes !== item.sizeBytes)
        refuse("import_item_incomplete");

      db.prepare(
        "UPDATE import_items SET state = 'sealed', sealed_object_id = ? WHERE item_id = ?",
      ).run(seal.objectId, seal.itemId);
    },

    snapshot() {
      const row = db
        .prepare(
          `SELECT count(*) AS items,
              coalesce(sum(state = 'sealed'), 0) AS sealed,
              coalesce(sum(received_bytes), 0) AS receivedBytes,
              coalesce(sum(size_bytes), 0) AS expectedBytes
           FROM import_items`,
        )
        .get() as Record<string, unknown>;

      return {
        items: integer(row.items),
        sealed: integer(row.sealed),
        receivedBytes: integer(row.receivedBytes),
        expectedBytes: integer(row.expectedBytes),
      };
    },

    close() {
      db.close();
    },
  };
}
