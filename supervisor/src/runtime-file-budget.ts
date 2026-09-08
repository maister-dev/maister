import type { DatabaseSync } from "node:sqlite";
import type { RuntimeLimits } from "./runtime-limits";

import { statfsSync } from "node:fs";
import { dirname } from "node:path";

import { HostRuntimeEventError } from "./host-runtime-errors";

export const PRODUCER_FILE_RESERVE_BYTES = 8 * 1024 * 1024;
export const OUTPUT_FILE_RESERVE_BYTES = 50 * 1024 * 1024;

export type RuntimeFileFunding =
  | { kind: "regular" }
  | { kind: "producer"; walletId: string }
  | { kind: "frame"; walletId: string; reservationId: string }
  | { kind: "wallet"; walletId: string };

export type RuntimeFileRow = Readonly<{
  fileId: string;
  privatePath: string;
  temporaryPath: string | null;
  kind: "object" | "log" | "spool" | "legacy";
  walletId: string | null;
  capacityBytes: number;
  writtenBytes: number;
  sealed: boolean;
}>;

export type RuntimeFileBudgetSnapshot = Readonly<{
  chargedBytes: number;
  writtenBytes: number;
  unusedBytes: number;
  pressured: boolean;
}>;

export const RUNTIME_FILE_BUDGET_SCHEMA = `
CREATE TABLE IF NOT EXISTS runtime_file_budget (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  charged_bytes INTEGER NOT NULL DEFAULT 0 CHECK (charged_bytes >= 0),
  written_bytes INTEGER NOT NULL DEFAULT 0 CHECK (written_bytes >= 0),
  pressured INTEGER NOT NULL DEFAULT 0 CHECK (pressured IN (0, 1)),
  CHECK (written_bytes <= charged_bytes)
);
INSERT OR IGNORE INTO runtime_file_budget (id) VALUES (1);
CREATE TABLE IF NOT EXISTS runtime_file_wallets (
  wallet_id TEXT PRIMARY KEY REFERENCES runtime_event_wallets (wallet_id),
  remaining_bytes INTEGER NOT NULL CHECK (remaining_bytes >= 0)
);
CREATE TABLE IF NOT EXISTS runtime_files (
  file_id TEXT PRIMARY KEY,
  private_path TEXT NOT NULL UNIQUE,
  temporary_path TEXT UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('object', 'log', 'spool', 'legacy')),
  wallet_id TEXT REFERENCES runtime_event_wallets (wallet_id),
  capacity_bytes INTEGER NOT NULL CHECK (capacity_bytes >= 0),
  written_bytes INTEGER NOT NULL CHECK (written_bytes >= 0 AND written_bytes <= capacity_bytes),
  sealed INTEGER NOT NULL CHECK (sealed IN (0, 1)),
  writer_boot_id TEXT,
  writer_token TEXT,
  CHECK ((writer_boot_id IS NULL) = (writer_token IS NULL))
);
CREATE TABLE IF NOT EXISTS runtime_frame_file_credits (
  reservation_id TEXT PRIMARY KEY REFERENCES runtime_event_frames (reservation_id) ON DELETE CASCADE,
  wallet_id TEXT NOT NULL REFERENCES runtime_event_wallets (wallet_id),
  remaining_bytes INTEGER NOT NULL CHECK (remaining_bytes >= 0)
);
CREATE TRIGGER IF NOT EXISTS runtime_frame_file_insert AFTER INSERT ON runtime_frame_file_credits BEGIN
  UPDATE runtime_file_budget SET charged_bytes = charged_bytes + NEW.remaining_bytes WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS runtime_frame_file_update AFTER UPDATE OF remaining_bytes ON runtime_frame_file_credits BEGIN
  UPDATE runtime_file_budget SET charged_bytes = charged_bytes + NEW.remaining_bytes - OLD.remaining_bytes WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS runtime_frame_file_delete AFTER DELETE ON runtime_frame_file_credits BEGIN
  UPDATE runtime_file_budget SET charged_bytes = charged_bytes - OLD.remaining_bytes WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS runtime_file_wallet_insert AFTER INSERT ON runtime_file_wallets BEGIN
  UPDATE runtime_file_budget SET charged_bytes = charged_bytes + NEW.remaining_bytes WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS runtime_file_wallet_update AFTER UPDATE OF remaining_bytes ON runtime_file_wallets BEGIN
  UPDATE runtime_file_budget SET charged_bytes = charged_bytes + NEW.remaining_bytes - OLD.remaining_bytes WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS runtime_file_wallet_close AFTER UPDATE OF closed ON runtime_event_wallets
WHEN NEW.closed = 1 AND OLD.closed = 0 BEGIN
  UPDATE runtime_file_wallets SET remaining_bytes = 0 WHERE wallet_id = NEW.wallet_id;
END;
CREATE TRIGGER IF NOT EXISTS runtime_file_insert AFTER INSERT ON runtime_files BEGIN
  UPDATE runtime_file_budget SET charged_bytes = charged_bytes + NEW.capacity_bytes,
    written_bytes = written_bytes + NEW.written_bytes WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS runtime_file_update AFTER UPDATE OF capacity_bytes, written_bytes ON runtime_files BEGIN
  UPDATE runtime_file_budget SET charged_bytes = charged_bytes + NEW.capacity_bytes - OLD.capacity_bytes,
    written_bytes = written_bytes + NEW.written_bytes - OLD.written_bytes WHERE id = 1;
END;
`;

