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
  assertStoredOutboxFits,
  closeProducerWallet,
  outboxBudgetSnapshot,
  outboxPressureEpisode,
  outboxRefusesFrames,
  OUTBOX_BUDGET_SCHEMA,
  refreshOutboxPressure,
  retainedAtThreshold,
  RUNTIME_EVENT_PRESSURE_EPISODE_COLUMNS,
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
export const HOST_STATE_SCHEMA_VERSION = 14;
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
  producerPath: string | null;
  sealedDevice: string | null;
  sealedInode: string | null;
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

/** Why a retained span cannot be served; never a command outcome. */
export type RuntimeEventSpanUnavailableReason =
  | "replay_floor_lost"
  | "stream_identity_changed"
  | "beyond_emitted";

/** One bounded page of the retained range `(after, through]`. */
export type RuntimeEventSpanPage =
  | Readonly<{
      state: "complete" | "partial";
      nextAfter: string | null;
      events: HostRuntimeEventRow[];
    }>
  | Readonly<{
      state: "unavailable";
      reason: RuntimeEventSpanUnavailableReason;
    }>;

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

export type RuntimeEventPruneMode = "grace" | "retained_pressure";

export type RuntimeEventPruneState = Readonly<{
  retainedCount: number;
  retainedBytes: number;
  // Rows no prune may touch: with every ACKed row prunable (ADR-184), these
  // are what a stalled retained-pressure pass is left with.
  unacknowledgedCount: number;
  acknowledgedThrough: string | null;
  oldestRetainedCreatedAt: string | null;
}>;

export type RuntimeEventPressureEpisode = Readonly<{
  since: string;
  unacknowledgedCountAtStart: number;
  unacknowledgedBytesAtStart: number;
  episodes: number;
}>;

export type RuntimeEventHealthSnapshot = Readonly<{
  streamId: string;
  headSequence: string | null;
  unacknowledgedCount: number;
  retainedCount: number;
  pressured: boolean;
  oldestUnacknowledgedAgeMs: number | null;
  pressure: RuntimeEventPressureEpisode | null;
}>;

type RuntimeEventHealthSnapshotDbRow = {
  stream_id: string;
  next_sequence: string;
  unacknowledged_count: number;
  retained_count: number;
  pressured: number;
  since_ms: number | null;
  unacknowledged_count_at_start: number | null;
  unacknowledged_bytes_at_start: number | null;
  episodes: number;
  oldest_unacknowledged_created_at: string | null;
};

