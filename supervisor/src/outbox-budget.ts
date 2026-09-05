import type { DatabaseSync } from "node:sqlite";
import type { RuntimeLimits } from "./runtime-limits";

import { HostRuntimeEventError } from "./host-runtime-errors";
import {
  CONTROL_EVENT_MAX_BYTES,
  EMERGENCY_EVENT_BYTES,
  EMERGENCY_EVENT_ROWS,
  producerWalletRows,
} from "./runtime-limits";

export type EventPartition = "regular" | "control" | "emergency";
export type EventFunding =
  | { partition: "regular"; reservationId?: string }
  | { partition: "control"; walletId: string; commandId?: string }
  | { partition: "emergency" };

export type PartitionUsage = Readonly<{
  retainedCount: number;
  retainedBytes: number;
  unacknowledgedCount: number;
  unacknowledgedBytes: number;
}>;

export type OutboxBudgetSnapshot = Readonly<{
  regular: PartitionUsage;
  control: PartitionUsage;
  emergency: PartitionUsage;
  reservedControlRows: number;
  reservedControlBytes: number;
  reservedRegularRows: number;
  reservedRegularBytes: number;
  pressured: boolean;
}>;

export type ProducerWalletBinding = Readonly<{
  walletId: string;
  runId: string;
  assignmentId: string;
  assignmentEpoch: number;
  outputBindingCount: number;
}>;

export type ReceiptAdmission =
  | { kind: "producer"; outputBindingCount: number }
  | { kind: "teardown"; walletId: string };

export type BudgetReceipt = Readonly<{
  commandId: string;
  kind: string;
  runId: string;
  assignmentId: string | null;
  epoch: number;
  phase: "accepted" | "completed" | "rejected";
  hostSessionId: string | null;
}>;