export function runtimeFileBudgetSnapshot(
  db: DatabaseSync,
): RuntimeFileBudgetSnapshot {
  const row = db
    .prepare(
      "SELECT charged_bytes, written_bytes, pressured FROM runtime_file_budget WHERE id = 1",
    )
    .get() as {
    charged_bytes: number;
    written_bytes: number;
    pressured: number;
  };

  return {
    chargedBytes: row.charged_bytes,
    writtenBytes: row.written_bytes,
    unusedBytes: row.charged_bytes - row.written_bytes,
    pressured: row.pressured === 1,
  };
}

export function refreshRuntimeFilePressure(
  db: DatabaseSync,
  limits: RuntimeLimits,
): boolean {
  const snapshot = runtimeFileBudgetSnapshot(db);
  const pressured =
    snapshot.chargedBytes >=
    (snapshot.pressured ? limits.objectLowBytes : limits.objectSoftBytes);

  if (pressured !== snapshot.pressured)
    db.prepare("UPDATE runtime_file_budget SET pressured = ? WHERE id = 1").run(
      pressured ? 1 : 0,
    );

  return pressured;
}

function assertFileBytes(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0)
    throw new HostRuntimeEventError(
      "command_invariant_conflict",
      "runtime file capacity must be a nonnegative safe integer",
    );
}

function assertFileHeadroom(
  db: DatabaseSync,
  limits: RuntimeLimits,
  freeBytes: number | null,
  additionalBytes: number,
): void {
  if (freeBytes === null) return;
  const unused = runtimeFileBudgetSnapshot(db).unusedBytes;

  if (freeBytes < limits.runtimeMinFreeBytes + unused + additionalBytes)
    throw new HostRuntimeEventError(
      "runtime_storage_pressure",
      "filesystem free space cannot fund outstanding runtime file reservations",
    );
}

function filesystemFreeBytes(file: string): number {
  const fs = statfsSync(dirname(file), { bigint: true });
  const bytes = fs.bavail * fs.bsize;

  return Number(
    bytes > BigInt(Number.MAX_SAFE_INTEGER)
      ? BigInt(Number.MAX_SAFE_INTEGER)
      : bytes,
  );
}

