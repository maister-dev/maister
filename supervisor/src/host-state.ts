import type { Logger } from "pino";

import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants as fsConstants,
  mkdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { commandReceiptPayloadV2 } from "./command-event";
import {
  DEFAULT_RUNTIME_LIMITS,
  MAX_RECEIPT_BODY_BYTES,
  sqliteControlHeadroomBytes,
  runtimeLimitsFromEnv,
  validateRuntimeLimits,
  type RuntimeLimits,
} from "./runtime-limits";
import {
  admitReceipt,
  assertOutboxAdmission,
  assertStoredOutboxFits,
  closeProducerWallet,
  outboxBudgetSnapshot,
  OUTBOX_BUDGET_SCHEMA,
  refreshOutboxPressure,
  markProducerEnded,
  reserveFrameCapacity,
  settleReceiptBudget,
  type ReceiptAdmission,
  spendEventCapacity,
  type EventFunding,
  type OutboxBudgetSnapshot,
} from "./outbox-budget";
import { inventoryRuntimeFiles } from "./runtime-file-inventory";
import { HostRuntimeEventError } from "./host-runtime-errors";
import {
  createSqliteStorage,
  type SqliteStorageSnapshot,
} from "./sqlite-storage";
import {
  OUTBOX_ACK_SCHEMA,
  recordRuntimeEventAck,
  RUNTIME_EVENT_ACK_TIMESTAMP_SQL,
} from "./outbox-ack";
import {
  RUNTIME_FILE_BUDGET_SCHEMA,
  reserveRuntimeFrameFiles,
  producerIsStarting,
  auditRuntimeFileBudget,
  claimRuntimeFileWriter,
  releaseRuntimeFileWriter,
  reserveProducerFileWallet,
  runtimeFileBudgetSnapshot,
  refreshRuntimeFilePressure,
  getRuntimeFile,
  reserveRuntimeFile,
  growRuntimeFile,
  recordRuntimeFileBytes,
  sealRuntimeFile,
  releaseRuntimeFile,
  type RuntimeFileBudgetSnapshot,
  type RuntimeFileRow,
  type RuntimeFileFunding,
} from "./runtime-file-budget";
import {
  buildRuntimeEventEnvelope,
  MAX_RUNTIME_EVENT_BYTES,
  RuntimeEventEnvelopeSchema,
  type RuntimeEventDraft,
} from "./runtime-events";

// ADR-166 D1/D3/D6/D7: the supervisor-private execution-host state store. One
// node:sqlite file holds the durable half of the host contract — its identity,
// the per-run fence high-water, adopted-workspace handles, and command
// receipts. The web tier never reads it.

export const HOST_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
export const HOST_STATE_FILE = "state.sqlite";
// The compacted body of a retired receipt: disposition stays in `phase` /
// `http_status`, so the tombstone needs no payload of its own.
const RETIRED_RECEIPT_BODY = JSON.stringify({ retired: true });

// Retired receipts are never deleted, so retention is bounded by a count that
// refuses NEW admissions instead of silently forgetting a still-valid key.
export const MAX_RETAINED_RECEIPTS = 500_000;

export type CommandRetirementProof = {
  expectedRequestSha256: string | null;
  expectedPhase: "completed" | "rejected";
  assignmentEpoch: number;
};

export type ReceiptRetirementOutcome =
  | {
      outcome: "retired" | "already_retired";
      commandId: string;
      requestSha256: string | null;
      phase: "completed" | "rejected";
      retiredAt: string;
    }
  | {
      outcome:
        | "missing"
        | "not_terminal"
        | "identity_mismatch"
        | "terminal_event_unacked"
        | "producer_open";
    };
export const EXECUTION_HOST_PROTOCOL_VERSION = 1;
// `PRAGMA user_version` of the state file; bumped with every migration below.
export const HOST_STATE_SCHEMA_VERSION = 12;
const MAX_HOST_EVENT_SEQUENCE = (1n << 63n) - 1n;
const HOST_EVENT_SEQUENCE_SORT_WIDTH = 20;

export const HARD_RUNTIME_EVENT_OUTBOX_BYTES =
  DEFAULT_RUNTIME_LIMITS.eventHardBytes;
export const SOFT_RUNTIME_EVENT_OUTBOX_BYTES =
  DEFAULT_RUNTIME_LIMITS.eventSoftBytes;
export const TERMINAL_RUNTIME_EVENT_RESERVE_BYTES =
  DEFAULT_RUNTIME_LIMITS.eventControlBytes;
export const MAX_RUNTIME_EVENT_OUTBOX_BYTES =
  HARD_RUNTIME_EVENT_OUTBOX_BYTES + TERMINAL_RUNTIME_EVENT_RESERVE_BYTES;
export const RUNTIME_EVENT_ACK_PRUNE_GRACE_MS =
  DEFAULT_RUNTIME_LIMITS.eventAckGraceMs;
export const RUNTIME_EVENT_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;

export { HostRuntimeEventError } from "./host-runtime-errors";

export class HostKeyConflictError extends Error {
  readonly storedKeyPrefix: string;
  readonly pinnedKeyPrefix: string;

  constructor(storedKey: string, pinnedKey: string) {
    super(
      `MAISTER_EXECUTION_HOST_KEY (${keyPrefix(pinnedKey)}…) conflicts with the stored execution-host key (${keyPrefix(storedKey)}…); unset the pin, or deliberately wipe the state dir`,
    );
    this.name = "HostKeyConflictError";
    this.storedKeyPrefix = keyPrefix(storedKey);
    this.pinnedKeyPrefix = keyPrefix(pinnedKey);
  }
}

export class HostStateUnwritableError extends Error {
  readonly stateDir: string;

  constructor(stateDir: string, cause: unknown) {
    super(
      `execution-host state dir is not writable: ${stateDir} (${cause instanceof Error ? cause.message : String(cause)})`,
      { cause },
    );
    this.name = "HostStateUnwritableError";
    this.stateDir = stateDir;
  }
}

export function keyPrefix(key: string): string {
  return key.slice(0, 8);
}

export type RunFence = {
  runId: string;
  assignmentId: string;
  epoch: number;
  updatedAt: string;
};

export type ReceiptPhase = "accepted" | "completed" | "rejected";

export type CommandReceiptRow = {
  commandId: string;
  runId: string;
  kind: string;
  assignmentId: string | null;
  epoch: number;
  hostSessionId: string | null;
  requestDigest: string | null;
  // Absent/null values identify a legacy receipt; never synthesize bindings.
  requestVersion?: 1 | 2;
  requestSchema?: string | null;
  hostKey?: string | null;
  acceptedSequence?: string | null;
  terminalStreamId?: string | null;
  terminalSequence?: string | null;
  eventId: string | null;
  phase: ReceiptPhase;
  httpStatus: number;
  body: unknown;
  receivedAt: string;
  completedAt: string | null;
};

export type WorkspaceRow = {
  id: string;
  runId: string;
  projectSlug: string;
  kind: string;
  path: string;
  realPath: string;
  repoPath: string | null;
  runDir: string;
  contextMounts: unknown[] | null;
  adoptedAt: string;
  releasedAt: string | null;
};

// This row is deliberately supervisor-private. `privatePath` is never put in
// an event, response, or manager-owned record; callers use only `id`.
export type HostRuntimeObjectRow = {
  id: string;
  runId: string;
  assignmentId: string;
  assignmentEpoch: number;
  hostSessionId: string | null;
  kind: string;
  logicalName: string;
  mimeType: string;
  sizeBytes: number | null;
  sha256: string | null;
  generation: number;
  retentionClass: string;
  state:
    | "pending"
    | "available"
    | "deleting"
    | "missing"
    | "deleted"
    | "expired"
    | "corrupt";
  privatePath: string;
  createdAt: string;
  sealedAt: string | null;
  expiresAt: string | null;
  deletedAt: string | null;
  lastError: Record<string, unknown> | null;
};

export type HostRuntimeEventRow = {
  streamId: string;
  sequence: string;
  eventId: string;
  envelope: Record<string, unknown>;
  encodedBytes: number;
  occurredAt: string;
  acknowledgedAt: string | null;
  createdAt: string;
};

export type AppendRuntimeEventInput = {
  draft: RuntimeEventDraft;
  terminal?: boolean;
  funding?: EventFunding;
};

export type RuntimeEventOutboxStats = {
  budget: OutboxBudgetSnapshot;
  streamId: string;
  acknowledgedThrough: string | null;
  replayFloor: string | null;
  unacknowledgedCount: number;
  unacknowledgedBytes: number;
  retainedCount: number;
  retainedBytes: number;
};