// All counters are updated by SQLite triggers in the event transaction. The
// hot admission/append path reads three rows instead of scanning the outbox.
export const OUTBOX_BUDGET_SCHEMA = `
CREATE INDEX IF NOT EXISTS command_receipts_pending_session
  ON command_receipts (host_session_id, kind) WHERE phase = 'accepted';
CREATE TABLE IF NOT EXISTS runtime_event_budget (
  partition TEXT PRIMARY KEY CHECK (partition IN ('regular', 'control', 'emergency')),
  retained_count INTEGER NOT NULL DEFAULT 0 CHECK (retained_count >= 0),
  retained_bytes INTEGER NOT NULL DEFAULT 0 CHECK (retained_bytes >= 0),
  unacknowledged_count INTEGER NOT NULL DEFAULT 0 CHECK (unacknowledged_count >= 0),
  unacknowledged_bytes INTEGER NOT NULL DEFAULT 0 CHECK (unacknowledged_bytes >= 0)
);
INSERT OR IGNORE INTO runtime_event_budget (partition) VALUES ('regular'), ('control'), ('emergency');
CREATE TABLE IF NOT EXISTS runtime_event_pressure (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pressured INTEGER NOT NULL CHECK (pressured IN (0, 1))
);
INSERT OR IGNORE INTO runtime_event_pressure VALUES (1, 0);
CREATE TABLE IF NOT EXISTS runtime_event_wallets (
  wallet_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  assignment_epoch INTEGER NOT NULL,
  output_binding_count INTEGER NOT NULL CHECK (output_binding_count BETWEEN 0 AND 32),
  remaining_rows INTEGER NOT NULL CHECK (remaining_rows >= 0),
  host_session_id TEXT,
  session_ended INTEGER NOT NULL DEFAULT 0 CHECK (session_ended IN (0, 1)),
  closed INTEGER NOT NULL DEFAULT 0 CHECK (closed IN (0, 1))
);
CREATE INDEX IF NOT EXISTS runtime_event_wallet_active
  ON runtime_event_wallets (remaining_rows) WHERE closed = 0;
CREATE UNIQUE INDEX IF NOT EXISTS runtime_event_wallet_session
  ON runtime_event_wallets (host_session_id) WHERE host_session_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS runtime_event_teardowns (
  command_id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL REFERENCES runtime_event_wallets (wallet_id),
  kind TEXT NOT NULL CHECK (kind IN ('session.cancel', 'session.checkpoint', 'session.delete')),
  remaining_rows INTEGER NOT NULL CHECK (remaining_rows BETWEEN 0 AND 2),
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1))
);
CREATE UNIQUE INDEX IF NOT EXISTS runtime_event_teardown_active
  ON runtime_event_teardowns (wallet_id) WHERE completed = 0;
CREATE TABLE IF NOT EXISTS runtime_event_frames (
  reservation_id TEXT PRIMARY KEY,
  boot_id TEXT NOT NULL,
  wallet_id TEXT NOT NULL REFERENCES runtime_event_wallets (wallet_id),
  remaining_rows INTEGER NOT NULL CHECK (remaining_rows >= 0),
  remaining_bytes INTEGER NOT NULL CHECK (remaining_bytes >= 0)
);
CREATE TRIGGER IF NOT EXISTS runtime_event_budget_insert AFTER INSERT ON runtime_event_outbox BEGIN
  UPDATE runtime_event_budget SET
    retained_count = retained_count + 1,
    retained_bytes = retained_bytes + NEW.encoded_bytes,
    unacknowledged_count = unacknowledged_count + (NEW.acknowledged_at IS NULL),
    unacknowledged_bytes = unacknowledged_bytes + CASE WHEN NEW.acknowledged_at IS NULL THEN NEW.encoded_bytes ELSE 0 END
  WHERE partition = NEW.budget_partition;
END;
CREATE TRIGGER IF NOT EXISTS runtime_event_budget_delete AFTER DELETE ON runtime_event_outbox BEGIN
  UPDATE runtime_event_budget SET
    retained_count = retained_count - 1,
    retained_bytes = retained_bytes - OLD.encoded_bytes,
    unacknowledged_count = unacknowledged_count - (OLD.acknowledged_at IS NULL),
    unacknowledged_bytes = unacknowledged_bytes - CASE WHEN OLD.acknowledged_at IS NULL THEN OLD.encoded_bytes ELSE 0 END
  WHERE partition = OLD.budget_partition;
END;
CREATE TRIGGER IF NOT EXISTS runtime_event_budget_ack AFTER UPDATE OF acknowledged_at ON runtime_event_outbox BEGIN
  UPDATE runtime_event_budget SET
    unacknowledged_count = unacknowledged_count + (NEW.acknowledged_at IS NULL) - (OLD.acknowledged_at IS NULL),
    unacknowledged_bytes = unacknowledged_bytes
      + CASE WHEN NEW.acknowledged_at IS NULL THEN NEW.encoded_bytes ELSE 0 END
      - CASE WHEN OLD.acknowledged_at IS NULL THEN OLD.encoded_bytes ELSE 0 END
  WHERE partition = OLD.budget_partition;
END;
`;

type UsageDbRow = {
  retained_count: number;
  retained_bytes: number;
  unacknowledged_count: number;
  unacknowledged_bytes: number;
};

function usage(db: DatabaseSync, partition: EventPartition): PartitionUsage {
  const row = db
    .prepare("SELECT * FROM runtime_event_budget WHERE partition = ?")
    .get(partition) as UsageDbRow;

  return {
    retainedCount: row.retained_count,
    retainedBytes: row.retained_bytes,
    unacknowledgedCount: row.unacknowledged_count,
    unacknowledgedBytes: row.unacknowledged_bytes,
  };
}

export function outboxBudgetSnapshot(db: DatabaseSync): OutboxBudgetSnapshot {
  const frames = db
    .prepare(
      "SELECT COALESCE(SUM(remaining_rows), 0) AS rows, COALESCE(SUM(remaining_bytes), 0) AS bytes FROM runtime_event_frames",
    )
    .get() as { rows: number; bytes: number };
  const reserved = db
    .prepare(
      `SELECT
    (SELECT COALESCE(SUM(remaining_rows), 0) FROM runtime_event_wallets WHERE closed = 0) +
    (SELECT COALESCE(SUM(remaining_rows), 0) FROM runtime_event_teardowns WHERE completed = 0) AS rows`,
    )
    .get() as { rows: number };
  const pressure = db
    .prepare("SELECT pressured FROM runtime_event_pressure WHERE id = 1")
    .get() as { pressured: number };

  return {
    regular: usage(db, "regular"),
    control: usage(db, "control"),
    emergency: usage(db, "emergency"),
    reservedControlRows: reserved.rows,
    reservedControlBytes: reserved.rows * CONTROL_EVENT_MAX_BYTES,
    reservedRegularRows: frames.rows,
    reservedRegularBytes: frames.bytes,
    pressured: pressure.pressured === 1,
  };
}