export function producerIsStarting(
  db: DatabaseSync,
  walletId: string,
): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM command_receipts r JOIN runtime_event_wallets w ON w.wallet_id = r.command_id
    WHERE r.command_id = ? AND r.kind = 'session.create' AND r.phase = 'accepted' AND w.closed = 0`,
    )
    .get(walletId);
}

function fundFileCapacity(
  db: DatabaseSync,
  limits: RuntimeLimits,
  bytes: number,
  funding: RuntimeFileFunding,
): void {
  assertFileBytes(bytes);
  if (bytes === 0) return;
  if (funding.kind === "frame") {
    const result = db
      .prepare(
        `UPDATE runtime_frame_file_credits SET remaining_bytes = remaining_bytes - ?
      WHERE reservation_id = ? AND wallet_id = ? AND remaining_bytes >= ?`,
      )
      .run(bytes, funding.reservationId, funding.walletId, bytes);

    if (Number(result.changes) !== 1)
      throw new HostRuntimeEventError(
        "runtime_storage_pressure",
        "captured frame file reservation is exhausted",
      );

    return;
  }
  if (funding.kind === "wallet") {
    const result = db
      .prepare(
        `UPDATE runtime_file_wallets SET remaining_bytes = remaining_bytes - ?
      WHERE wallet_id = ? AND remaining_bytes >= ?
      AND EXISTS (SELECT 1 FROM runtime_event_wallets w WHERE w.wallet_id = runtime_file_wallets.wallet_id AND w.closed = 0)`,
      )
      .run(bytes, funding.walletId, bytes);

    if (Number(result.changes) !== 1)
      throw new HostRuntimeEventError(
        "runtime_storage_pressure",
        "producer file preservation reservation is exhausted",
      );

    return;
  }
  const snapshot = runtimeFileBudgetSnapshot(db);
  const starting =
    funding.kind === "producer" && producerIsStarting(db, funding.walletId);

  if (
    (!starting && refreshRuntimeFilePressure(db, limits)) ||
    bytes > limits.objectMaxBytes - snapshot.chargedBytes
  ) {
    throw new HostRuntimeEventError(
      "runtime_storage_pressure",
      "runtime file capacity is reserved; wait for authorized cleanup below the low watermark",
    );
  }
}

/** Shares the transaction with the accepted create receipt and event wallet. */
export function reserveProducerFileWallet(
  db: DatabaseSync,
  limits: RuntimeLimits,
  walletId: string,
  outputBindingCount: number,
  freeBytes: number | null,
): void {
  if (
    db
      .prepare("SELECT 1 FROM runtime_file_wallets WHERE wallet_id = ?")
      .get(walletId)
  )
    return;
  const bytes =
    PRODUCER_FILE_RESERVE_BYTES +
    outputBindingCount * OUTPUT_FILE_RESERVE_BYTES;

  assertFileHeadroom(db, limits, freeBytes, bytes);
  fundFileCapacity(db, limits, bytes, { kind: "regular" });
  db.prepare(
    "INSERT INTO runtime_file_wallets (wallet_id, remaining_bytes) VALUES (?, ?)",
  ).run(walletId, bytes);
  refreshRuntimeFilePressure(db, limits);
}

export function getRuntimeFile(
  db: DatabaseSync,
  fileId: string,
): RuntimeFileRow | null {
  const row = db
    .prepare("SELECT * FROM runtime_files WHERE file_id = ?")
    .get(fileId);

  if (!row) return null;

  return {
    fileId: String(row.file_id),
    privatePath: String(row.private_path),
    temporaryPath:
      row.temporary_path === null ? null : String(row.temporary_path),
    kind: row.kind as RuntimeFileRow["kind"],
    walletId: row.wallet_id === null ? null : String(row.wallet_id),
    capacityBytes: Number(row.capacity_bytes),
    writtenBytes: Number(row.written_bytes),
    sealed: row.sealed === 1,
  };
}

/** The caller owns the SQLite transaction and validates the private file path. */
export function reserveRuntimeFile(
  db: DatabaseSync,
  limits: RuntimeLimits,
  file: RuntimeFileRow,
  funding: RuntimeFileFunding,
): void {
  assertFileBytes(file.capacityBytes);
  assertFileBytes(file.writtenBytes);
  const existing = getRuntimeFile(db, file.fileId);

  if (existing) {
    if (
      existing.privatePath !== file.privatePath ||
      existing.temporaryPath !== file.temporaryPath ||
      existing.kind !== file.kind ||
      existing.walletId !== file.walletId
    ) {
      throw new HostRuntimeEventError(
        "command_invariant_conflict",
        "runtime file reservation identity changed",
      );
    }
    if (
      existing.capacityBytes !== file.capacityBytes ||
      existing.sealed !== file.sealed
    ) {
      throw new HostRuntimeEventError(
        "command_invariant_conflict",
        "runtime file reservation capacity changed",
      );
    }

    return;
  }
  assertFileHeadroom(
    db,
    limits,
    filesystemFreeBytes(file.privatePath),
    funding.kind === "wallet" || funding.kind === "frame"
      ? 0
      : file.capacityBytes,
  );
  fundFileCapacity(db, limits, file.capacityBytes, funding);
  db.prepare(
    `INSERT INTO runtime_files (file_id, private_path, temporary_path, kind, wallet_id, capacity_bytes, written_bytes, sealed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    file.fileId,
    file.privatePath,
    file.temporaryPath,
    file.kind,
    file.walletId,
    file.capacityBytes,
    file.writtenBytes,
    file.sealed ? 1 : 0,
  );
  refreshRuntimeFilePressure(db, limits);
}

export function growRuntimeFile(
  db: DatabaseSync,
  limits: RuntimeLimits,
  fileId: string,
  bytes: number,
  funding: RuntimeFileFunding,
): void {
  const file = getRuntimeFile(db, fileId);

  if (!file || file.sealed)
    throw new HostRuntimeEventError(
      "command_invariant_conflict",
      "runtime file is not open for growth",
    );
  assertFileHeadroom(
    db,
    limits,
    filesystemFreeBytes(file.privatePath),
    funding.kind === "wallet" || funding.kind === "frame" ? 0 : bytes,
  );
  fundFileCapacity(db, limits, bytes, funding);
  db.prepare(
    "UPDATE runtime_files SET capacity_bytes = capacity_bytes + ? WHERE file_id = ?",
  ).run(bytes, fileId);
  refreshRuntimeFilePressure(db, limits);
}

export function recordRuntimeFileBytes(
  db: DatabaseSync,
  fileId: string,
  writtenBytes: number,
): void {
  assertFileBytes(writtenBytes);
  const result = db
    .prepare(
      "UPDATE runtime_files SET written_bytes = ? WHERE file_id = ? AND capacity_bytes >= ? AND sealed = 0",
    )
    .run(writtenBytes, fileId, writtenBytes);

  if (Number(result.changes) !== 1)
    throw new HostRuntimeEventError(
      "runtime_storage_unavailable",
      "runtime file exceeded its promised capacity or changed state",
    );
}