export type HostState = {
  readonly limits: RuntimeLimits;
  runtimeFileBudget(): RuntimeFileBudgetSnapshot;
  getRuntimeFile(fileId: string): RuntimeFileRow | null;
  claimRuntimeFileWriter(fileId: string, token: string): void;
  releaseRuntimeFileWriter(fileId: string, token: string): void;
  reserveRuntimeFile(file: RuntimeFileRow, funding: RuntimeFileFunding): void;
  growRuntimeFile(
    fileId: string,
    bytes: number,
    funding: RuntimeFileFunding,
  ): void;
  recordRuntimeFileBytes(fileId: string, writtenBytes: number): void;
  sealRuntimeFile(fileId: string, writtenBytes: number): void;
  releaseRuntimeFile(fileId: string): void;
  runtimeStorageAvailable(): boolean;
  reportRuntimeStorageFailure(error: unknown): void;
  subscribeRuntimeStorageFailure(listener: () => void): () => void;
  runtimeStorageSnapshot(): SqliteStorageSnapshot;
  readonly hostKey: string;
  readonly bootId: string;
  // Realpath of the state dir (null in memory): path checks against it must
  // compare realpaths, or a symlinked dir (macOS /tmp) slips past them.
  readonly stateDirReal: string | null;
  getFence(runId: string): RunFence | null;
  setFence(runId: string, assignmentId: string, epoch: number): void;
  getReceipt(commandId: string): CommandReceiptRow | null;
  putReceipt(row: CommandReceiptRow, admission?: ReceiptAdmission): void;
  reserveProducerReceipt(
    row: CommandReceiptRow,
    outputBindingCount: number,
  ): void;
  closeProducerWallet(walletId: string): void;
  bindProducerSession(walletId: string, hostSessionId: string): void;
  tryReserveRuntimeFrame(walletId: string, frameBytes?: number): string | null;
  releaseRuntimeFrame(reservationId: string): void;
  subscribeRuntimeCapacity(
    listener: (snapshot: OutboxBudgetSnapshot) => void,
  ): () => void;
  // A fresh supervisor process has no ACP process to join. Canonical async
  // prompt receipts retain their fence/session binding, so startup can make
  // the loss explicit through one durable terminal receipt/event pair.
  recoverAcceptedPromptReceipts(): number;
  retainedReceiptCount(): number;
  retireReceipt(
    commandId: string,
    request: CommandRetirementProof,
  ): ReceiptRetirementOutcome;
  findWorkspaceByRealPath(runId: string, realPath: string): WorkspaceRow | null;
  getWorkspace(id: string): WorkspaceRow | null;
  insertWorkspace(row: WorkspaceRow): void;
  releaseWorkspace(id: string, releasedAt: string): boolean;
  getRuntimeObject(id: string): HostRuntimeObjectRow | null;
  insertRuntimeObject(row: HostRuntimeObjectRow): void;
  reserveRuntimeObject(
    row: HostRuntimeObjectRow,
    capacityBytes: number,
    funding: RuntimeFileFunding,
  ): void;
  deleteRuntimeObject(id: string): boolean;
  updateRuntimeObject(
    id: string,
    patch: Pick<
      HostRuntimeObjectRow,
      "state" | "sizeBytes" | "sha256" | "sealedAt" | "deletedAt" | "lastError"
    >,
  ): HostRuntimeObjectRow;
  appendRuntimeEvent(input: AppendRuntimeEventInput): HostRuntimeEventRow;
  putReceiptWithRuntimeEvent(
    receipt: CommandReceiptRow,
    event: AppendRuntimeEventInput,
    admission?: ReceiptAdmission,
  ): HostRuntimeEventRow;
  getRuntimeEventStreamId(): string;
  nextRuntimeEventPosition(): { streamId: string; sequence: string };
  runtimeEventsAfter(
    streamId: string,
    afterSequence: string | null,
    limit?: number,
  ): HostRuntimeEventRow[];
  pendingRuntimeEvents(streamId: string, limit?: number): HostRuntimeEventRow[];
  hasRuntimeEventsAfter(streamId: string, sequence: string): boolean;
  ackRuntimeEvents(streamId: string, throughSequence: string): string;
  runtimeEventOutboxStats(): RuntimeEventOutboxStats;
  assertCanAcceptMutatingCommand(): void;
  pruneAcknowledgedRuntimeEvents(olderThan: Date): number;
  subscribeRuntimeEvents(
    listener: (event: HostRuntimeEventRow) => void,
  ): () => void;
  close(): void;
};

export type OpenHostStateOptions = {
  limits?: RuntimeLimits;
  stateDir?: string;
  // Tests and route-only boots: an ephemeral store with a minted key.
  inMemory?: boolean;
  pinnedKey?: string;
  logger?: Logger;
  now?: () => Date;
};

export function defaultHostStateDir(runtimeRoot: string): string {
  return path.resolve(runtimeRoot, ".maister", "execution-host");
}

export function hostStateDirFromEnv(
  runtimeRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.MAISTER_EXECUTION_HOST_STATE_DIR;

  return configured
    ? path.resolve(configured)
    : defaultHostStateDir(runtimeRoot);
}

export function mintHostKey(): string {
  return `eh_${randomUUID().replace(/-/g, "")}`;
}

const WORKSPACES_COLUMNS = `
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  project_slug TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  real_path TEXT NOT NULL,
  repo_path TEXT,
  run_dir TEXT NOT NULL,
  context_mounts TEXT,
  adopted_at TEXT NOT NULL,
  released_at TEXT`;