function atThreshold(
  used: PartitionUsage,
  bytes: number,
  rows: number,
): boolean {
  return (
    used.retainedBytes >= bytes ||
    used.unacknowledgedBytes >= bytes ||
    used.retainedCount >= rows ||
    used.unacknowledgedCount >= rows
  );
}

export function refreshOutboxPressure(
  db: DatabaseSync,
  limits: RuntimeLimits,
): boolean {
  const snapshot = outboxBudgetSnapshot(db);
  const regular = reservedRegularUsage(snapshot);
  const pressured = snapshot.pressured
    ? atThreshold(regular, limits.eventLowBytes, limits.eventLowRows)
    : atThreshold(regular, limits.eventSoftBytes, limits.eventSoftRows);

  if (snapshot.pressured !== pressured) {
    db.prepare(
      "UPDATE runtime_event_pressure SET pressured = ? WHERE id = 1",
    ).run(pressured ? 1 : 0);
  }

  return pressured;
}

function reservedRegularUsage(snapshot: OutboxBudgetSnapshot): PartitionUsage {
  return {
    retainedCount:
      snapshot.regular.retainedCount + snapshot.reservedRegularRows,
    retainedBytes:
      snapshot.regular.retainedBytes + snapshot.reservedRegularBytes,
    unacknowledgedCount:
      snapshot.regular.unacknowledgedCount + snapshot.reservedRegularRows,
    unacknowledgedBytes:
      snapshot.regular.unacknowledgedBytes + snapshot.reservedRegularBytes,
  };
}

// One frame emits a raw line, optional cost, one semantic update/permission,
// and at most one mutually exclusive guardrail event. Prompt completion and
// declared output availability use the producer wallet when pressured.
export const FRAME_EVENT_ROWS = 4;
export const FRAME_EVENT_BYTES = FRAME_EVENT_ROWS * 1_048_576;

export function reserveFrameCapacity(
  db: DatabaseSync,
  limits: RuntimeLimits,
  input: {
    reservationId: string;
    bootId: string;
    walletId: string;
  },
): boolean {
  if (refreshOutboxPressure(db, limits)) return false;
  const used = reservedRegularUsage(outboxBudgetSnapshot(db));

  if (
    used.retainedBytes + FRAME_EVENT_BYTES > limits.eventHardBytes ||
    used.retainedCount + FRAME_EVENT_ROWS > limits.eventHardRows
  )
    return false;
  if (
    !db
      .prepare(
        "SELECT 1 FROM runtime_event_wallets WHERE wallet_id = ? AND closed = 0",
      )
      .get(input.walletId)
  ) {
    throw new HostRuntimeEventError(
      "event_outbox_terminal_reserve_exhausted",
      "an output frame requires its accepted producer wallet",
    );
  }
  db.prepare("INSERT INTO runtime_event_frames VALUES (?, ?, ?, ?, ?)").run(
    input.reservationId,
    input.bootId,
    input.walletId,
    FRAME_EVENT_ROWS,
    FRAME_EVENT_BYTES,
  );

  return true;
}

export function assertOutboxAdmission(
  db: DatabaseSync,
  limits: RuntimeLimits,
): void {
  if (refreshOutboxPressure(db, limits)) {
    throw new HostRuntimeEventError(
      "event_outbox_soft_limit",
      "runtime event outbox is above the command admission soft limit or awaiting its low watermark",
    );
  }
}

/** Restart cannot shrink capacity underneath already persisted promises. */
export function assertStoredOutboxFits(
  db: DatabaseSync,
  limits: RuntimeLimits,
): void {
  const snapshot = outboxBudgetSnapshot(db);

  if (
    snapshot.regular.retainedBytes > limits.eventHardBytes ||
    snapshot.regular.retainedCount > limits.eventHardRows
  ) {
    throw new HostRuntimeEventError(
      "event_outbox_hard_limit",
      "configured regular capacity is smaller than retained runtime events",
    );
  }
  if (
    snapshot.control.retainedCount + snapshot.reservedControlRows >
      limits.eventControlRows - EMERGENCY_EVENT_ROWS ||
    snapshot.control.retainedBytes + snapshot.reservedControlBytes >
      limits.eventControlBytes - EMERGENCY_EVENT_BYTES
  ) {
    throw new HostRuntimeEventError(
      "event_outbox_terminal_reserve_exhausted",
      "configured control capacity cannot honor persisted producer wallets",
    );
  }
}