export function sealRuntimeFile(
  db: DatabaseSync,
  limits: RuntimeLimits,
  fileId: string,
  writtenBytes: number,
): void {
  assertFileBytes(writtenBytes);
  const result = db
    .prepare(
      "UPDATE runtime_files SET capacity_bytes = ?, written_bytes = ?, sealed = 1 WHERE file_id = ? AND capacity_bytes >= ?",
    )
    .run(writtenBytes, writtenBytes, fileId, writtenBytes);

  if (Number(result.changes) !== 1)
    throw new HostRuntimeEventError(
      "runtime_storage_unavailable",
      "runtime file cannot be sealed within its reservation",
    );
  refreshRuntimeFilePressure(db, limits);
}

/** Keep a zero-charge identity after a confirmed unlink; never reuse its path. */
export function releaseRuntimeFile(
  db: DatabaseSync,
  limits: RuntimeLimits,
  fileId: string,
): void {
  db.prepare(
    "UPDATE runtime_files SET capacity_bytes = 0, written_bytes = 0, sealed = 1 WHERE file_id = ?",
  ).run(fileId);
  refreshRuntimeFilePressure(db, limits);
}

export function claimRuntimeFileWriter(
  db: DatabaseSync,
  fileId: string,
  bootId: string,
  token: string,
): void {
  const result = db
    .prepare(
      `UPDATE runtime_files SET writer_boot_id = ?, writer_token = ?
    WHERE file_id = ? AND sealed = 0 AND (writer_token IS NULL OR writer_boot_id <> ?)`,
    )
    .run(bootId, token, fileId, bootId);

  if (Number(result.changes) !== 1)
    throw new HostRuntimeEventError(
      "command_in_progress",
      "runtime file already has an active writer or is sealed",
    );
}

export function releaseRuntimeFileWriter(
  db: DatabaseSync,
  fileId: string,
  bootId: string,
  token: string,
): void {
  const result = db
    .prepare(
      `UPDATE runtime_files SET writer_boot_id = NULL, writer_token = NULL
    WHERE file_id = ? AND writer_boot_id = ? AND writer_token = ?`,
    )
    .run(fileId, bootId, token);

  if (Number(result.changes) !== 1)
    throw new HostRuntimeEventError(
      "command_invariant_conflict",
      "runtime file writer ownership changed",
    );
}

export function auditRuntimeFileBudget(
  db: DatabaseSync,
  limits: RuntimeLimits,
): void {
  const actual = db
    .prepare(
      `SELECT COALESCE(SUM(capacity_bytes), 0) +
      (SELECT COALESCE(SUM(remaining_bytes), 0) FROM runtime_file_wallets) +
      (SELECT COALESCE(SUM(remaining_bytes), 0) FROM runtime_frame_file_credits) AS charged,
      COALESCE(SUM(written_bytes), 0) AS written FROM runtime_files`,
    )
    .get() as { charged: number; written: number };
  const stored = runtimeFileBudgetSnapshot(db);

  if (
    actual.charged !== stored.chargedBytes ||
    actual.written !== stored.writtenBytes
  )
    throw new HostRuntimeEventError(
      "stream_corrupt",
      "runtime file budget does not match durable reservations",
    );
  if (stored.chargedBytes > limits.objectMaxBytes)
    throw new HostRuntimeEventError(
      "runtime_storage_unavailable",
      "configured file capacity cannot honor retained runtime files and reservations",
    );
}

/** Two references cover the raw frame and its semantic notification. */
export function reserveRuntimeFrameFiles(
  db: DatabaseSync,
  limits: RuntimeLimits,
  input: {
    reservationId: string;
    walletId: string;
    frameBytes: number;
    freeBytes: number | null;
  },
): void {
  if (
    !Number.isSafeInteger(input.frameBytes) ||
    input.frameBytes < 1 ||
    input.frameBytes > 1048576
  )
    throw new HostRuntimeEventError(
      "command_invariant_conflict",
      "runtime frame byte count is outside its protocol bound",
    );
  const bytes = Math.min(4 * 1024 * 1024, 4 * input.frameBytes + 64 * 1024);

  assertFileHeadroom(db, limits, input.freeBytes, bytes);
  fundFileCapacity(db, limits, bytes, {
    kind: "producer",
    walletId: input.walletId,
  });
  db.prepare(
    "INSERT INTO runtime_frame_file_credits (reservation_id, wallet_id, remaining_bytes) VALUES (?, ?, ?)",
  ).run(input.reservationId, input.walletId, bytes);
  refreshRuntimeFilePressure(db, limits);
}