// One ACTIVE handle per (run, realpath). Released rows stay as history, so the
// same path can be re-adopted after a release (an ADR-141 reopen re-creates
// the worktree at the same path).
const WORKSPACES_ACTIVE_INDEX = `CREATE UNIQUE INDEX IF NOT EXISTS workspaces_active_uq
  ON workspaces (run_id, real_path) WHERE released_at IS NULL`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS host_identity (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  host_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS run_fences (
  run_id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspaces (${WORKSPACES_COLUMNS});
${WORKSPACES_ACTIVE_INDEX};
CREATE TABLE IF NOT EXISTS command_receipts (
  command_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  assignment_id TEXT,
  epoch INTEGER NOT NULL,
  host_session_id TEXT,
  request_digest TEXT,
  request_schema TEXT,
  request_version INTEGER NOT NULL DEFAULT 1 CHECK (request_version IN (1, 2)),
  host_key TEXT,
  accepted_sequence TEXT,
  terminal_stream_id TEXT,
  terminal_sequence TEXT,
  event_id TEXT,
  phase TEXT NOT NULL,
  http_status INTEGER NOT NULL,
  body_json TEXT NOT NULL,
  received_at TEXT NOT NULL,
  completed_at TEXT,
  retired_at TEXT
);
CREATE INDEX IF NOT EXISTS command_receipts_received_idx ON command_receipts (received_at);
CREATE TABLE IF NOT EXISTS runtime_objects (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  assignment_epoch INTEGER NOT NULL,
  host_session_id TEXT,
  kind TEXT NOT NULL,
  logical_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER,
  sha256 TEXT,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  retention_class TEXT NOT NULL,
  state TEXT NOT NULL,
  private_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sealed_at TEXT,
  expires_at TEXT,
  deleted_at TEXT,
  last_error_json TEXT
);
CREATE INDEX IF NOT EXISTS runtime_objects_run_state_idx ON runtime_objects (run_id, state, created_at);
CREATE INDEX IF NOT EXISTS runtime_objects_expiry_idx ON runtime_objects (expires_at) WHERE expires_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS runtime_event_streams (
  stream_id TEXT PRIMARY KEY,
  next_sequence TEXT NOT NULL,
  acknowledged_through TEXT,
  acknowledged_sort_key TEXT,
  replay_floor_sequence TEXT,
  replay_floor_sort_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runtime_event_outbox (
  stream_id TEXT NOT NULL,
  sequence TEXT NOT NULL,
  sequence_sort_key TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  envelope_json TEXT NOT NULL,
  encoded_bytes INTEGER NOT NULL CHECK (encoded_bytes >= 0),
  budget_partition TEXT NOT NULL DEFAULT 'regular' CHECK (budget_partition IN ('regular', 'control', 'emergency')),
  occurred_at TEXT NOT NULL,
  acknowledged_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (stream_id, sequence),
  FOREIGN KEY (stream_id) REFERENCES runtime_event_streams (stream_id)
);
CREATE INDEX IF NOT EXISTS runtime_event_outbox_stream_replay_idx
  ON runtime_event_outbox (stream_id, sequence_sort_key);
CREATE INDEX IF NOT EXISTS runtime_event_outbox_stream_pending_idx
  ON runtime_event_outbox (stream_id, acknowledged_at, sequence_sort_key);
${OUTBOX_BUDGET_SCHEMA}
${OUTBOX_ACK_SCHEMA}
${RUNTIME_FILE_BUDGET_SCHEMA}
`;

// user_version 0 stores carry an inline UNIQUE (run_id, real_path) on
// `workspaces`, which CREATE TABLE IF NOT EXISTS cannot drop: rebuild the
// table under the partial unique index, keeping every row.
const MIGRATE_V0_TO_V1 = `
BEGIN;
CREATE TABLE workspaces_v1 (${WORKSPACES_COLUMNS});
INSERT INTO workspaces_v1
  SELECT id, run_id, project_slug, kind, path, real_path, repo_path, run_dir, context_mounts, adopted_at, released_at
  FROM workspaces;
DROP TABLE workspaces;
ALTER TABLE workspaces_v1 RENAME TO workspaces;
${WORKSPACES_ACTIVE_INDEX};
PRAGMA user_version = 1;
COMMIT;
`;

// Event sequences are decimal strings rather than SQLite INTEGER values: the
// public event envelope promises precision beyond JavaScript's safe integer
// range, while lexical sort keys retain an indexed, deterministic replay
// order through the signed 64-bit host counter limit.
const MIGRATE_V1_TO_V2 = `
BEGIN;
CREATE TABLE runtime_event_streams (
  stream_id TEXT PRIMARY KEY,
  next_sequence TEXT NOT NULL,
  acknowledged_through TEXT,
  acknowledged_sort_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE runtime_event_outbox (
  stream_id TEXT NOT NULL,
  sequence TEXT NOT NULL,
  sequence_sort_key TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  envelope_json TEXT NOT NULL,
  encoded_bytes INTEGER NOT NULL CHECK (encoded_bytes >= 0),
  occurred_at TEXT NOT NULL,
  acknowledged_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (stream_id, sequence),
  FOREIGN KEY (stream_id) REFERENCES runtime_event_streams (stream_id)
);
CREATE INDEX runtime_event_outbox_stream_replay_idx
  ON runtime_event_outbox (stream_id, sequence_sort_key);
CREATE INDEX runtime_event_outbox_stream_pending_idx
  ON runtime_event_outbox (stream_id, acknowledged_at, sequence_sort_key);
PRAGMA user_version = 2;
COMMIT;
`;

const MIGRATE_V2_TO_V3 = `
BEGIN;
ALTER TABLE runtime_event_streams ADD COLUMN replay_floor_sequence TEXT;
ALTER TABLE runtime_event_streams ADD COLUMN replay_floor_sort_key TEXT;
PRAGMA user_version = 3;
COMMIT;
`;

// Stage A receipt rows predate request identity and canonical event linkage.
// They remain readable as legacy rows (NULL columns); every Stage B write
// supplies both values when it atomically emits a session command event.
const MIGRATE_V3_TO_V4 = `
BEGIN;
ALTER TABLE command_receipts ADD COLUMN request_digest TEXT;
ALTER TABLE command_receipts ADD COLUMN event_id TEXT;
PRAGMA user_version = 4;
COMMIT;
`;

// The Stage B async prompt recovery boundary needs the assignment fence and
// host session that accepted the turn. Earlier Stage A rows remain readable
// with NULL provenance and continue through the bounded legacy path.
const MIGRATE_V4_TO_V5 = `
BEGIN;
ALTER TABLE command_receipts ADD COLUMN assignment_id TEXT;
ALTER TABLE command_receipts ADD COLUMN host_session_id TEXT;
PRAGMA user_version = 5;
COMMIT;
`;

const MIGRATE_V5_TO_V6 = `
BEGIN;
CREATE TABLE runtime_objects (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  assignment_epoch INTEGER NOT NULL,
  host_session_id TEXT,
  kind TEXT NOT NULL,
  logical_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER,
  sha256 TEXT,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  retention_class TEXT NOT NULL,
  state TEXT NOT NULL,
  private_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sealed_at TEXT,
  expires_at TEXT,
  deleted_at TEXT,
  last_error_json TEXT
);
CREATE INDEX runtime_objects_run_state_idx ON runtime_objects (run_id, state, created_at);
CREATE INDEX runtime_objects_expiry_idx ON runtime_objects (expires_at) WHERE expires_at IS NOT NULL;
PRAGMA user_version = 6;
COMMIT;
`;

const MIGRATE_V6_TO_V7 = `
BEGIN IMMEDIATE;
ALTER TABLE runtime_event_outbox ADD COLUMN budget_partition TEXT NOT NULL DEFAULT 'regular'
  CHECK (budget_partition IN ('regular', 'control', 'emergency'));
${OUTBOX_BUDGET_SCHEMA}
UPDATE runtime_event_budget SET
  retained_count = (SELECT COUNT(*) FROM runtime_event_outbox),
  retained_bytes = (SELECT COALESCE(SUM(encoded_bytes), 0) FROM runtime_event_outbox),
  unacknowledged_count = (SELECT COUNT(*) FROM runtime_event_outbox WHERE acknowledged_at IS NULL),
  unacknowledged_bytes = (SELECT COALESCE(SUM(encoded_bytes), 0) FROM runtime_event_outbox WHERE acknowledged_at IS NULL)
WHERE partition = 'regular';
PRAGMA user_version = 7;
COMMIT;
`;

const MIGRATE_V7_TO_V8 = `
BEGIN IMMEDIATE;
${OUTBOX_ACK_SCHEMA}
PRAGMA user_version = 8;
COMMIT;
`;

const MIGRATE_V8_TO_V9 = `
BEGIN IMMEDIATE;
${RUNTIME_FILE_BUDGET_SCHEMA}
INSERT OR IGNORE INTO runtime_files (file_id, private_path, temporary_path, kind, wallet_id, capacity_bytes, written_bytes, sealed)
SELECT 'object:' || id, private_path, private_path || '.' || generation || '.partial', 'object', NULL,
  CASE WHEN state IN ('deleted', 'expired') THEN 0 WHEN state = 'pending' THEN 2 * COALESCE(size_bytes, 26214400) ELSE COALESCE(size_bytes, 26214400) END,
  CASE WHEN state IN ('available', 'deleting', 'corrupt') THEN COALESCE(size_bytes, 0) ELSE 0 END,
  CASE WHEN state = 'pending' THEN 0 ELSE 1 END FROM runtime_objects;
INSERT OR IGNORE INTO runtime_file_wallets (wallet_id, remaining_bytes)
SELECT wallet_id, 8388608 FROM runtime_event_wallets WHERE closed = 0;
PRAGMA user_version = 9;
COMMIT;
`;

const MIGRATE_V9_TO_V10 = `
BEGIN IMMEDIATE;
ALTER TABLE command_receipts ADD COLUMN request_schema TEXT;
ALTER TABLE command_receipts ADD COLUMN host_key TEXT;
ALTER TABLE command_receipts ADD COLUMN accepted_sequence TEXT;
ALTER TABLE command_receipts ADD COLUMN terminal_stream_id TEXT;
ALTER TABLE command_receipts ADD COLUMN terminal_sequence TEXT;
PRAGMA user_version = 10;
COMMIT;
`;

const MIGRATE_V10_TO_V11 = `
BEGIN IMMEDIATE;
ALTER TABLE command_receipts ADD COLUMN request_version INTEGER NOT NULL DEFAULT 1 CHECK (request_version IN (1, 2));
PRAGMA user_version = 11;
COMMIT;
`;

const MIGRATE_V11_TO_V12 = `
BEGIN IMMEDIATE;
ALTER TABLE command_receipts ADD COLUMN retired_at TEXT;
PRAGMA user_version = 12;
COMMIT;
`;

function applySchema(db: DatabaseSync): void {
  const fresh =
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'host_identity'",
      )
      .get() === undefined;

  if (fresh) {
    db.exec(SCHEMA);
    db.exec(`PRAGMA user_version = ${HOST_STATE_SCHEMA_VERSION}`);

    return;
  }

  const { user_version } = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };

  if (Number(user_version) > HOST_STATE_SCHEMA_VERSION) {
    throw new HostRuntimeEventError(
      "stream_corrupt",
      "host state schema is newer than this supervisor",
    );
  }
  if (Number(user_version) < 1) db.exec(MIGRATE_V0_TO_V1);
  if (Number(user_version) < 2) db.exec(MIGRATE_V1_TO_V2);
  if (Number(user_version) < 3) db.exec(MIGRATE_V2_TO_V3);
  if (Number(user_version) < 4) db.exec(MIGRATE_V3_TO_V4);
  if (Number(user_version) < 5) db.exec(MIGRATE_V4_TO_V5);
  if (Number(user_version) < 6) db.exec(MIGRATE_V5_TO_V6);
  if (Number(user_version) < 7) db.exec(MIGRATE_V6_TO_V7);
  if (Number(user_version) < 8) db.exec(MIGRATE_V7_TO_V8);
  if (Number(user_version) < 9) db.exec(MIGRATE_V8_TO_V9);
  if (Number(user_version) < 10) db.exec(MIGRATE_V9_TO_V10);
  if (Number(user_version) < 11) db.exec(MIGRATE_V10_TO_V11);
  if (Number(user_version) < 12) db.exec(MIGRATE_V11_TO_V12);
}

export function openHostState(opts: OpenHostStateOptions = {}): HostState {
  const limits = opts.limits
    ? validateRuntimeLimits(opts.limits)
    : runtimeLimitsFromEnv();
  const now = opts.now ?? (() => new Date());
  const log = opts.logger?.child({ component: "host-state" });
  const stateDir = opts.inMemory ? null : path.resolve(opts.stateDir ?? "");

  if (!opts.inMemory && !opts.stateDir) {
    throw new Error("openHostState requires stateDir unless inMemory is set");
  }

  let db: DatabaseSync;
  let stateDirReal: string | null = null;

  try {
    if (stateDir) {
      mkdirSync(stateDir, { recursive: true });
      accessSync(stateDir, fsConstants.W_OK);
      stateDirReal = realpathSync(stateDir);
    }
    db = new DatabaseSync(
      stateDir ? path.join(stateDir, HOST_STATE_FILE) : ":memory:",
    );
    if (stateDir) {
      db.exec("PRAGMA journal_mode = WAL");
      // A command receipt and its durable event are a recovery boundary; NORMAL
      // risks acknowledging an ACP side effect whose outbox row is absent after
      // a power loss. Stage B chooses correctness over the local write latency.
      db.exec("PRAGMA synchronous = FULL");
    }
    applySchema(db);
  } catch (err) {
    throw new HostStateUnwritableError(stateDir ?? ":memory:", err);
  }

  const identityRow = db
    .prepare("SELECT host_key FROM host_identity WHERE id = 1")
    .get() as { host_key: string } | undefined;
  const pinned = opts.pinnedKey?.trim() || undefined;

  if (pinned && !HOST_KEY_PATTERN.test(pinned)) {
    db.close();
    throw new Error(
      "MAISTER_EXECUTION_HOST_KEY must match ^[A-Za-z0-9_-]{8,64}$",
    );
  }

  let hostKey: string;

  if (identityRow) {
    if (pinned && pinned !== identityRow.host_key) {
      db.close();
      throw new HostKeyConflictError(identityRow.host_key, pinned);
    }
    hostKey = identityRow.host_key;
  } else {
    hostKey = pinned ?? mintHostKey();
    db.prepare(
      "INSERT INTO host_identity (id, host_key, created_at) VALUES (1, ?, ?)",
    ).run(hostKey, now().toISOString());
  }

  try {
    auditRuntimeEventState(db);
    assertStoredOutboxFits(db, limits);
    auditRuntimeFileBudget(db, limits);
  } catch (error) {
    db.close();
    if (error instanceof HostRuntimeEventError) throw error;
    throw new HostRuntimeEventError(
      "stream_corrupt",
      `runtime event outbox startup audit failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const storage = createSqliteStorage({
    db,
    file: stateDir ? path.join(stateDir, HOST_STATE_FILE) : null,
    limits,
    logger: log,
  });
  const physicalControlReserve = sqliteControlHeadroomBytes(limits);
  const canAdmitPhysical = (additionalBytes = 0): boolean => {
    const budget = outboxBudgetSnapshot(db);

    return storage.canAdmit(
      physicalControlReserve +
        budget.reservedRegularBytes * 2 +
        budget.reservedRegularRows * 16 * 1024 +
        additionalBytes,
    );
  };
  const assertPhysicalAdmission = (): void => {
    if (!storage.available())
      throw new HostRuntimeEventError(
        "runtime_storage_unavailable",
        "runtime storage requires repair before admission resumes",
      );
    if (!canAdmitPhysical())
      throw new HostRuntimeEventError(
        "event_outbox_soft_limit",
        "physical runtime state capacity is reserved for admitted producer work",
      );
  };
  const bootId = randomUUID();

  // An old process cannot still own a parser reservation on this single host.
  // Its accepted commands retain their independent durable terminal wallets.
  db.exec("DELETE FROM runtime_frame_file_credits");
  db.exec("DELETE FROM runtime_event_frames");
  refreshOutboxPressure(db, limits);
  const capacityListeners = new Set<(snapshot: OutboxBudgetSnapshot) => void>();
  const notifyCapacity = (): void => {
    const previous = outboxBudgetSnapshot(db).pressured;
    const pressured = refreshOutboxPressure(db, limits);
    const logical = outboxBudgetSnapshot(db);
    const previousFilePressure = runtimeFileBudgetSnapshot(db).pressured;
    const filePressure = refreshRuntimeFilePressure(db, limits);

    if (previousFilePressure !== filePressure)
      log?.info(runtimeFileBudgetSnapshot(db), "runtime-file-pressure-changed");
    const snapshot = {
      ...logical,
      pressured: logical.pressured || filePressure || !canAdmitPhysical(),
    };

    if (previous !== pressured)
      log?.info({ ...snapshot }, "runtime-event-pressure-changed");
    for (const listener of capacityListeners) {
      try {
        listener(snapshot);
      } catch (error) {
        log?.warn({ err: error }, "runtime-event-capacity-listener-failed");
      }
    }
  };
  const runtimeEventListeners = new Set<(event: HostRuntimeEventRow) => void>();

  const notifyRuntimeEventListeners = (event: HostRuntimeEventRow): void => {
    for (const listener of runtimeEventListeners) {
      try {
        listener(event);
      } catch (error) {
        log?.warn(
          { eventId: event.eventId, sequence: event.sequence, err: error },
          "runtime-event-listener-failed",
        );
      }
    }
  };

  const withRuntimeFileWrite = <T>(operation: () => T): T =>
    storage.write(() => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = operation();

        db.exec("COMMIT");
        notifyCapacity();

        return result;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });

  const admitRuntimeReceipt = (
    row: CommandReceiptRow,
    admission?: ReceiptAdmission,
  ): void => {
    if (
      row.phase === "accepted" &&
      row.kind.startsWith("session.") &&
      admission?.kind !== "teardown" &&
      refreshRuntimeFilePressure(db, limits)
    )
      throw new HostRuntimeEventError(
        "runtime_storage_pressure",
        "runtime file capacity is reserved until usage drops below the low watermark",
      );
    admitReceipt(db, limits, row, admission);
    if (row.phase === "accepted" && admission?.kind === "producer")
      reserveProducerFileWallet(
        db,
        limits,
        row.commandId,
        admission.outputBindingCount,
        storage.snapshot().filesystemFreeBytes,
      );
  };

  const state: HostState = {
    limits,
    hostKey,
    bootId,
    stateDirReal,
    runtimeFileBudget() {
      return runtimeFileBudgetSnapshot(db);
    },
    claimRuntimeFileWriter(fileId, token) {
      return withRuntimeFileWrite(() =>
        claimRuntimeFileWriter(db, fileId, bootId, token),
      );
    },
    releaseRuntimeFileWriter(fileId, token) {
      return withRuntimeFileWrite(() =>
        releaseRuntimeFileWriter(db, fileId, bootId, token),
      );
    },
    getRuntimeFile(fileId) {
      return getRuntimeFile(db, fileId);
    },
    reserveRuntimeFile(file, funding) {
      return withRuntimeFileWrite(() =>
        reserveRuntimeFile(db, limits, file, funding),
      );
    },
    growRuntimeFile(fileId, bytes, funding) {
      return withRuntimeFileWrite(() =>
        growRuntimeFile(db, limits, fileId, bytes, funding),
      );
    },
    recordRuntimeFileBytes(fileId, writtenBytes) {
      return withRuntimeFileWrite(() =>
        recordRuntimeFileBytes(db, fileId, writtenBytes),
      );
    },
    sealRuntimeFile(fileId, writtenBytes) {
      return withRuntimeFileWrite(() =>
        sealRuntimeFile(db, limits, fileId, writtenBytes),
      );
    },
    releaseRuntimeFile(fileId) {
      return withRuntimeFileWrite(() => releaseRuntimeFile(db, limits, fileId));
    },
    runtimeStorageAvailable: storage.available,
    reportRuntimeStorageFailure: storage.reportFailure,
    subscribeRuntimeStorageFailure: storage.subscribeFailure,
    runtimeStorageSnapshot: storage.snapshot,
    getFence(runId) {
      const row = db
        .prepare(
          "SELECT run_id, assignment_id, epoch, updated_at FROM run_fences WHERE run_id = ?",
        )
        .get(runId) as
        | {
            run_id: string;
            assignment_id: string;
            epoch: number;
            updated_at: string;
          }
        | undefined;

      return row
        ? {
            runId: row.run_id,
            assignmentId: row.assignment_id,
            epoch: Number(row.epoch),
            updatedAt: row.updated_at,
          }
        : null;
    },
    setFence(runId, assignmentId, epoch) {
      return storage.write(() => {
        db.prepare(
          `INSERT INTO run_fences (run_id, assignment_id, epoch, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (run_id) DO UPDATE SET
           assignment_id = excluded.assignment_id,
           epoch = excluded.epoch,
           updated_at = excluded.updated_at`,
        ).run(runId, assignmentId, epoch, now().toISOString());
      });
    },
    getReceipt(commandId) {
      const row = db
        .prepare(
          `SELECT command_id, run_id, kind, assignment_id, epoch, host_session_id, request_digest, request_schema, request_version, host_key, accepted_sequence, terminal_stream_id, terminal_sequence, event_id, phase, http_status, body_json, received_at, completed_at
           FROM command_receipts WHERE command_id = ?`,
        )
        .get(commandId) as
        | {
            command_id: string;
            run_id: string;
            kind: string;
            assignment_id: string | null;
            epoch: number;
            host_session_id: string | null;
            request_digest: string | null;
            request_schema: string | null;
            request_version: 1 | 2;
            host_key: string | null;
            accepted_sequence: string | null;
            terminal_stream_id: string | null;
            terminal_sequence: string | null;
            event_id: string | null;
            phase: ReceiptPhase;
            http_status: number;
            body_json: string;
            received_at: string;
            completed_at: string | null;
          }
        | undefined;

      if (!row) return null;

      return {
        commandId: row.command_id,
        runId: row.run_id,
        kind: row.kind,
        assignmentId: row.assignment_id,
        epoch: Number(row.epoch),
        hostSessionId: row.host_session_id,
        requestDigest: row.request_digest,
        requestSchema: row.request_schema,
        requestVersion: row.request_version,
        hostKey: row.host_key,
        acceptedSequence: row.accepted_sequence,
        terminalStreamId: row.terminal_stream_id,
        terminalSequence: row.terminal_sequence,
        eventId: row.event_id,
        phase: row.phase,
        httpStatus: Number(row.http_status),
        body: JSON.parse(row.body_json) as unknown,
        receivedAt: row.received_at,
        completedAt: row.completed_at,
      };
    },
    putReceipt(row, admission) {
      return storage.write(() => {
        if (row.phase === "accepted" && admission?.kind !== "teardown")
          assertPhysicalAdmission();
        db.exec("BEGIN IMMEDIATE");
        try {
          admitRuntimeReceipt(row, admission);
          writeReceiptRow(db, row);
          settleReceiptBudget(db, row);
          db.exec("COMMIT");
        } catch (error) {
          if (db.isTransaction) db.exec("ROLLBACK");
          throw error;
        }
        notifyCapacity();
      });
    },
    reserveProducerReceipt(row, outputBindingCount) {
      state.putReceipt(row, { kind: "producer", outputBindingCount });
    },
    bindProducerSession(walletId, hostSessionId) {
      return storage.write(() => {
        const result = db
          .prepare(
            `UPDATE runtime_event_wallets SET host_session_id = ?
        WHERE wallet_id = ? AND closed = 0 AND (host_session_id IS NULL OR host_session_id = ?)`,
          )
          .run(hostSessionId, walletId, hostSessionId);

        if (result.changes !== 1)
          throw new HostRuntimeEventError(
            "stream_identity_conflict",
            "producer session does not match its reserved wallet",
          );
      });
    },
    closeProducerWallet(walletId) {
      return storage.write(() => {
        closeProducerWallet(db, walletId);
        notifyCapacity();
      });
    },
    tryReserveRuntimeFrame(walletId, frameBytes = 1048576) {
      if (!canAdmitPhysical(8 * 1024 * 1024 + 4 * 16 * 1024)) return null;
      const reservationId = randomUUID();

      return storage.write(() => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const reserved = reserveFrameCapacity(db, limits, {
            reservationId,
            bootId,
            walletId,
          });

          if (reserved)
            reserveRuntimeFrameFiles(db, limits, {
              reservationId,
              walletId,
              frameBytes,
              freeBytes: storage.snapshot().filesystemFreeBytes,
            });
          db.exec("COMMIT");
          notifyCapacity();

          return reserved ? reservationId : null;
        } catch (error) {
          if (db.isTransaction) db.exec("ROLLBACK");
          if (
            error instanceof HostRuntimeEventError &&
            error.reason === "runtime_storage_pressure" &&
            !producerIsStarting(db, walletId)
          )
            return null;
          throw error;
        }
      });
    },
    releaseRuntimeFrame(reservationId) {
      return withRuntimeFileWrite(() => {
        db.prepare(
          "DELETE FROM runtime_frame_file_credits WHERE reservation_id = ? AND EXISTS (SELECT 1 FROM runtime_event_frames f WHERE f.reservation_id = runtime_frame_file_credits.reservation_id AND f.boot_id = ?)",
        ).run(reservationId, bootId);
        db.prepare(
          "DELETE FROM runtime_event_frames WHERE reservation_id = ? AND boot_id = ?",
        ).run(reservationId, bootId);
      });
    },
    subscribeRuntimeCapacity(listener) {
      capacityListeners.add(listener);

      return () => capacityListeners.delete(listener);
    },
    recoverAcceptedPromptReceipts() {
      let recoveredCount = 0;

      type LostReceipt = {
        command_id: string;
        run_id: string;
        kind: string;
        assignment_id: string;
        epoch: number;
        host_session_id: string | null;
        request_digest: string | null;
        request_schema: string | null;
        request_version: 1 | 2;
        host_key: string | null;
        accepted_sequence: string | null;
        received_at: string;
      };
      type LostWallet = {
        wallet_id: string;
        run_id: string;
        assignment_id: string;
        assignment_epoch: number;
        host_session_id: string | null;
      };
      const walletFor =
        db.prepare(`SELECT wallet_id, run_id, assignment_id, assignment_epoch, host_session_id
        FROM runtime_event_wallets WHERE closed = 0 AND (wallet_id = ? OR host_session_id = ?)`);

      // Each repair commits separately so both transient memory and the SQLite
      // write transaction are bounded even for an older receipt backlog.
      for (;;) {
        const rows = db
          .prepare(
            `SELECT command_id, run_id, kind, assignment_id, epoch,
            host_session_id, request_digest, request_schema, request_version, host_key, accepted_sequence, received_at FROM command_receipts
          WHERE phase = 'accepted' AND assignment_id IS NOT NULL AND (
            (kind = 'session.prompt' AND host_session_id IS NOT NULL) OR
            EXISTS (SELECT 1 FROM runtime_event_wallets w WHERE w.closed = 0 AND
              (w.wallet_id = command_receipts.command_id OR w.host_session_id = command_receipts.host_session_id)))
          ORDER BY received_at ASC, command_id ASC LIMIT 100`,
          )
          .all() as LostReceipt[];

        if (rows.length === 0) break;
        for (const row of rows) {
          const wallet = walletFor.get(row.command_id, row.host_session_id) as
            | LostWallet
            | undefined;

          if (
            wallet &&
            ["session.prompt", "session.create"].includes(row.kind) &&
            (wallet.run_id !== row.run_id ||
              wallet.assignment_id !== row.assignment_id ||
              wallet.assignment_epoch !== row.epoch)
          ) {
            throw new HostRuntimeEventError(
              "stream_corrupt",
              "accepted producer receipt does not match its durable wallet fence",
            );
          }
          const body = {
            code: "PRECONDITION",
            message: "the turn for this command id was lost in a host restart",
            details: { reason: "turn_lost", runId: row.run_id },
          };
          const receipt: CommandReceiptRow = {
            commandId: row.command_id,
            runId: row.run_id,
            kind: row.kind,
            assignmentId: row.assignment_id,
            epoch: row.epoch,
            hostSessionId:
              row.host_session_id ?? wallet?.host_session_id ?? null,
            requestDigest: row.request_digest,
            requestSchema: row.request_schema,
            requestVersion: row.request_version,
            hostKey: row.host_key,
            acceptedSequence: row.accepted_sequence,
            eventId: null,
            phase: "rejected",
            httpStatus: 409,
            body,
            receivedAt: row.received_at,
            completedAt: now().toISOString(),
          };

          state.putReceiptWithRuntimeEvent(receipt, {
            terminal: true,
            ...(wallet
              ? {
                  funding: {
                    partition: "control" as const,
                    walletId: wallet.wallet_id,
                    commandId: row.command_id,
                  },
                }
              : {}),
            draft: {
              runId: row.run_id,
              assignmentId: wallet?.assignment_id ?? row.assignment_id,
              assignmentEpoch: wallet?.assignment_epoch ?? row.epoch,
              hostSessionId: receipt.hostSessionId,
              eventType: "session.command",
              occurredAt: now().toISOString(),
              payload:
                row.request_version === 2
                  ? commandReceiptPayloadV2(receipt, state)
                  : {
                      commandId: row.command_id,
                      kind: row.kind,
                      phase: "completed",
                      status: "failed",
                      error: body,
                    },
            },
          });
          recoveredCount += 1;
        }
      }
      const wallets = db
        .prepare(
          `SELECT wallet_id, run_id, assignment_id, assignment_epoch, host_session_id
        FROM runtime_event_wallets WHERE closed = 0 AND session_ended = 0`,
        )
        .all() as LostWallet[];

      for (const wallet of wallets) {
        if (wallet.host_session_id === null) {
          state.closeProducerWallet(wallet.wallet_id);
          continue;
        }
        state.appendRuntimeEvent({
          terminal: true,
          funding: { partition: "control", walletId: wallet.wallet_id },
          draft: {
            runId: wallet.run_id,
            assignmentId: wallet.assignment_id,
            assignmentEpoch: wallet.assignment_epoch,
            hostSessionId: wallet.host_session_id,
            eventType: "session.crashed",
            occurredAt: now().toISOString(),
            payload: { exitCode: null, signal: null, reason: "host_restart" },
          },
        });
      }

      return recoveredCount;
    },
    retainedReceiptCount() {
      const row = db
        .prepare("SELECT COUNT(*) AS n FROM command_receipts")
        .get() as { n: number };

      return Number(row.n);
    },
    // D6: the host's half of retirement. Age is NOT an input — every branch
    // below is evidence this host holds, so the two sides must agree before
    // either compacts. The receipt is compacted, never deleted: the tombstone
    // is what lets a stale replay still be recognised.
    retireReceipt(commandId, request) {
      return storage.write(() => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const row = db
            .prepare(
              `SELECT command_id, phase, http_status, request_digest, request_version,
              epoch, terminal_sequence, retired_at
            FROM command_receipts WHERE command_id = ?`,
            )
            .get(commandId) as
            | {
                command_id: string;
                phase: string;
                http_status: number;
                request_digest: string | null;
                request_version: number;
                epoch: number;
                terminal_sequence: string | null;
                retired_at: string | null;
              }
            | undefined;

          const refuse = (outcome: ReceiptRetirementOutcome["outcome"]) => {
            db.exec("COMMIT");

            return { outcome } as ReceiptRetirementOutcome;
          };

          if (!row) return refuse("missing");
          if (row.phase === "accepted") return refuse("not_terminal");
          // A null digest is "not asserted", not "matches anything": the
          // manager only records a request digest for owned prompts, and the
          // command id, epoch and phase are compared either way. A digest the
          // manager DOES hold must agree.
          if (
            row.phase !== request.expectedPhase ||
            row.epoch !== request.assignmentEpoch ||
            (request.expectedRequestSha256 !== null &&
              request.expectedRequestSha256 !== row.request_digest)
          ) {
            return refuse("identity_mismatch");
          }

          const openProducer = db
            .prepare(
              "SELECT 1 FROM runtime_event_wallets WHERE wallet_id = ? AND closed = 0",
            )
            .get(commandId);

          if (openProducer) return refuse("producer_open");

          if (row.request_version === 2) {
            if (row.terminal_sequence === null)
              return refuse("terminal_event_unacked");
            const stream = ensureRuntimeEventStream(db, now);

            if (
              stream.acknowledged_through === null ||
              BigInt(stream.acknowledged_through) <
                BigInt(row.terminal_sequence)
            ) {
              return refuse("terminal_event_unacked");
            }
          }

          const alreadyRetired = row.retired_at !== null;
          const retiredAt = row.retired_at ?? now().toISOString();

          if (!alreadyRetired) {
            db.prepare(
              "UPDATE command_receipts SET body_json = ?, retired_at = ? WHERE command_id = ?",
            ).run(RETIRED_RECEIPT_BODY, retiredAt, commandId);
          }
          db.exec("COMMIT");

          return {
            outcome: alreadyRetired ? "already_retired" : "retired",
            commandId: row.command_id,
            requestSha256: row.request_digest ?? null,
            phase: row.phase as "completed" | "rejected",
            retiredAt,
          } as ReceiptRetirementOutcome;
        } catch (error) {
          if (db.isTransaction) db.exec("ROLLBACK");
          throw error;
        }
      });
    },
    findWorkspaceByRealPath(runId, realPath) {
      const row = db
        .prepare(
          "SELECT * FROM workspaces WHERE run_id = ? AND real_path = ? AND released_at IS NULL",
        )
        .get(runId, realPath);

      return row ? toWorkspaceRow(row) : null;
    },
    getWorkspace(id) {
      const row = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id);

      return row ? toWorkspaceRow(row) : null;
    },
    insertWorkspace(row) {
      return storage.write(() => {
        db.prepare(
          `INSERT INTO workspaces
           (id, run_id, project_slug, kind, path, real_path, repo_path, run_dir, context_mounts, adopted_at, released_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          row.id,
          row.runId,
          row.projectSlug,
          row.kind,
          row.path,
          row.realPath,
          row.repoPath,
          row.runDir,
          row.contextMounts ? JSON.stringify(row.contextMounts) : null,
          row.adoptedAt,
          row.releasedAt,
        );
      });
    },
    releaseWorkspace(id, releasedAt) {
      return storage.write(() => {
        const result = db
          .prepare(
            "UPDATE workspaces SET released_at = ? WHERE id = ? AND released_at IS NULL",
          )
          .run(releasedAt, id);

        return Number(result.changes) > 0;
      });
    },
    getRuntimeObject(id) {
      const row = db
        .prepare("SELECT * FROM runtime_objects WHERE id = ?")
        .get(id);

      return row ? toHostRuntimeObjectRow(row) : null;
    },
    reserveRuntimeObject(row, capacityBytes, funding) {
      return withRuntimeFileWrite(() => {
        reserveRuntimeFile(
          db,
          limits,
          {
            fileId: `object:${row.id}`,
            privatePath: row.privatePath,
            temporaryPath: `${row.privatePath}.${row.generation}.partial`,
            kind: "object",
            walletId: funding.kind === "regular" ? null : funding.walletId,
            capacityBytes,
            writtenBytes: 0,
            sealed: false,
          },
          funding,
        );
        state.insertRuntimeObject(row);
      });
    },
    insertRuntimeObject(row) {
      return storage.write(() => {
        db.prepare(
          `INSERT INTO runtime_objects
           (id, run_id, assignment_id, assignment_epoch, host_session_id, kind,
            logical_name, mime_type, size_bytes, sha256, generation,
            retention_class, state, private_path, created_at, sealed_at,
            expires_at, deleted_at, last_error_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          row.id,
          row.runId,
          row.assignmentId,
          row.assignmentEpoch,
          row.hostSessionId,
          row.kind,
          row.logicalName,
          row.mimeType,
          row.sizeBytes,
          row.sha256,
          row.generation,
          row.retentionClass,
          row.state,
          row.privatePath,
          row.createdAt,
          row.sealedAt,
          row.expiresAt,
          row.deletedAt,
          row.lastError ? JSON.stringify(row.lastError) : null,
        );
      });
    },
    deleteRuntimeObject(id) {
      return storage.write(() => {
        const result = db
          .prepare("DELETE FROM runtime_objects WHERE id = ?")
          .run(id);

        return Number(result.changes) > 0;
      });
    },
    updateRuntimeObject(id, patch) {
      return storage.write(() => {
        const existing = db
          .prepare("SELECT * FROM runtime_objects WHERE id = ?")
          .get(id);

        if (!existing) throw new Error(`runtime object ${id} is missing`);
        db.prepare(
          `UPDATE runtime_objects
         SET state = ?, size_bytes = ?, sha256 = ?, sealed_at = ?,
             deleted_at = ?, last_error_json = ?
         WHERE id = ?`,
        ).run(
          patch.state,
          patch.sizeBytes,
          patch.sha256,
          patch.sealedAt,
          patch.deletedAt,
          patch.lastError ? JSON.stringify(patch.lastError) : null,
          id,
        );
        const updated = db
          .prepare("SELECT * FROM runtime_objects WHERE id = ?")
          .get(id);

        if (!updated)
          throw new Error(`runtime object ${id} vanished during update`);

        return toHostRuntimeObjectRow(updated);
      });
    },
    appendRuntimeEvent(input) {
      return storage.write(() => {
        if (
          !input.funding ||
          (input.funding.partition === "regular" &&
            !input.funding.reservationId)
        )
          assertPhysicalAdmission();
        db.exec("BEGIN IMMEDIATE");

        try {
          const event = appendRuntimeEventInTransaction(db, {
            limits,
            hostKey,
            bootId,
            now,
            input,
          });

          db.exec("COMMIT");
          notifyCapacity();
          notifyRuntimeEventListeners(event);

          return event;
        } catch (error) {
          if (db.isTransaction) db.exec("ROLLBACK");
          throw error;
        }
      });
    },
    putReceiptWithRuntimeEvent(receipt, eventInput, admission) {
      return storage.write(() => {
        if (receipt.phase === "accepted" && admission?.kind !== "teardown")
          assertPhysicalAdmission();
        db.exec("BEGIN IMMEDIATE");

        try {
          admitRuntimeReceipt(receipt, admission);
          const event = appendRuntimeEventInTransaction(db, {
            limits,
            hostKey,
            bootId,
            now,
            input: eventInput,
          });

          writeReceiptRow(db, {
            ...receipt,
            eventId: event.eventId,
            ...(receipt.phase === "accepted"
              ? { acceptedSequence: event.sequence }
              : {
                  terminalStreamId: event.streamId,
                  terminalSequence: event.sequence,
                }),
          });
          settleReceiptBudget(db, receipt);

          db.exec("COMMIT");
          notifyCapacity();
          notifyRuntimeEventListeners(event);

          return event;
        } catch (error) {
          if (db.isTransaction) db.exec("ROLLBACK");
          throw error;
        }
      });
    },
    nextRuntimeEventPosition() {
      const stream = ensureRuntimeEventStream(db, now);

      return { streamId: stream.stream_id, sequence: stream.next_sequence };
    },
    getRuntimeEventStreamId() {
      return ensureRuntimeEventStream(db, now).stream_id;
    },
    runtimeEventsAfter(streamId, afterSequence, limit = 500) {
      const stream = getRuntimeEventStream(db, streamId);
      const afterSortKey = afterSequence
        ? hostEventSequenceSortKey(parseHostEventSequence(afterSequence))
        : null;

      if (
        stream.replay_floor_sequence !== null &&
        (afterSequence === null ||
          parseHostEventSequence(afterSequence) <
            parseHostEventSequence(stream.replay_floor_sequence))
      ) {
        throw new HostRuntimeEventError(
          "replay_floor_exceeded",
          `runtime event replay must start at retained floor ${stream.replay_floor_sequence}`,
        );
      }

      return runtimeEventPage(
        db,
        streamId,
        afterSortKey,
        validateRuntimeEventLimit(limit),
      );
    },
    pendingRuntimeEvents(streamId, limit = 500) {
      const stream = getRuntimeEventStream(db, streamId);

      return runtimeEventPage(
        db,
        streamId,
        stream.acknowledged_sort_key,
        validateRuntimeEventLimit(limit),
      );
    },
    hasRuntimeEventsAfter(streamId, sequence) {
      getRuntimeEventStream(db, streamId);

      return (
        db
          .prepare(
            "SELECT 1 FROM runtime_event_outbox WHERE stream_id = ? AND sequence_sort_key > ? LIMIT 1",
          )
          .get(
            streamId,
            hostEventSequenceSortKey(parseHostEventSequence(sequence)),
          ) !== undefined
      );
    },
    ackRuntimeEvents(streamId, throughSequence) {
      return storage.write(() => {
        const through = parseHostEventSequence(throughSequence);
        const nowIso = now().toISOString();

        db.exec("BEGIN IMMEDIATE");

        try {
          const stream = getRuntimeEventStream(db, streamId);

          const next = parseHostEventSequence(stream.next_sequence);
          const acknowledged = stream.acknowledged_through
            ? parseHostEventSequence(stream.acknowledged_through)
            : -1n;

          if (through <= acknowledged) {
            db.exec("COMMIT");

            return acknowledged.toString();
          }

          if (through >= next) {
            throw new HostRuntimeEventError(
              "ack_beyond_emitted",
              `runtime event acknowledgement ${through.toString()} is not a contiguous emitted prefix for ${streamId}`,
            );
          }

          const rows = db
            .prepare(
              `SELECT sequence FROM runtime_event_outbox
             WHERE stream_id = ? AND sequence_sort_key > ? AND sequence_sort_key <= ?
             ORDER BY sequence_sort_key ASC`,
            )
            .iterate(
              streamId,
              hostEventSequenceSortKey(acknowledged),
              hostEventSequenceSortKey(through),
            ) as IterableIterator<{ sequence: string }>;

          let expected = acknowledged + 1n;

          for (const row of rows) {
            if (parseHostEventSequence(row.sequence) !== expected) {
              throw new HostRuntimeEventError(
                "ack_not_contiguous",
                `runtime event acknowledgement ${through.toString()} is not contiguous for ${streamId}`,
              );
            }
            expected += 1n;
          }

          if (expected !== through + 1n) {
            throw new HostRuntimeEventError(
              "ack_not_contiguous",
              `runtime event acknowledgement ${through.toString()} is not contiguous for ${streamId}`,
            );
          }

          const throughText = through.toString();
          const throughSortKey = hostEventSequenceSortKey(through);

          db.prepare(
            `UPDATE runtime_event_streams
           SET acknowledged_through = ?, acknowledged_sort_key = ?, updated_at = ?
           WHERE stream_id = ?`,
          ).run(throughText, throughSortKey, nowIso, streamId);
          recordRuntimeEventAck(db, {
            streamId,
            firstSortKey: hostEventSequenceSortKey(acknowledged + 1n),
            throughSortKey,
            acknowledgedAt: nowIso,
          });
          db.exec("COMMIT");

          notifyCapacity();

          return throughText;
        } catch (error) {
          if (db.isTransaction) db.exec("ROLLBACK");
          throw error;
        }
      });
    },
    runtimeEventOutboxStats() {
      const stats = runtimeEventOutboxStats(
        db,
        ensureRuntimeEventStream(db, now).stream_id,
      );

      return {
        ...stats,
        budget: {
          ...stats.budget,
          pressured:
            stats.budget.pressured ||
            runtimeFileBudgetSnapshot(db).pressured ||
            !canAdmitPhysical(),
        },
      };
    },
    assertCanAcceptMutatingCommand() {
      assertPhysicalAdmission();
      assertOutboxAdmission(db, limits);
      // Retirement compacts receipts but never drops the key, so the only
      // honest response to unbounded retention is to stop admitting rather
      // than to forget a key a retry may still legally use (D6).
      const retained = state.retainedReceiptCount();

      if (retained > MAX_RETAINED_RECEIPTS) {
        throw new HostRuntimeEventError(
          "event_outbox_hard_limit",
          `retained command receipts (${retained}) exceed the retirement bound; drain retirement before admitting more commands`,
        );
      }
    },
    pruneAcknowledgedRuntimeEvents(olderThan) {
      return storage.write(() => {
        const cutoff = new Date(
          Math.min(
            olderThan.getTime(),
            now().getTime() - limits.eventAckGraceMs,
          ),
        ).toISOString();

        db.exec("BEGIN IMMEDIATE");
        try {
          const stream = ensureRuntimeEventStream(db, now);
          // An accepted v2 command owns its complete event span until the
          // terminal event is ACKed. ACK alone does not retire the receipt.
          const protectedSpan = db
            .prepare(
              `SELECT accepted_sequence AS sequence
            FROM command_receipts WHERE request_version = 2 AND accepted_sequence IS NOT NULL
            AND (terminal_sequence IS NULL OR CAST(terminal_sequence AS INTEGER) > CAST(? AS INTEGER))
            ORDER BY length(accepted_sequence), accepted_sequence LIMIT 1`,
            )
            .get(stream.acknowledged_through ?? "-1") as
            | { sequence: string }
            | undefined;
          const candidates = db
            .prepare(
              `SELECT e.sequence, e.sequence_sort_key, e.encoded_bytes,
            ${RUNTIME_EVENT_ACK_TIMESTAMP_SQL} AS acknowledged_at
          FROM runtime_event_outbox e WHERE e.stream_id = ? ORDER BY e.sequence_sort_key ASC LIMIT 100`,
            )
            .all(stream.stream_id) as Array<{
            sequence: string;
            sequence_sort_key: string;
            encoded_bytes: number;
            acknowledged_at: string | null;
          }>;
          let bytes = 0;
          let count = 0;
          let last: { sequence: string; sequence_sort_key: string } | undefined;

          for (const row of candidates) {
            if (
              (protectedSpan !== undefined &&
                BigInt(row.sequence) >= BigInt(protectedSpan.sequence)) ||
              row.acknowledged_at === null ||
              row.acknowledged_at >= cutoff ||
              bytes + row.encoded_bytes > MAX_RUNTIME_EVENT_BYTES
            )
              break;
            bytes += row.encoded_bytes;
            count += 1;
            last = row;
          }
          if (!last) {
            db.exec("COMMIT");

            return 0;
          }
          db.prepare(
            `UPDATE runtime_event_streams SET replay_floor_sequence = ?, replay_floor_sort_key = ?, updated_at = ?
          WHERE stream_id = ?`,
          ).run(
            last.sequence,
            last.sequence_sort_key,
            now().toISOString(),
            stream.stream_id,
          );
          const result = db
            .prepare(
              "DELETE FROM runtime_event_outbox WHERE stream_id = ? AND sequence_sort_key <= ?",
            )
            .run(stream.stream_id, last.sequence_sort_key);

          if (Number(result.changes) !== count)
            throw new HostRuntimeEventError(
              "stream_corrupt",
              "pruned runtime event prefix did not match its bounded page",
            );
          db.prepare(
            "DELETE FROM runtime_event_ack_ranges WHERE stream_id = ? AND through_sort_key <= ?",
          ).run(stream.stream_id, last.sequence_sort_key);
          db.exec("COMMIT");
          notifyCapacity();

          return count;
        } catch (error) {
          if (db.isTransaction) db.exec("ROLLBACK");
          throw error;
        }
      });
    },
    subscribeRuntimeEvents(listener) {
      runtimeEventListeners.add(listener);

      return () => runtimeEventListeners.delete(listener);
    },
    close() {
      db.close();
    },
  };

  log?.info(
    {
      hostKey,
      bootId,
      stateDir: stateDir ?? ":memory:",
      pinned: Boolean(pinned),
      retainedReceipts: state.retainedReceiptCount(),
    },
    "execution-host-identity",
  );

  if (stateDirReal) {
    try {
      inventoryRuntimeFiles({
        db,
        objectRoot: path.join(stateDirReal, "runtime-objects"),
        limits,
        write: storage.write,
      });
    } catch (error) {
      db.close();
      throw new HostRuntimeEventError(
        "runtime_storage_unavailable",
        "runtime file startup inventory failed; preserve files and repair storage before restarting",
        { cause: error },
      );
    }
  }

  return state;
}