export function reserveProducerWallet(
  db: DatabaseSync,
  limits: RuntimeLimits,
  binding: ProducerWalletBinding,
): void {
  const rows = producerWalletRows(binding.outputBindingCount);
  const existing = db
    .prepare("SELECT * FROM runtime_event_wallets WHERE wallet_id = ?")
    .get(binding.walletId);

  if (existing) {
    if (existing.closed !== 0) {
      throw new HostRuntimeEventError(
        "command_invariant_conflict",
        "a completed producer wallet cannot admit another execution under the same command id",
      );
    }
    if (
      existing.run_id !== binding.runId ||
      existing.assignment_id !== binding.assignmentId ||
      existing.assignment_epoch !== binding.assignmentEpoch ||
      existing.output_binding_count !== binding.outputBindingCount
    ) {
      throw new HostRuntimeEventError(
        "stream_identity_conflict",
        "producer wallet identity does not match its accepted command",
      );
    }

    return;
  }
  assertOutboxAdmission(db, limits);
  const snapshot = outboxBudgetSnapshot(db);

  if (
    snapshot.control.retainedCount + snapshot.reservedControlRows + rows >
      limits.eventControlRows - EMERGENCY_EVENT_ROWS ||
    snapshot.control.retainedBytes +
      snapshot.reservedControlBytes +
      rows * CONTROL_EVENT_MAX_BYTES >
      limits.eventControlBytes - EMERGENCY_EVENT_BYTES
  ) {
    throw new HostRuntimeEventError(
      "event_outbox_terminal_reserve_exhausted",
      "runtime event control capacity cannot fund another producer wallet",
    );
  }
  db.prepare(
    `INSERT INTO runtime_event_wallets
    (wallet_id, run_id, assignment_id, assignment_epoch, output_binding_count, remaining_rows)
    VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    binding.walletId,
    binding.runId,
    binding.assignmentId,
    binding.assignmentEpoch,
    binding.outputBindingCount,
    rows,
  );
}

export function closeProducerWallet(db: DatabaseSync, walletId: string): void {
  db.prepare(
    "UPDATE runtime_event_wallets SET remaining_rows = 0, closed = 1 WHERE wallet_id = ?",
  ).run(walletId);
}

/** Admission and future teardown credit are committed with the accepted receipt. */
export function admitReceipt(
  db: DatabaseSync,
  limits: RuntimeLimits,
  receipt: BudgetReceipt,
  admission?: ReceiptAdmission,
): void {
  if (
    receipt.phase !== "accepted" ||
    db
      .prepare("SELECT 1 FROM command_receipts WHERE command_id = ?")
      .get(receipt.commandId)
  )
    return;
  if (admission?.kind === "producer") {
    if (receipt.kind !== "session.create" || receipt.assignmentId === null) {
      throw new HostRuntimeEventError(
        "stream_identity_conflict",
        "a producer wallet requires an accepted fenced create receipt",
      );
    }
    reserveProducerWallet(db, limits, {
      walletId: receipt.commandId,
      runId: receipt.runId,
      assignmentId: receipt.assignmentId,
      assignmentEpoch: receipt.epoch,
      outputBindingCount: admission.outputBindingCount,
    });

    return;
  }
  if (admission?.kind !== "teardown") {
    assertOutboxAdmission(db, limits);
    if (
      receipt.kind === "session.prompt" &&
      receipt.hostSessionId !== null &&
      db
        .prepare(
          "SELECT 1 FROM command_receipts WHERE host_session_id = ? AND kind = 'session.prompt' AND phase = 'accepted' LIMIT 1",
        )
        .get(receipt.hostSessionId)
    ) {
      throw new HostRuntimeEventError(
        "command_in_progress",
        "a producer can own only one accepted prompt at a time",
      );
    }

    return;
  }
  if (
    !["session.cancel", "session.checkpoint", "session.delete"].includes(
      receipt.kind,
    )
  ) {
    throw new HostRuntimeEventError(
      "stream_identity_conflict",
      "only a producer teardown command can use terminal credit",
    );
  }
  const active = db
    .prepare(
      "SELECT 1 FROM runtime_event_teardowns WHERE wallet_id = ? AND completed = 0",
    )
    .get(admission.walletId);

  if (active) {
    throw new HostRuntimeEventError(
      "event_outbox_terminal_reserve_exhausted",
      "a producer teardown command is already in progress",
    );
  }
  // New IDs cannot manufacture an unlimited cancellation loop during pressure.
  // Normal turns may start another chain after capacity has recovered.
  if (
    refreshOutboxPressure(db, limits) &&
    db
      .prepare(
        "SELECT 1 FROM runtime_event_teardowns WHERE wallet_id = ? AND kind = ?",
      )
      .get(admission.walletId, receipt.kind)
  ) {
    throw new HostRuntimeEventError(
      "event_outbox_terminal_reserve_exhausted",
      "the pressured producer already admitted this teardown step; replay its command id",
    );
  }
  const reserved = db
    .prepare(
      `UPDATE runtime_event_wallets SET remaining_rows = remaining_rows - 2
    WHERE wallet_id = ? AND run_id = ?
      AND ((assignment_id = ? AND assignment_epoch = ?) OR
        (assignment_epoch < ? AND EXISTS (SELECT 1 FROM run_fences f
          WHERE f.run_id = runtime_event_wallets.run_id AND f.assignment_id = ? AND f.epoch = ?)))
      AND closed = 0 AND remaining_rows >= 2`,
    )
    .run(
      admission.walletId,
      receipt.runId,
      receipt.assignmentId,
      receipt.epoch,
      receipt.epoch,
      receipt.assignmentId,
      receipt.epoch,
    );

  if (reserved.changes !== 1) {
    throw new HostRuntimeEventError(
      "event_outbox_terminal_reserve_exhausted",
      "producer teardown cannot reserve its acceptance and completion credit",
    );
  }
  db.prepare(
    "INSERT INTO runtime_event_teardowns (command_id, wallet_id, kind, remaining_rows) VALUES (?, ?, ?, 2)",
  ).run(receipt.commandId, admission.walletId, receipt.kind);
}

/** Releases only unused promises; committed control rows remain charged. */
export function settleReceiptBudget(
  db: DatabaseSync,
  receipt: BudgetReceipt,
): void {
  if (receipt.phase === "accepted") return;
  if (receipt.kind === "session.create" && receipt.phase === "rejected") {
    db.prepare(
      "UPDATE runtime_event_wallets SET session_ended = 1 WHERE wallet_id = ? AND host_session_id IS NULL",
    ).run(receipt.commandId);
  }
  const teardown = db
    .prepare(
      "SELECT wallet_id, remaining_rows FROM runtime_event_teardowns WHERE command_id = ? AND completed = 0",
    )
    .get(receipt.commandId) as
    | { wallet_id: string; remaining_rows: number }
    | undefined;

  if (teardown) {
    db.prepare(
      "UPDATE runtime_event_wallets SET remaining_rows = remaining_rows + ? WHERE wallet_id = ? AND closed = 0",
    ).run(teardown.remaining_rows, teardown.wallet_id);
    db.prepare(
      "UPDATE runtime_event_teardowns SET remaining_rows = 0, completed = 1 WHERE command_id = ?",
    ).run(receipt.commandId);
  }
  releaseEndedWallets(db);
}

function releaseEndedWallets(db: DatabaseSync): void {
  db.exec(`UPDATE runtime_event_wallets SET remaining_rows = 0, closed = 1
    WHERE session_ended = 1 AND closed = 0
      AND NOT EXISTS (SELECT 1 FROM command_receipts r WHERE r.phase = 'accepted'
        AND (r.host_session_id = runtime_event_wallets.host_session_id OR r.command_id = runtime_event_wallets.wallet_id))
      AND NOT EXISTS (SELECT 1 FROM runtime_event_teardowns t WHERE t.wallet_id = runtime_event_wallets.wallet_id AND t.completed = 0)`);
}

export function markProducerEnded(
  db: DatabaseSync,
  walletId: string,
  hostSessionId: string,
): void {
  db.prepare(
    "UPDATE runtime_event_wallets SET session_ended = 1, host_session_id = ? WHERE wallet_id = ?",
  ).run(hostSessionId, walletId);
  releaseEndedWallets(db);
}

// Called only inside the same IMMEDIATE transaction as the event insert.
// A failed insert rolls back its spend; allocating a sequence never spends twice.
export function spendEventCapacity(
  db: DatabaseSync,
  limits: RuntimeLimits,
  input: {
    funding: EventFunding;
    encodedBytes: number;
    runId: string;
    assignmentId: string;
    assignmentEpoch: number;
  },
): EventPartition {
  const { funding, encodedBytes } = input;
  const used = usage(db, funding.partition);

  if (funding.partition === "regular") {
    if (funding.reservationId) {
      const spent = db
        .prepare(
          `UPDATE runtime_event_frames SET remaining_rows = remaining_rows - 1, remaining_bytes = remaining_bytes - ?
        WHERE reservation_id = ? AND remaining_rows > 0 AND remaining_bytes >= ?
          AND EXISTS (SELECT 1 FROM runtime_event_wallets w WHERE w.wallet_id = runtime_event_frames.wallet_id
            AND w.run_id = ? AND w.assignment_id = ? AND w.assignment_epoch = ?)`,
        )
        .run(
          encodedBytes,
          funding.reservationId,
          encodedBytes,
          input.runId,
          input.assignmentId,
          input.assignmentEpoch,
        );

      if (spent.changes !== 1)
        throw new HostRuntimeEventError(
          "event_outbox_hard_limit",
          "an output frame exceeded its event reservation",
        );
    }
    const regular = reservedRegularUsage(outboxBudgetSnapshot(db));

    if (
      regular.retainedBytes + encodedBytes > limits.eventHardBytes ||
      regular.unacknowledgedBytes + encodedBytes > limits.eventHardBytes ||
      regular.retainedCount + 1 > limits.eventHardRows ||
      regular.unacknowledgedCount + 1 > limits.eventHardRows
    ) {
      throw new HostRuntimeEventError(
        "event_outbox_hard_limit",
        "runtime event outbox regular partition is full",
      );
    }

    return "regular";
  }
  if (encodedBytes > CONTROL_EVENT_MAX_BYTES) {
    throw new HostRuntimeEventError(
      "event_outbox_terminal_reserve_exhausted",
      "runtime event control record exceeds 16 KiB",
    );
  }
  if (funding.partition === "emergency") {
    if (
      used.retainedBytes + encodedBytes > EMERGENCY_EVENT_BYTES ||
      used.retainedCount + 1 > EMERGENCY_EVENT_ROWS
    ) {
      throw new HostRuntimeEventError(
        "event_outbox_terminal_reserve_exhausted",
        "runtime event emergency floor is exhausted",
      );
    }

    return "emergency";
  }
  if (
    funding.commandId &&
    db
      .prepare(
        "SELECT 1 FROM runtime_event_teardowns WHERE command_id = ? AND wallet_id = ?",
      )
      .get(funding.commandId, funding.walletId)
  ) {
    const spent = db
      .prepare(
        `UPDATE runtime_event_teardowns SET remaining_rows = remaining_rows - 1
      WHERE command_id = ? AND wallet_id = ? AND completed = 0 AND remaining_rows > 0
        AND EXISTS (SELECT 1 FROM runtime_event_wallets w WHERE w.wallet_id = runtime_event_teardowns.wallet_id
          AND w.run_id = ? AND w.assignment_id = ? AND w.assignment_epoch = ?)`,
      )
      .run(
        funding.commandId,
        funding.walletId,
        input.runId,
        input.assignmentId,
        input.assignmentEpoch,
      );

    if (spent.changes !== 1)
      throw new HostRuntimeEventError(
        "event_outbox_terminal_reserve_exhausted",
        "producer teardown credit is exhausted",
      );

    return "control";
  }
  const spent = db
    .prepare(
      `UPDATE runtime_event_wallets SET remaining_rows = remaining_rows - 1
    WHERE wallet_id = ? AND run_id = ? AND assignment_id = ? AND assignment_epoch = ?
      AND closed = 0 AND remaining_rows > 0`,
    )
    .run(
      funding.walletId,
      input.runId,
      input.assignmentId,
      input.assignmentEpoch,
    );

  if (spent.changes !== 1) {
    throw new HostRuntimeEventError(
      "event_outbox_terminal_reserve_exhausted",
      "runtime event requires an available credit from its producer wallet",
    );
  }

  return "control";
}