export const RUNTIME_EVENT_HEALTH_SNAPSHOT_SQL = `
SELECT
  s.stream_id,
  s.next_sequence,
  totals.unacknowledged_count,
  totals.retained_count,
  p.pressured,
  p.since_ms,
  p.unacknowledged_count_at_start,
  p.unacknowledged_bytes_at_start,
  p.episodes,
  (
    SELECT e.created_at
    FROM runtime_event_outbox e
    WHERE e.stream_id = s.stream_id
      AND e.sequence_sort_key > COALESCE(s.acknowledged_sort_key, '')
    ORDER BY e.sequence_sort_key
    LIMIT 1
  ) AS oldest_unacknowledged_created_at
FROM runtime_event_streams s
CROSS JOIN (
  SELECT
    COALESCE(SUM(unacknowledged_count), 0) AS unacknowledged_count,
    COALESCE(SUM(retained_count), 0) AS retained_count
  FROM runtime_event_budget
) totals
CROSS JOIN runtime_event_pressure p
WHERE p.id = 1
ORDER BY s.created_at
LIMIT 1`;

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
  releaseRuntimeSpool(fileId: string): void;
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
  putReceipt(row: CommandReceiptRow, admission: ReceiptAdmission): void;
  // ADR-183: whether a producer wallet can still fund terminal evidence; a
  // teardown of a session whose wallet closed writes regular rows instead.
  producerWalletOpen(walletId: string): boolean;
  reserveProducerReceipt(
    row: CommandReceiptRow,
    outputBindingCount: number,
  ): void;
  closeProducerWallet(walletId: string): void;
  bindProducerSession(walletId: string, hostSessionId: string): void;
  tryReserveRuntimeFrame(walletId: string, frameBytes?: number): string | null;
  // ADR-183: whether the OUTBOX (unACKed pressure or no room under hard) is
  // what refuses frames, as opposed to runtime-file or physical headroom.
  runtimeEventOutboxRefusesFrames(): boolean;
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
  runtimeObjectsByState(
    state: HostRuntimeObjectRow["state"],
    afterId: string,
    limit: number,
  ): HostRuntimeObjectRow[];
  // Accepted upload/delete receipts name their object, so a restart can settle
  // them from the durable object row (reserve receipts carry no target).
  acceptedRuntimeObjectReceipts(
    afterCommandId: string,
    limit: number,
  ): CommandReceiptRow[];
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
    > &
      Partial<Pick<HostRuntimeObjectRow, "sealedDevice" | "sealedInode">>,
  ): HostRuntimeObjectRow;
  failRuntimeObject(
    id: string,
    state: "missing" | "corrupt",
  ): HostRuntimeObjectRow;
  appendRuntimeEvent(input: AppendRuntimeEventInput): HostRuntimeEventRow;
  putReceiptWithRuntimeEvent(
    receipt: CommandReceiptRow,
    event: AppendRuntimeEventInput,
    admission: ReceiptAdmission,
  ): HostRuntimeEventRow;
  getRuntimeEventStreamId(): string;
  nextRuntimeEventPosition(): { streamId: string; sequence: string };
  runtimeEventsAfter(
    streamId: string,
    afterSequence: string | null,
    limit?: number,
  ): HostRuntimeEventRow[];
  pendingRuntimeEvents(streamId: string, limit?: number): HostRuntimeEventRow[];
  // Read-only: never acknowledges, prunes or creates a stream position.
  runtimeEventsInRange(
    streamId: string,
    after: string,
    through: string,
    limit?: number,
  ): RuntimeEventSpanPage;
  hasRuntimeEventsAfter(streamId: string, sequence: string): boolean;
  ackRuntimeEvents(streamId: string, throughSequence: string): string;
  runtimeEventOutboxStats(): RuntimeEventOutboxStats;
  runtimeEventHealthSnapshot(): RuntimeEventHealthSnapshot;
  // One bounded page (≤ 100 rows / 1 MiB). `grace` prunes rows ACKed before
  // `olderThan` and the replay grace; `retained_pressure` (ADR-183) prunes any
  // confirmed-ACKed row, because retained rows reached the soft budget.
  pruneAcknowledgedRuntimeEvents(
    olderThan: Date,
    options?: { mode?: RuntimeEventPruneMode },
  ): number;
  runtimeEventPruneState(): RuntimeEventPruneState;
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
  producer_path TEXT,
  sealed_device TEXT,
  sealed_inode TEXT,
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
${RUNTIME_EVENT_PRESSURE_EPISODE_COLUMNS}
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

const MIGRATE_V12_TO_V13 = `
BEGIN IMMEDIATE;
ALTER TABLE runtime_objects ADD COLUMN producer_path TEXT;
ALTER TABLE runtime_objects ADD COLUMN sealed_device TEXT;
ALTER TABLE runtime_objects ADD COLUMN sealed_inode TEXT;
PRAGMA user_version = 13;
COMMIT;
`;