type RuntimeEventStreamDbRow = {
  stream_id: string;
  next_sequence: string;
  acknowledged_through: string | null;
  acknowledged_sort_key: string | null;
  replay_floor_sequence: string | null;
  replay_floor_sort_key: string | null;
};

function getRuntimeEventStream(
  db: DatabaseSync,
  streamId: string,
): RuntimeEventStreamDbRow {
  const streams = db
    .prepare(
      `SELECT stream_id, next_sequence, acknowledged_through, acknowledged_sort_key,
              replay_floor_sequence, replay_floor_sort_key
       FROM runtime_event_streams ORDER BY created_at ASC`,
    )
    .all() as RuntimeEventStreamDbRow[];

  if (streams.length !== 1 || streams[0]?.stream_id !== streamId) {
    throw new HostRuntimeEventError(
      "stream_identity_conflict",
      `runtime event stream ${streamId} is not the current host stream`,
    );
  }

  return streams[0];
}

function ensureRuntimeEventStream(
  db: DatabaseSync,
  now: () => Date,
): RuntimeEventStreamDbRow {
  const existing = db
    .prepare(
      `SELECT stream_id, next_sequence, acknowledged_through, acknowledged_sort_key,
              replay_floor_sequence, replay_floor_sort_key
       FROM runtime_event_streams ORDER BY created_at ASC`,
    )
    .all() as RuntimeEventStreamDbRow[];

  if (existing.length > 1) {
    throw new HostRuntimeEventError(
      "stream_corrupt",
      "execution host has more than one runtime event stream",
    );
  }
  if (existing[0]) return existing[0];

  const streamId = randomUUID();
  const createdAt = now().toISOString();

  db.prepare(
    `INSERT INTO runtime_event_streams
       (stream_id, next_sequence, acknowledged_through, acknowledged_sort_key,
        replay_floor_sequence, replay_floor_sort_key, created_at, updated_at)
     VALUES (?, '0', NULL, NULL, NULL, NULL, ?, ?)`,
  ).run(streamId, createdAt, createdAt);

  return getRuntimeEventStream(db, streamId);
}

