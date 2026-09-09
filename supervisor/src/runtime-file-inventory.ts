import type { DatabaseSync } from "node:sqlite";
import type { RuntimeLimits } from "./runtime-limits";

import { createHash } from "node:crypto";
import { lstatSync, opendirSync } from "node:fs";
import { join } from "node:path";

import { HostRuntimeEventError } from "./host-runtime-errors";
import {
  auditRuntimeFileBudget,
  refreshRuntimeFilePressure,
  runtimeFileBudgetSnapshot,
} from "./runtime-file-budget";

function retainedBytes(db: DatabaseSync, file: string): number {
  try {
    const metadata = lstatSync(file);

    const knownCorruptLink =
      metadata.isSymbolicLink() &&
      db
        .prepare(
          "SELECT 1 FROM runtime_objects WHERE private_path = ? AND state = 'corrupt'",
        )
        .get(file) !== undefined;

    if (
      (!metadata.isFile() && !knownCorruptLink) ||
      !Number.isSafeInteger(metadata.size)
    )
      throw new HostRuntimeEventError(
        "runtime_storage_unavailable",
        "retained runtime content is not a measurable regular file",
      );

    return metadata.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

/** Boot-only, before writers start. Missing paths never retire a reservation. */
export function inventoryRuntimeFiles(input: {
  db: DatabaseSync;
  objectRoot: string;
  limits: RuntimeLimits;
  write: <T>(operation: () => T) => T;
}): void {
  const { db, limits, write } = input;
  let afterFile = "";

  for (;;) {
    const page = db
      .prepare(
        `SELECT file_id, private_path, temporary_path, capacity_bytes, written_bytes
      FROM runtime_files WHERE file_id > ? ORDER BY file_id LIMIT 100`,
      )
      .all(afterFile) as Array<{
      file_id: string;
      private_path: string;
      temporary_path: string | null;
      capacity_bytes: number;
      written_bytes: number;
    }>;

    if (page.length === 0) break;
    for (const file of page) {
      const bytes =
        retainedBytes(db, file.private_path) +
        (file.temporary_path ? retainedBytes(db, file.temporary_path) : 0);

      const knownCorrupt =
        db
          .prepare(
            "SELECT 1 FROM runtime_objects WHERE private_path = ? AND state = 'corrupt'",
          )
          .get(file.private_path) !== undefined;

      if (bytes > file.capacity_bytes && !knownCorrupt)
        throw new HostRuntimeEventError(
          "runtime_storage_unavailable",
          "retained runtime bytes exceed their durable file reservation; preserve the files and repair storage",
        );
      if (bytes !== file.written_bytes)
        write(() =>
          db
            .prepare(
              "UPDATE runtime_files SET capacity_bytes = MAX(capacity_bytes, ?), written_bytes = ? WHERE file_id = ?",
            )
            .run(bytes, bytes, file.file_id),
        );
    }
    afterFile = page.at(-1)!.file_id;
  }

  const discover = (directory: string, depth: number): void => {
    if (depth > 32)
      throw new HostRuntimeEventError(
        "runtime_storage_unavailable",
        "runtime file inventory exceeds its directory depth bound",
      );
    let entries: ReturnType<typeof opendirSync>;

    try {
      if (!lstatSync(directory).isDirectory())
        throw new HostRuntimeEventError(
          "runtime_storage_unavailable",
          "runtime inventory root is not a private directory",
        );
      entries = opendirSync(directory, { bufferSize: 32 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    try {
      for (
        let entry = entries.readSync();
        entry !== null;
        entry = entries.readSync()
      ) {
        const privatePath = join(directory, entry.name);

        if (entry.isDirectory()) {
          discover(privatePath, depth + 1);
          continue;
        }
        const bytes = retainedBytes(db, privatePath);
        const known = db
          .prepare(
            "SELECT 1 FROM runtime_files WHERE private_path = ? OR temporary_path = ?",
          )
          .get(privatePath, privatePath);

        if (known) continue;
        const fileId = `legacy:${createHash("sha256").update(privatePath).digest("hex")}`;

        write(() =>
          db
            .prepare(
              `INSERT INTO runtime_files
          (file_id, private_path, temporary_path, kind, wallet_id, capacity_bytes, written_bytes, sealed)
          VALUES (?, ?, NULL, 'legacy', NULL, ?, ?, 1)`,
            )
            .run(fileId, privatePath, bytes, bytes),
        );
        // Inventory must account for old evidence even when admission is paused.
        // It never unlinks orphan logs, interrupted copies or unknown objects.
        if (runtimeFileBudgetSnapshot(db).chargedBytes > limits.objectMaxBytes)
          throw new HostRuntimeEventError(
            "runtime_storage_unavailable",
            "retained runtime files exceed configured storage capacity",
          );
      }
    } finally {
      entries.closeSync();
    }
  };

  discover(input.objectRoot, 0);
  let afterDirectory = "";

  for (;;) {
    const page = db
      .prepare(
        "SELECT DISTINCT run_dir FROM workspaces WHERE run_dir > ? ORDER BY run_dir LIMIT 100",
      )
      .all(afterDirectory) as Array<{ run_dir: string }>;

    if (page.length === 0) break;
    for (const row of page) discover(row.run_dir, 0);
    afterDirectory = page.at(-1)!.run_dir;
  }
  auditRuntimeFileBudget(db, limits);
  write(() => refreshRuntimeFilePressure(db, limits));
}