// Idempotent: a store reconstructed from the current schema may already carry
// the columns. The v13 bit also counted retained rows, so it is cleared and
// recomputed at open under the unACKed-only predicate (ADR-183).
function migrateV13ToV14(db: DatabaseSync): void {
  const columns = new Set(
    (
      db.prepare("PRAGMA table_info(runtime_event_pressure)").all() as Array<{
        name: string;
      }>
    ).map((column) => column.name),
  );

  db.exec("BEGIN IMMEDIATE");
  try {
    if (columns.has("since_ms")) {
      db.exec(`UPDATE runtime_event_pressure SET pressured = 0, since_ms = NULL,
        unacknowledged_count_at_start = NULL, unacknowledged_bytes_at_start = NULL`);
    } else {
      db.exec("UPDATE runtime_event_pressure SET pressured = 0");
      db.exec(RUNTIME_EVENT_PRESSURE_EPISODE_COLUMNS);
    }
    db.exec("PRAGMA user_version = 14");
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

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
  if (Number(user_version) < 13) db.exec(MIGRATE_V12_TO_V13);
  if (Number(user_version) < 14) migrateV13ToV14(db);
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
  // The OR'd "constrained" bit funds completions and teardown from producer
  // wallets and drains output on teardown. It is NOT the manager-facing
  // pressure (`stream.pressured`, unACKed only — ADR-183): retained rows at
  // soft, file pressure and physical headroom constrain funding too.
  const constrained = (
    budget: OutboxBudgetSnapshot,
    filePressure: boolean,
  ): boolean =>
    budget.pressured ||
    retainedAtThreshold(
      budget.regular,
      limits.eventSoftBytes,
      limits.eventSoftRows,
    ) ||
    filePressure ||
    !canAdmitPhysical();

  // An old process cannot still own a parser reservation on this single host.
  // Its accepted commands retain their independent durable terminal wallets.
  db.exec("DELETE FROM runtime_frame_file_credits");
  db.exec("DELETE FROM runtime_event_frames");
  refreshOutboxPressure(db, limits, now().getTime());
  const capacityListeners = new Set<(snapshot: OutboxBudgetSnapshot) => void>();
  // A flip can commit inside any admission transaction (or roll back with a
  // refused one), so the change is logged from the durable row after each
  // commit rather than at the write.
  let observedPressure = outboxPressureEpisode(db);
  // Refreshes and logs the pressure state after a commit; wakes nobody.
  const observeCapacity = (): OutboxBudgetSnapshot => {
    refreshOutboxPressure(db, limits, now().getTime());
    const logical = outboxBudgetSnapshot(db);
    const previousFilePressure = runtimeFileBudgetSnapshot(db).pressured;
    const filePressure = refreshRuntimeFilePressure(db, limits);

    if (previousFilePressure !== filePressure)
      log?.info(runtimeFileBudgetSnapshot(db), "runtime-file-pressure-changed");
    const snapshot = {
      ...logical,
      pressured: constrained(logical, filePressure),
    };
    const episode = outboxPressureEpisode(db);

    if (
      episode.pressured !== observedPressure.pressured ||
      episode.episodes !== observedPressure.episodes
    ) {
      const partitions = [logical.regular, logical.control, logical.emergency];

      log?.info(
        {
          pressured: episode.pressured,
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
          episodes: episode.episodes,
        },
        "outbox-pressure-changed",
      );
    }
    observedPressure = episode;

    return snapshot;
  };
  const notifyCapacity = (): void => {
    const snapshot = observeCapacity();

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
    admission: ReceiptAdmission,
  ): void => {
    if (
      row.phase === "accepted" &&
      row.kind.startsWith("session.") &&
      admission.kind !== "teardown" &&
      refreshRuntimeFilePressure(db, limits)
    )
      throw new HostRuntimeEventError(
        "runtime_storage_pressure",
        "runtime file capacity is reserved until usage drops below the low watermark",
      );
    admitReceipt(db, limits, row, admission);
    if (row.phase === "accepted" && admission.kind === "producer")
      reserveProducerFileWallet(
        db,
        limits,
        row.commandId,
        admission.outputBindingCount,
        storage.snapshot().filesystemFreeBytes,
      );
  };

  // ADR-183: one line per refused admission, whichever gate refused it.
  const logAdmissionRefusal = (
    row: CommandReceiptRow,
    admission: ReceiptAdmission,
    error: unknown,
  ): void => {
    if (
      row.phase !== "accepted" ||
      !(error instanceof HostRuntimeEventError) ||
      !error.reason.startsWith("event_outbox_")
    )
      return;
    const budget = outboxBudgetSnapshot(db);
    const partitions = [budget.regular, budget.control, budget.emergency];

    log?.warn(
      {
        commandId: row.commandId,
        kind: row.kind,
        admission: admission.kind,
        reason: error.reason,
        unacknowledgedCount: partitions.reduce(
          (sum, item) => sum + item.unacknowledgedCount,
          0,
        ),
        retainedCount: partitions.reduce(
          (sum, item) => sum + item.retainedCount,
          0,
        ),
      },
      "outbox-admission-refused",
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
    releaseRuntimeSpool(fileId) {
      return withRuntimeFileWrite(() => {
        const file = getRuntimeFile(db, fileId);

        if (!file || file.kind !== "spool")
          throw new HostRuntimeEventError(
            "command_invariant_conflict",
            "runtime response spool reservation is missing",
          );
        releaseRuntimeFile(db, limits, fileId);
        db.prepare(
          "DELETE FROM runtime_files WHERE file_id = ? AND kind = 'spool' AND capacity_bytes = 0",
        ).run(fileId);
      });
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
          `SELECT ${RECEIPT_COLUMNS} FROM command_receipts WHERE command_id = ?`,
        )
        .get(commandId) as CommandReceiptDbRow | undefined;

      return row ? toCommandReceiptRow(row) : null;
    },
    acceptedRuntimeObjectReceipts(afterCommandId, limit) {
      return (
        db
          .prepare(
            `SELECT ${RECEIPT_COLUMNS} FROM command_receipts
             WHERE phase = 'accepted' AND host_session_id IS NOT NULL
               AND kind IN ('runtime_object.upload', 'runtime_object.delete')
               AND command_id > ? ORDER BY command_id LIMIT ?`,
          )
          .all(afterCommandId, limit) as CommandReceiptDbRow[]
      ).map(toCommandReceiptRow);
    },
    putReceipt(row, admission) {
      return storage.write(() => {
        try {
          if (row.phase === "accepted" && admission.kind !== "teardown")
            assertPhysicalAdmission();
          db.exec("BEGIN IMMEDIATE");
          admitRuntimeReceipt(row, admission);
          writeReceiptRow(db, row);
          settleReceiptBudget(db, row);
          db.exec("COMMIT");
        } catch (error) {
          if (db.isTransaction) db.exec("ROLLBACK");
          logAdmissionRefusal(row, admission, error);
          throw error;
        }
        notifyCapacity();
      });
    },
    producerWalletOpen(walletId) {
      return (
        db
          .prepare(
            "SELECT 1 FROM runtime_event_wallets WHERE wallet_id = ? AND closed = 0",
          )
          .get(walletId) !== undefined
      );
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
    runtimeEventOutboxRefusesFrames() {
      return outboxRefusesFrames(db, limits);
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
          // A refusal frees no capacity, so it wakes no waiter: when it did,
          // each paused producer's refusal made every other one retry — a
          // cascade factorial in the number of waiters that pegged the host.
          if (reserved) notifyCapacity();
          else observeCapacity();

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

          state.putReceiptWithRuntimeEvent(
            receipt,
            {
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
            },
            // A rejection settles a lost prompt; it admits nothing.
            { kind: "new_work" },
          );
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
    runtimeObjectsByState(state, afterId, limit) {
      return (
        db
          .prepare(
            "SELECT * FROM runtime_objects WHERE state = ? AND id > ? ORDER BY id LIMIT ?",
          )
          .all(state, afterId, limit) as Record<string, unknown>[]
      ).map(toHostRuntimeObjectRow);
    },
    reserveRuntimeObject(row, capacityBytes, funding) {
      return withRuntimeFileWrite(() => {
        reserveRuntimeFile(
          db,
          limits,
          {
            fileId: `object:${row.id}`,
            privatePath: row.privatePath,
            temporaryPath:
              row.producerPath ??
              `${row.privatePath}.${row.generation}.partial`,
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
            expires_at, deleted_at, last_error_json, producer_path, sealed_device, sealed_inode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          row.producerPath,
          row.sealedDevice,
          row.sealedInode,
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

        if (!existing)
          throw new HostRuntimeEventError(
            "stream_corrupt",
            "runtime object update has no intent",
          );
        db.prepare(
          `UPDATE runtime_objects
         SET state = ?, size_bytes = ?, sha256 = ?, sealed_at = ?,
             deleted_at = ?, last_error_json = ?, sealed_device = ?, sealed_inode = ?
         WHERE id = ?`,
        ).run(
          patch.state,
          patch.sizeBytes,
          patch.sha256,
          patch.sealedAt,
          patch.deletedAt,
          patch.lastError ? JSON.stringify(patch.lastError) : null,
          patch.sealedDevice === undefined
            ? existing.sealed_device
            : patch.sealedDevice,
          patch.sealedInode === undefined
            ? existing.sealed_inode
            : patch.sealedInode,
          id,
        );
        const updated = db
          .prepare("SELECT * FROM runtime_objects WHERE id = ?")
          .get(id);

        if (!updated)
          throw new HostRuntimeEventError(
            "stream_corrupt",
            "runtime object vanished during update",
          );

        return toHostRuntimeObjectRow(updated);
      });
    },
    failRuntimeObject(id, nextState) {
      try {
        return storage.write(() => {
          db.exec("BEGIN IMMEDIATE");
          try {
            const object = state.getRuntimeObject(id);

            if (!object)
              throw new HostRuntimeEventError(
                "stream_corrupt",
                "runtime object failure has no intent",
              );
            if (object.state !== "available") {
              db.exec("COMMIT");

              return object;
            }
            const reason =
              nextState === "missing"
                ? "runtime_object_missing"
                : "runtime_object_integrity_mismatch";
            const updated = state.updateRuntimeObject(id, {
              ...object,
              state: nextState,
              lastError: { reason },
            });
            const event = appendRuntimeEventInTransaction(db, {
              limits,
              hostKey,
              bootId,
              now,
              input: {
                terminal: true,
                draft: {
                  runId: object.runId,
                  assignmentId: object.assignmentId,
                  assignmentEpoch: object.assignmentEpoch,
                  hostSessionId: null,
                  eventType: "runtime_object.state",
                  occurredAt: now().toISOString(),
                  payload: {
                    objectId: id,
                    generation: object.generation,
                    state: nextState,
                    deletedAt: object.deletedAt,
                  },
                },
              },
            });

            db.exec("COMMIT");
            notifyCapacity();
            notifyRuntimeEventListeners(event);
            log?.warn(
              { objectId: id, generation: object.generation, reason },
              "runtime-object-read-failed",
            );

            return updated;
          } catch (error) {
            if (db.isTransaction) db.exec("ROLLBACK");
            throw error;
          }
        });
      } catch (error) {
        const failure = new HostRuntimeEventError(
          "runtime_storage_unavailable",
          "runtime object failure evidence could not be persisted",
          { cause: error },
        );

        storage.reportFailure(failure);
        throw failure;
      }
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
        try {
          if (receipt.phase === "accepted" && admission.kind !== "teardown")
            assertPhysicalAdmission();
        } catch (error) {
          logAdmissionRefusal(receipt, admission, error);
          throw error;
        }
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
          logAdmissionRefusal(receipt, admission, error);
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

      // An ABSENT cursor is not a lost cursor. The contract is explicit —
      // "Omission starts at the replay floor" — and every row at or below the
      // floor was deleted, so the retained page already IS the floor-forward
      // replay. Refusing omission wedged a manager with no durable watermark
      // against any host that had ever pruned, permanently and undiagnosably.
      if (
        stream.replay_floor_sequence !== null &&
        afterSequence !== null &&
        parseHostEventSequence(afterSequence) <
          parseHostEventSequence(stream.replay_floor_sequence)
      ) {
        throw new HostRuntimeEventError(
          "replay_floor_exceeded",
          `runtime event replay cursor ${afterSequence} is below the retained floor ${stream.replay_floor_sequence} on stream ${stream.stream_id}`,
        );
      }

      return runtimeEventPage(
        db,
        streamId,
        afterSortKey,
        validateRuntimeEventLimit(limit),
      );
    },
    runtimeEventsInRange(streamId, after, through, limit = 500) {
      const stream = ensureRuntimeEventStream(db, now);

      if (stream.stream_id !== streamId)
        return { state: "unavailable", reason: "stream_identity_changed" };
      const lower = parseHostEventSequence(after);
      const upper = parseHostEventSequence(through);

      // The caller may name a terminal the host has not emitted; answering
      // with whatever exists would read as a complete span.
      if (upper >= parseHostEventSequence(stream.next_sequence))
        return { state: "unavailable", reason: "beyond_emitted" };
      if (
        stream.replay_floor_sequence !== null &&
        lower < parseHostEventSequence(stream.replay_floor_sequence)
      )
        return { state: "unavailable", reason: "replay_floor_lost" };
      const events = runtimeEventPage(
        db,
        streamId,
        hostEventSequenceSortKey(lower),
        validateRuntimeEventLimit(limit),
        hostEventSequenceSortKey(upper),
      );
      const last = events.at(-1)?.sequence;

      // Rows above the floor and below the head are never deleted, so an empty
      // page here means the outbox lost rows it still promises to retain.
      if (last === undefined)
        throw new HostRuntimeEventError(
          "stream_corrupt",
          `runtime event span (${after}, ${through}] has no retained rows on stream ${streamId}`,
        );

      return last === through
        ? { state: "complete", nextAfter: null, events }
        : { state: "partial", nextAfter: last, events };
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
          pressured: constrained(
            stats.budget,
            runtimeFileBudgetSnapshot(db).pressured,
          ),
        },
      };
    },
    runtimeEventHealthSnapshot() {
      const streamId = ensureRuntimeEventStream(db, now).stream_id;

      return runtimeEventHealthSnapshot(db, streamId, now(), log);
    },
    pruneAcknowledgedRuntimeEvents(olderThan, options) {
      const mode = options?.mode ?? "grace";

      return storage.write(() => {
        // Retained-pressure mode has no age cutoff: any confirmed-ACKed row is
        // eligible (ADR-183 D3), inside an open prompt's span too — the manager
        // reads a span's ACKed prefix from its own canonical events (ADR-184).
        const cutoff =
          mode === "retained_pressure"
            ? null
            : new Date(
                Math.min(
                  olderThan.getTime(),
                  now().getTime() - limits.eventAckGraceMs,
                ),
              ).toISOString();

        db.exec("BEGIN IMMEDIATE");
        try {
          const stream = ensureRuntimeEventStream(db, now);
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

          // The floor stays a contiguous prefix: the walk stops at the first
          // row it may not delete, and the floor is the last row it did.
          for (const row of candidates) {
            if (
              row.acknowledged_at === null ||
              (cutoff !== null && row.acknowledged_at >= cutoff) ||
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
    runtimeEventPruneState() {
      const stream = ensureRuntimeEventStream(db, now);
      const regular = outboxBudgetSnapshot(db).regular;
      const oldest = db
        .prepare(
          `SELECT created_at FROM runtime_event_outbox WHERE stream_id = ?
          ORDER BY sequence_sort_key ASC LIMIT 1`,
        )
        .get(stream.stream_id) as { created_at: string } | undefined;

      return {
        retainedCount: regular.retainedCount,
        retainedBytes: regular.retainedBytes,
        unacknowledgedCount: regular.unacknowledgedCount,
        acknowledgedThrough: stream.acknowledged_through,
        oldestRetainedCreatedAt: oldest?.created_at ?? null,
      };
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

function runtimeEventHealthSnapshot(
  db: DatabaseSync,
  streamId: string,
  observedAt: Date,
  log: Logger | undefined,
): RuntimeEventHealthSnapshot {
  getRuntimeEventStream(db, streamId);
  const row = db.prepare(RUNTIME_EVENT_HEALTH_SNAPSHOT_SQL).get() as
    | RuntimeEventHealthSnapshotDbRow
    | undefined;

  if (row === undefined || row.stream_id !== streamId) {
    throw new HostRuntimeEventError(
      "stream_corrupt",
      `runtime event health snapshot did not resolve current stream ${streamId}`,
    );
  }
  if (
    !Number.isSafeInteger(row.unacknowledged_count) ||
    row.unacknowledged_count < 0 ||
    !Number.isSafeInteger(row.retained_count) ||
    row.retained_count < 0 ||
    row.unacknowledged_count > row.retained_count ||
    ![0, 1].includes(row.pressured)
  ) {
    throw new HostRuntimeEventError(
      "stream_corrupt",
      `runtime event health counters are inconsistent for stream ${streamId}`,
    );
  }

  const nextSequence = parseHostEventSequence(row.next_sequence);
  const headSequence =
    nextSequence === 0n ? null : (nextSequence - 1n).toString();
  const oldestCreatedAt = row.oldest_unacknowledged_created_at;

  if (
    (row.unacknowledged_count === 0 && oldestCreatedAt !== null) ||
    (row.unacknowledged_count > 0 && oldestCreatedAt === null)
  ) {
    throw new HostRuntimeEventError(
      "stream_corrupt",
      `runtime event health age is inconsistent for stream ${streamId}`,
    );
  }

  let oldestUnacknowledgedAgeMs: number | null = null;

  if (oldestCreatedAt !== null) {
    const createdAtMs = Date.parse(oldestCreatedAt);
    const observedAtMs = observedAt.getTime();

    if (!Number.isFinite(createdAtMs) || !Number.isFinite(observedAtMs)) {
      throw new HostRuntimeEventError(
        "stream_corrupt",
        `runtime event health timestamp is invalid for stream ${streamId}`,
      );
    }
    const ageMs = observedAtMs - createdAtMs;

    if (ageMs < 0) {
      log?.warn(
        { streamId, observedAt: observedAt.toISOString(), oldestCreatedAt },
        "runtime-event-health-clock-regressed",
      );
    }
    oldestUnacknowledgedAgeMs = Math.max(0, ageMs);
  }

  return {
    streamId,
    headSequence,
    unacknowledgedCount: row.unacknowledged_count,
    retainedCount: row.retained_count,
    pressured: row.pressured === 1,
    oldestUnacknowledgedAgeMs,
    pressure: runtimeEventPressureEpisode(row, streamId),
  };
}

function runtimeEventPressureEpisode(
  row: RuntimeEventHealthSnapshotDbRow,
  streamId: string,
): RuntimeEventPressureEpisode | null {
  if (row.pressured !== 1) return null;
  if (
    row.since_ms === null ||
    row.unacknowledged_count_at_start === null ||
    row.unacknowledged_bytes_at_start === null ||
    !Number.isSafeInteger(row.since_ms)
  ) {
    throw new HostRuntimeEventError(
      "stream_corrupt",
      `runtime event pressure episode is incomplete for stream ${streamId}`,
    );
  }

  return {
    since: new Date(row.since_ms).toISOString(),
    unacknowledgedCountAtStart: row.unacknowledged_count_at_start,
    unacknowledgedBytesAtStart: row.unacknowledged_bytes_at_start,
    episodes: row.episodes,
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

const RECEIPT_COLUMNS =
  "command_id, run_id, kind, assignment_id, epoch, host_session_id, request_digest, request_schema, request_version, host_key, accepted_sequence, terminal_stream_id, terminal_sequence, event_id, phase, http_status, body_json, received_at, completed_at";

type CommandReceiptDbRow = {
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
};

function toCommandReceiptRow(row: CommandReceiptDbRow): CommandReceiptRow {
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
  throughSortKey: string | null = null,
): HostRuntimeEventRow[] {
  // Sort keys are fixed-width decimals, so "~" bounds every real key.
  const candidates = db
    .prepare(
      `SELECT sequence_sort_key, encoded_bytes FROM runtime_event_outbox
    WHERE stream_id = ? AND sequence_sort_key > ? AND sequence_sort_key <= ?
    ORDER BY sequence_sort_key ASC LIMIT ?`,
    )
    .all(
      streamId,
      afterSortKey ?? "",
      throughSortKey ?? "~",
      Math.min(limit, 500),
    ) as Array<{
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
    producerPath: row.producer_path == null ? null : String(row.producer_path),
    sealedDevice: row.sealed_device == null ? null : String(row.sealed_device),
    sealedInode: row.sealed_inode == null ? null : String(row.sealed_inode),
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

export type BoundedPrunerPass = Readonly<{
  mode: RuntimeEventPruneMode;
  pruned: number;
  pages: number;
}>;

export type BoundedPruner = {
  kick(mode: RuntimeEventPruneMode): void;
  stop(): void;
};

// Each page is one bounded database write; the next page yields to producers
// and ACKs with `setImmediate`. At most one pass is in flight: a kick during a
// pass is remembered once (`retained_pressure` wins over `grace`) and starts
// the next pass when this one ends. A pass ends when a page prunes nothing or
// `continuePass` says the mode's target is met.
export function startBoundedPruner(input: {
  prunePage: (mode: RuntimeEventPruneMode) => number;
  continuePass: (mode: RuntimeEventPruneMode) => boolean;
  onPassEnd?: (pass: BoundedPrunerPass) => void;
  available: () => boolean;
  reportFailure: (error: unknown) => void;
  logger: Logger;
  message: string;
  intervalMs: number;
}): BoundedPruner {
  let immediate: NodeJS.Immediate | undefined;
  let stopped = false;
  let inPage = false;
  let active: {
    mode: RuntimeEventPruneMode;
    pruned: number;
    pages: number;
  } | null = null;
  let pending: RuntimeEventPruneMode | null = null;

  const endPass = (): void => {
    const pass = active;

    active = null;
    if (pass) input.onPassEnd?.(pass);
    if (pending && !stopped) {
      const next = pending;

      pending = null;
      begin(next);
    }
  };
  const runPage = (): void => {
    immediate = undefined;
    const pass = active;

    if (stopped || !pass) return;
    if (!input.available()) {
      active = null;
      pending = null;

      return;
    }
    let pruned = 0;

    if (input.continuePass(pass.mode)) {
      inPage = true;
      try {
        pruned = input.prunePage(pass.mode);
      } catch (error) {
        active = null;
        pending = null;
        input.reportFailure(error);
        input.logger.error(
          {
            mode: pass.mode,
            reason:
              error instanceof HostRuntimeEventError
                ? error.reason
                : "runtime_storage_failure",
          },
          "runtime-pruner-failed",
        );
        if (input.available()) throw error;

        return;
      } finally {
        inPage = false;
      }
    }
    if (pruned > 0) {
      pass.pruned += pruned;
      pass.pages += 1;
      input.logger.info({ pruned, mode: pass.mode }, input.message);
      if (!stopped) immediate = setImmediate(runPage);

      return;
    }
    endPass();
  };
  const begin = (mode: RuntimeEventPruneMode): void => {
    active = { mode, pruned: 0, pages: 0 };
    immediate = setImmediate(runPage);
  };
  const kick = (mode: RuntimeEventPruneMode): void => {
    // A page's own commit notifies capacity; it never re-kicks its pass.
    if (stopped || inPage) return;
    if (active) {
      if (pending !== "retained_pressure") pending = mode;

      return;
    }
    begin(mode);
  };

  // Boot keeps its synchronous first grace page.
  active = { mode: "grace", pruned: 0, pages: 0 };
  runPage();
  const handle = setInterval(() => kick("grace"), input.intervalMs);

  handle.unref();

  return {
    kick,
    stop() {
      stopped = true;
      clearInterval(handle);
      if (immediate) clearImmediate(immediate);
      active = null;
      pending = null;
    },
  };
}

export function startRuntimeEventPruner(
  state: HostState,
  logger: Logger,
  now: () => Date = () => new Date(),
): () => void {
  const { limits } = state;
  const belowLow = (): boolean => {
    const current = state.runtimeEventPruneState();

    return (
      current.retainedCount < limits.eventLowRows &&
      current.retainedBytes < limits.eventLowBytes
    );
  };
  // In memory: one retained-pressure episode runs from the first sighting of
  // retained rows at soft until a pass leaves them below low (ADR-183 D3).
  let episode: {
    startedAtMs: number;
    retainedBefore: number;
    pruned: number;
    pages: number;
    // The ACK watermark at which a pass last stopped short of low; only a
    // newer ACK can make more rows prunable, so kicks wait for one.
    stalledAt: string | null | undefined;
    stallLogged: boolean;
  } | null = null;
  const pruner = startBoundedPruner({
    prunePage: (mode) =>
      state.pruneAcknowledgedRuntimeEvents(
        new Date(now().getTime() - limits.eventAckGraceMs),
        { mode },
      ),
    continuePass: (mode) => mode === "grace" || !belowLow(),
    onPassEnd: (pass) => {
      if (pass.mode !== "retained_pressure" || !episode) return;
      const current = state.runtimeEventPruneState();

      episode.pruned += pass.pruned;
      episode.pages += pass.pages;
      if (
        current.retainedCount < limits.eventLowRows &&
        current.retainedBytes < limits.eventLowBytes
      ) {
        logger.warn(
          {
            pruned: episode.pruned,
            retainedBefore: episode.retainedBefore,
            retainedAfter: current.retainedCount,
            oldestAgeMs:
              current.oldestRetainedCreatedAt === null
                ? null
                : Math.max(
                    0,
                    now().getTime() -
                      Date.parse(current.oldestRetainedCreatedAt),
                  ),
            pages: episode.pages,
            durationMs: Math.max(0, now().getTime() - episode.startedAtMs),
          },
          "outbox-retained-pressure-prune",
        );
        episode = null;

        return;
      }
      episode.stalledAt = current.acknowledgedThrough;
      if (pass.pruned === 0 && !episode.stallLogged) {
        episode.stallLogged = true;
        logger.warn(
          {
            retainedCount: current.retainedCount,
            unacknowledgedCount: current.unacknowledgedCount,
            acknowledgedThrough: current.acknowledgedThrough,
          },
          "outbox-retained-pressure-prune-stalled",
        );
      }
    },
    available: state.runtimeStorageAvailable,
    reportFailure: state.reportRuntimeStorageFailure,
    logger,
    message: "runtime-event-outbox-pruned",
    intervalMs: RUNTIME_EVENT_PRUNE_INTERVAL_MS,
  });
  const kickOnRetained = (snapshot: OutboxBudgetSnapshot): void => {
    if (
      !retainedAtThreshold(
        snapshot.regular,
        limits.eventSoftBytes,
        limits.eventSoftRows,
      )
    )
      return;
    if (!episode) {
      episode = {
        startedAtMs: now().getTime(),
        retainedBefore: snapshot.regular.retainedCount,
        pruned: 0,
        pages: 0,
        stalledAt: undefined,
        stallLogged: false,
      };
    } else if (
      episode.stalledAt !== undefined &&
      state.runtimeEventPruneState().acknowledgedThrough === episode.stalledAt
    ) {
      return;
    }
    pruner.kick("retained_pressure");
  };
  const unsubscribe = state.subscribeRuntimeCapacity(kickOnRetained);

  kickOnRetained(state.runtimeEventOutboxStats().budget);

  return () => {
    unsubscribe();
    pruner.stop();
  };
}