function runtimeEventOutboxStats(
  db: DatabaseSync,
  streamId: string,
): RuntimeEventOutboxStats {
  const stream = getRuntimeEventStream(db, streamId);
  const budget = outboxBudgetSnapshot(db);
  const partitions = [budget.regular, budget.control, budget.emergency];

  return {
    budget,
    streamId,
    acknowledgedThrough: stream.acknowledged_through,
    replayFloor: stream.replay_floor_sequence,
    unacknowledgedCount: partitions.reduce(
      (sum, item) => sum + item.unacknowledgedCount,
      0,
    ),
    unacknowledgedBytes: partitions.reduce(
      (sum, item) => sum + item.unacknowledgedBytes,
      0,
    ),
    retainedCount: partitions.reduce(
      (sum, item) => sum + item.retainedCount,
      0,
    ),
    retainedBytes: partitions.reduce(
      (sum, item) => sum + item.retainedBytes,
      0,
    ),
  };
}

function appendRuntimeEventInTransaction(
  db: DatabaseSync,
  args: {
    hostKey: string;
    bootId: string;
    now: () => Date;
    input: AppendRuntimeEventInput;
    limits: RuntimeLimits;
  },
): HostRuntimeEventRow {
  const stream = ensureRuntimeEventStream(db, args.now);
  const sequence = parseHostEventSequence(stream.next_sequence);

  if (sequence > MAX_HOST_EVENT_SEQUENCE) {
    throw new HostRuntimeEventError(
      "stream_corrupt",
      `runtime event stream ${stream.stream_id} exhausted its sequence space`,
    );
  }

  const sequenceText = sequence.toString();
  const envelope = buildRuntimeEventEnvelope({
    hostKey: args.hostKey,
    hostBootId: args.bootId,
    streamId: stream.stream_id,
    sequence: sequenceText,
    draft: args.input.draft,
  });
  const envelopeJson = JSON.stringify(envelope);
  const encodedBytes = Buffer.byteLength(envelopeJson, "utf8");
  const partition = spendEventCapacity(db, args.limits, {
    funding: args.input.funding ?? { partition: "regular" },
    encodedBytes,
    runId: args.input.draft.runId,
    assignmentId: args.input.draft.assignmentId,
    assignmentEpoch: args.input.draft.assignmentEpoch,
  });

  const createdAt = args.now().toISOString();

  db.prepare(
    `INSERT INTO runtime_event_outbox
       (stream_id, sequence, sequence_sort_key, event_id, envelope_json, encoded_bytes,
        occurred_at, acknowledged_at, created_at, budget_partition)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    stream.stream_id,
    sequenceText,
    hostEventSequenceSortKey(sequence),
    envelope.eventId,
    envelopeJson,
    encodedBytes,
    envelope.occurredAt,
    createdAt,
    partition,
  );
  db.prepare(
    "UPDATE runtime_event_streams SET next_sequence = ?, updated_at = ? WHERE stream_id = ?",
  ).run((sequence + 1n).toString(), createdAt, stream.stream_id);

  if (
    args.input.funding?.partition === "control" &&
    args.input.draft.hostSessionId &&
    ["session.exited", "session.crashed"].includes(args.input.draft.eventType)
  ) {
    markProducerEnded(
      db,
      args.input.funding.walletId,
      args.input.draft.hostSessionId,
    );
  }

  return {
    streamId: stream.stream_id,
    sequence: sequenceText,
    eventId: envelope.eventId,
    envelope,
    encodedBytes,
    occurredAt: envelope.occurredAt,
    acknowledgedAt: null,
    createdAt,
  };
}

function writeReceiptRow(db: DatabaseSync, row: CommandReceiptRow): void {
  const bodyJson = JSON.stringify(row.body ?? {});

  if (Buffer.byteLength(bodyJson, "utf8") > MAX_RECEIPT_BODY_BYTES)
    throw new HostRuntimeEventError(
      "command_invariant_conflict",
      "command receipt exceeds the 2 MiB durable response bound",
    );
  db.prepare(
    `INSERT INTO command_receipts
       (command_id, run_id, kind, assignment_id, epoch, host_session_id, request_digest, request_schema, request_version, host_key, accepted_sequence, terminal_stream_id, terminal_sequence, event_id, phase, http_status, body_json, received_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (command_id) DO UPDATE SET
       assignment_id = COALESCE(command_receipts.assignment_id, excluded.assignment_id),
       host_session_id = COALESCE(command_receipts.host_session_id, excluded.host_session_id),
       request_digest = COALESCE(command_receipts.request_digest, excluded.request_digest),
       accepted_sequence = COALESCE(command_receipts.accepted_sequence, excluded.accepted_sequence),
       terminal_stream_id = COALESCE(command_receipts.terminal_stream_id, excluded.terminal_stream_id),
       terminal_sequence = COALESCE(command_receipts.terminal_sequence, excluded.terminal_sequence),
       event_id = excluded.event_id,
       phase = excluded.phase,
       http_status = excluded.http_status,
       body_json = excluded.body_json,
       completed_at = excluded.completed_at`,
  ).run(
    row.commandId,
    row.runId,
    row.kind,
    row.assignmentId,
    row.epoch,
    row.hostSessionId,
    row.requestDigest,
    row.requestSchema ?? null,
    row.requestVersion ?? 1,
    row.hostKey ?? null,
    row.acceptedSequence ?? null,
    row.terminalStreamId ?? null,
    row.terminalSequence ?? null,
    row.eventId,
    row.phase,
    row.httpStatus,
    bodyJson,
    row.receivedAt,
    row.completedAt,
  );
}

function auditRuntimeEventState(db: DatabaseSync): void {
  for (const partition of ["regular", "control", "emergency"] as const) {
    const actual = db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(encoded_bytes), 0) AS bytes,
      COALESCE(SUM(e.sequence_sort_key > COALESCE(s.acknowledged_sort_key, '')), 0) AS pending_count,
      COALESCE(SUM(CASE WHEN e.sequence_sort_key > COALESCE(s.acknowledged_sort_key, '') THEN encoded_bytes ELSE 0 END), 0) AS pending_bytes
      FROM runtime_event_outbox e JOIN runtime_event_streams s ON s.stream_id = e.stream_id WHERE budget_partition = ?`,
      )
      .get(partition) as {
      count: number;
      bytes: number;
      pending_count: number;
      pending_bytes: number;
    };
    const stored = outboxBudgetSnapshot(db)[partition];

    if (
      actual.count !== stored.retainedCount ||
      actual.bytes !== stored.retainedBytes ||
      actual.pending_count !== stored.unacknowledgedCount ||
      actual.pending_bytes !== stored.unacknowledgedBytes
    ) {
      throw new HostRuntimeEventError(
        "stream_corrupt",
        "runtime event budget does not match its retained rows",
      );
    }
  }
  const streams = db
    .prepare(
      `SELECT stream_id, next_sequence, acknowledged_through, acknowledged_sort_key,
              replay_floor_sequence, replay_floor_sort_key
       FROM runtime_event_streams ORDER BY created_at ASC`,
    )
    .all() as RuntimeEventStreamDbRow[];

  if (streams.length > 1) {
    throw new HostRuntimeEventError(
      "stream_corrupt",
      "execution host has more than one runtime event stream",
    );
  }
  const stream = streams[0];

  if (!stream) return;

  const next = parseHostEventSequence(stream.next_sequence);
  const acknowledged = stream.acknowledged_through
    ? parseHostEventSequence(stream.acknowledged_through)
    : -1n;
  const replayFloor = stream.replay_floor_sequence
    ? parseHostEventSequence(stream.replay_floor_sequence)
    : -1n;

  if (replayFloor > acknowledged || acknowledged >= next) {
    throw new HostRuntimeEventError(
      "stream_corrupt",
      "runtime event stream watermark relation is invalid",
    );
  }

  const invalid = db
    .prepare(
      `SELECT 1 FROM runtime_event_outbox
    WHERE encoded_bytes > ? OR length(CAST(envelope_json AS BLOB)) <> encoded_bytes LIMIT 1`,
    )
    .get(MAX_RUNTIME_EVENT_BYTES);

  if (invalid)
    throw new HostRuntimeEventError(
      "stream_corrupt",
      "runtime event encoded length is invalid",
    );
  const rows = db
    .prepare(
      `SELECT stream_id, sequence, event_id, envelope_json, encoded_bytes, occurred_at,
              ${RUNTIME_EVENT_ACK_TIMESTAMP_SQL} AS acknowledged_at, created_at
       FROM runtime_event_outbox e WHERE stream_id = ? ORDER BY sequence_sort_key ASC`,
    )
    .iterate(stream.stream_id) as IterableIterator<RuntimeEventOutboxDbRow>;
  let expected = replayFloor + 1n;

  for (const row of rows) {
    const sequence = parseHostEventSequence(row.sequence);

    if (sequence !== expected || sequence >= next) {
      throw new HostRuntimeEventError(
        "stream_corrupt",
        "runtime event outbox sequences are not contiguous",
      );
    }
    const envelope = RuntimeEventEnvelopeSchema.parse(
      JSON.parse(row.envelope_json),
    );

    if (
      envelope.streamId !== stream.stream_id ||
      envelope.sequence !== row.sequence ||
      envelope.eventId !== row.event_id ||
      envelope.occurredAt !== row.occurred_at ||
      Buffer.byteLength(row.envelope_json, "utf8") !== Number(row.encoded_bytes)
    ) {
      throw new HostRuntimeEventError(
        "stream_corrupt",
        "runtime event outbox envelope does not match its indexed fields",
      );
    }
    if (sequence <= acknowledged !== (row.acknowledged_at !== null)) {
      throw new HostRuntimeEventError(
        "stream_corrupt",
        "runtime event acknowledgement markers are inconsistent",
      );
    }
    expected += 1n;
  }

  if (expected !== next) {
    throw new HostRuntimeEventError(
      "stream_corrupt",
      "runtime event stream next sequence has an unrecoverable gap",
    );
  }
}

type RuntimeEventOutboxDbRow = {
  stream_id: string;
  sequence: string;
  event_id: string;
  envelope_json: string;
  encoded_bytes: number;
  occurred_at: string;
  acknowledged_at: string | null;
  created_at: string;
};

function parseHostEventSequence(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(
      `runtime event sequence must be a canonical decimal integer: ${value}`,
    );
  }

  const sequence = BigInt(value);

  if (sequence > MAX_HOST_EVENT_SEQUENCE) {
    throw new Error(
      `runtime event sequence exceeds the host counter limit: ${value}`,
    );
  }

  return sequence;
}

function hostEventSequenceSortKey(sequence: bigint): string {
  // The only internal negative value is the pre-first-event acknowledgement
  // sentinel. '-' sorts before the decimal digits under SQLite BINARY collation.
  if (sequence === -1n) return "-".padEnd(HOST_EVENT_SEQUENCE_SORT_WIDTH, "0");
  if (sequence < 0n || sequence > MAX_HOST_EVENT_SEQUENCE) {
    throw new Error(
      `runtime event sequence cannot be sorted: ${sequence.toString()}`,
    );
  }

  return sequence.toString().padStart(HOST_EVENT_SEQUENCE_SORT_WIDTH, "0");
}

function validateRuntimeEventLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50_000) {
    throw new Error(
      "runtime event replay limit must be an integer between 1 and 50000",
    );
  }

  return limit;
}

function runtimeEventPage(
  db: DatabaseSync,
  streamId: string,
  afterSortKey: string | null,
  limit: number,
): HostRuntimeEventRow[] {
  const candidates = db
    .prepare(
      `SELECT sequence_sort_key, encoded_bytes FROM runtime_event_outbox
    WHERE stream_id = ? AND sequence_sort_key > ? ORDER BY sequence_sort_key ASC LIMIT ?`,
    )
    .all(streamId, afterSortKey ?? "", Math.min(limit, 500)) as Array<{
    sequence_sort_key: string;
    encoded_bytes: number;
  }>;
  let bytes = 0;
  let through: string | null = null;

  for (const row of candidates) {
    if (row.encoded_bytes > MAX_RUNTIME_EVENT_BYTES || row.encoded_bytes < 1) {
      throw new HostRuntimeEventError(
        "stream_corrupt",
        "runtime event replay length is invalid",
      );
    }
    if (bytes + row.encoded_bytes > MAX_RUNTIME_EVENT_BYTES) break;
    bytes += row.encoded_bytes;
    through = row.sequence_sort_key;
  }
  if (through === null) return [];
  const rows = db
    .prepare(
      `SELECT stream_id, sequence, event_id, envelope_json, encoded_bytes, occurred_at,
      ${RUNTIME_EVENT_ACK_TIMESTAMP_SQL} AS acknowledged_at, created_at FROM runtime_event_outbox e
    WHERE stream_id = ? AND sequence_sort_key > ? AND sequence_sort_key <= ? ORDER BY sequence_sort_key ASC`,
    )
    .all(streamId, afterSortKey ?? "", through) as RuntimeEventOutboxDbRow[];

  return rows.map(toHostRuntimeEventRow);
}

function toHostRuntimeEventRow(
  row: RuntimeEventOutboxDbRow,
): HostRuntimeEventRow {
  return {
    streamId: row.stream_id,
    sequence: row.sequence,
    eventId: row.event_id,
    envelope: JSON.parse(row.envelope_json) as Record<string, unknown>,
    encodedBytes: Number(row.encoded_bytes),
    occurredAt: row.occurred_at,
    acknowledgedAt: row.acknowledged_at,
    createdAt: row.created_at,
  };
}

function toWorkspaceRow(row: Record<string, unknown>): WorkspaceRow {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    projectSlug: String(row.project_slug),
    kind: String(row.kind),
    path: String(row.path),
    realPath: String(row.real_path),
    repoPath: row.repo_path === null ? null : String(row.repo_path),
    runDir: String(row.run_dir),
    contextMounts:
      row.context_mounts === null || row.context_mounts === undefined
        ? null
        : (JSON.parse(String(row.context_mounts)) as unknown[]),
    adoptedAt: String(row.adopted_at),
    releasedAt: row.released_at === null ? null : String(row.released_at),
  };
}

function toHostRuntimeObjectRow(
  row: Record<string, unknown>,
): HostRuntimeObjectRow {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    assignmentId: String(row.assignment_id),
    assignmentEpoch: Number(row.assignment_epoch),
    hostSessionId:
      row.host_session_id === null || row.host_session_id === undefined
        ? null
        : String(row.host_session_id),
    kind: String(row.kind),
    logicalName: String(row.logical_name),
    mimeType: String(row.mime_type),
    sizeBytes:
      row.size_bytes === null || row.size_bytes === undefined
        ? null
        : Number(row.size_bytes),
    sha256:
      row.sha256 === null || row.sha256 === undefined
        ? null
        : String(row.sha256),
    generation: Number(row.generation),
    retentionClass: String(row.retention_class),
    state: String(row.state) as HostRuntimeObjectRow["state"],
    privatePath: String(row.private_path),
    createdAt: String(row.created_at),
    sealedAt: row.sealed_at === null ? null : String(row.sealed_at),
    expiresAt: row.expires_at === null ? null : String(row.expires_at),
    deletedAt: row.deleted_at === null ? null : String(row.deleted_at),
    lastError:
      row.last_error_json === null || row.last_error_json === undefined
        ? null
        : (JSON.parse(String(row.last_error_json)) as Record<string, unknown>),
  };
}

// Each pass has a bounded database write; subsequent pages yield to producers.
function startBoundedPruner(input: {
  prune: () => number;
  available: () => boolean;
  reportFailure: (error: unknown) => void;
  logger: Logger;
  message: string;
  intervalMs: number;
}): () => void {
  let immediate: NodeJS.Immediate | undefined;
  let stopped = false;
  const schedule = (): void => {
    if (!stopped && !immediate) immediate = setImmediate(prune);
  };
  const prune = (): void => {
    immediate = undefined;
    if (stopped || !input.available()) return;
    try {
      const pruned = input.prune();

      if (pruned > 0) {
        input.logger.info({ pruned }, input.message);
        schedule();
      }
    } catch (error) {
      input.reportFailure(error);
      input.logger.error(
        {
          reason:
            error instanceof HostRuntimeEventError
              ? error.reason
              : "runtime_storage_failure",
        },
        "runtime-pruner-failed",
      );
      if (input.available()) throw error;
    }
  };

  prune();
  const handle = setInterval(schedule, input.intervalMs);

  handle.unref();

  return () => {
    stopped = true;
    clearInterval(handle);
    if (immediate) clearImmediate(immediate);
  };
}

export function startRuntimeEventPruner(
  state: HostState,
  logger: Logger,
  now: () => Date = () => new Date(),
): () => void {
  return startBoundedPruner({
    prune: () =>
      state.pruneAcknowledgedRuntimeEvents(
        new Date(now().getTime() - state.limits.eventAckGraceMs),
      ),
    available: state.runtimeStorageAvailable,
    reportFailure: state.reportRuntimeStorageFailure,
    logger,
    message: "runtime-event-outbox-pruned",
    intervalMs: RUNTIME_EVENT_PRUNE_INTERVAL_MS,
  });
}
