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

import {
  buildRuntimeEventEnvelope,
  RuntimeEventEnvelopeSchema,
  type RuntimeEventDraft,
} from "./runtime-events";

// ADR-166 D1/D3/D6/D7: the supervisor-private execution-host state store. One
// node:sqlite file holds the durable half of the host contract — its identity,
// the per-run fence high-water, adopted-workspace handles, and command
// receipts. The web tier never reads it.

export const HOST_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
export const HOST_STATE_FILE = "state.sqlite";
export const RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const RECEIPT_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;
export const EXECUTION_HOST_PROTOCOL_VERSION = 1;
// `PRAGMA user_version` of the state file; bumped with every migration below.
export const HOST_STATE_SCHEMA_VERSION = 6;
const MAX_HOST_EVENT_SEQUENCE = (1n << 63n) - 1n;
const HOST_EVENT_SEQUENCE_SORT_WIDTH = 20;
export const MAX_RUNTIME_EVENT_OUTBOX_BYTES = 64 * 1024 * 1024;
export const SOFT_RUNTIME_EVENT_OUTBOX_BYTES = 48 * 1024 * 1024;
export const HARD_RUNTIME_EVENT_OUTBOX_BYTES = 56 * 1024 * 1024;
export const TERMINAL_RUNTIME_EVENT_RESERVE_BYTES =
  MAX_RUNTIME_EVENT_OUTBOX_BYTES - HARD_RUNTIME_EVENT_OUTBOX_BYTES;
export const RUNTIME_EVENT_ACK_PRUNE_GRACE_MS = 24 * 60 * 60 * 1_000;
export const RUNTIME_EVENT_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;

export class HostRuntimeEventError extends Error {
  readonly reason:
    | "event_outbox_soft_limit"
    | "event_outbox_hard_limit"
    | "event_outbox_terminal_reserve_exhausted"
    | "stream_identity_conflict"
    | "replay_floor_exceeded"
    | "ack_not_contiguous"
    | "ack_beyond_emitted"
    | "stream_corrupt";

  constructor(
    reason: HostRuntimeEventError["reason"],
    message: string,
  ) {
    super(message);
    this.name = "HostRuntimeEventError";
    this.reason = reason;
  }
}

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
  state: "pending" | "available" | "deleting" | "missing" | "deleted" | "expired" | "corrupt";
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
};

export type RuntimeEventOutboxStats = {
  streamId: string;
  acknowledgedThrough: string | null;
  replayFloor: string | null;
  unacknowledgedCount: number;
  unacknowledgedBytes: number;
  retainedCount: number;
  retainedBytes: number;
};

export type HostState = {
  readonly hostKey: string;
  readonly bootId: string;
  // Realpath of the state dir (null in memory): path checks against it must
  // compare realpaths, or a symlinked dir (macOS /tmp) slips past them.
  readonly stateDirReal: string | null;
  getFence(runId: string): RunFence | null;
  setFence(runId: string, assignmentId: string, epoch: number): void;
  getReceipt(commandId: string): CommandReceiptRow | null;
  putReceipt(row: CommandReceiptRow): void;
  // A fresh supervisor process has no ACP process to join. Canonical async
  // prompt receipts retain their fence/session binding, so startup can make
  // the loss explicit through one durable terminal receipt/event pair.
  recoverAcceptedPromptReceipts(): number;
  pruneReceipts(olderThan: Date): number;
  findWorkspaceByRealPath(runId: string, realPath: string): WorkspaceRow | null;
  getWorkspace(id: string): WorkspaceRow | null;
  insertWorkspace(row: WorkspaceRow): void;
  releaseWorkspace(id: string, releasedAt: string): boolean;
  getRuntimeObject(id: string): HostRuntimeObjectRow | null;
  insertRuntimeObject(row: HostRuntimeObjectRow): void;
  updateRuntimeObject(
    id: string,
    patch: Pick<HostRuntimeObjectRow, "state" | "sizeBytes" | "sha256" | "sealedAt" | "deletedAt" | "lastError">,
  ): HostRuntimeObjectRow;
  appendRuntimeEvent(input: AppendRuntimeEventInput): HostRuntimeEventRow;
  putReceiptWithRuntimeEvent(
    receipt: CommandReceiptRow,
    event: AppendRuntimeEventInput,
  ): HostRuntimeEventRow;
  getRuntimeEventStreamId(): string;
  runtimeEventsAfter(
    streamId: string,
    afterSequence: string | null,
    limit?: number,
  ): HostRuntimeEventRow[];
  pendingRuntimeEvents(streamId: string, limit?: number): HostRuntimeEventRow[];
  ackRuntimeEvents(streamId: string, throughSequence: string): string;
  runtimeEventOutboxStats(): RuntimeEventOutboxStats;
  assertCanAcceptMutatingCommand(): void;
  pruneAcknowledgedRuntimeEvents(olderThan: Date): number;
  subscribeRuntimeEvents(listener: (event: HostRuntimeEventRow) => void): () => void;
  close(): void;
};

export type OpenHostStateOptions = {
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
  event_id TEXT,
  phase TEXT NOT NULL,
  http_status INTEGER NOT NULL,
  body_json TEXT NOT NULL,
  received_at TEXT NOT NULL,
  completed_at TEXT
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

  if (Number(user_version) < 1) db.exec(MIGRATE_V0_TO_V1);
  if (Number(user_version) < 2) db.exec(MIGRATE_V1_TO_V2);
  if (Number(user_version) < 3) db.exec(MIGRATE_V2_TO_V3);
  if (Number(user_version) < 4) db.exec(MIGRATE_V3_TO_V4);
  if (Number(user_version) < 5) db.exec(MIGRATE_V4_TO_V5);
  if (Number(user_version) < 6) db.exec(MIGRATE_V5_TO_V6);
  db.exec(SCHEMA);
}

export function openHostState(opts: OpenHostStateOptions = {}): HostState {
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

  const bootId = randomUUID();
  const runtimeEventListeners = new Set<
    (event: HostRuntimeEventRow) => void
  >();

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

  const state: HostState = {
    hostKey,
    bootId,
    stateDirReal,
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
      db.prepare(
        `INSERT INTO run_fences (run_id, assignment_id, epoch, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (run_id) DO UPDATE SET
           assignment_id = excluded.assignment_id,
           epoch = excluded.epoch,
           updated_at = excluded.updated_at`,
      ).run(runId, assignmentId, epoch, now().toISOString());
    },
    getReceipt(commandId) {
      const row = db
        .prepare(
          `SELECT command_id, run_id, kind, assignment_id, epoch, host_session_id, request_digest, event_id, phase, http_status, body_json, received_at, completed_at
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
        eventId: row.event_id,
        phase: row.phase,
        httpStatus: Number(row.http_status),
        body: JSON.parse(row.body_json) as unknown,
        receivedAt: row.received_at,
        completedAt: row.completed_at,
      };
    },
    putReceipt(row) {
      writeReceiptRow(db, row);
    },
    recoverAcceptedPromptReceipts() {
      const rows = db
        .prepare(
          `SELECT command_id, run_id, kind, assignment_id, epoch, host_session_id, request_digest, event_id, phase, http_status, body_json, received_at, completed_at
           FROM command_receipts
           WHERE kind = 'session.prompt'
             AND phase = 'accepted'
             AND assignment_id IS NOT NULL
             AND host_session_id IS NOT NULL
           ORDER BY received_at ASC, command_id ASC`,
        )
        .all() as Array<{
        command_id: string;
        run_id: string;
        kind: string;
        assignment_id: string;
        epoch: number;
        host_session_id: string;
        request_digest: string | null;
        event_id: string | null;
        phase: ReceiptPhase;
        http_status: number;
        body_json: string;
        received_at: string;
        completed_at: string | null;
      }>;
      if (rows.length === 0) return 0;

      const recovered: HostRuntimeEventRow[] = [];
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const row of rows) {
          const body = {
            code: "PRECONDITION",
            message: "the turn for this command id was lost in a host restart",
            details: { reason: "turn_lost", runId: row.run_id },
          };
          const event = appendRuntimeEventInTransaction(db, {
            hostKey,
            bootId,
            now,
            input: {
              terminal: true,
              draft: {
                runId: row.run_id,
                assignmentId: row.assignment_id,
                assignmentEpoch: Number(row.epoch),
                hostSessionId: row.host_session_id,
                eventType: "session.command",
                occurredAt: now().toISOString(),
                payload: {
                  commandId: row.command_id,
                  kind: "session.prompt",
                  phase: "completed",
                  status: "failed",
                  error: body,
                },
              },
            },
          });
          writeReceiptRow(db, {
            commandId: row.command_id,
            runId: row.run_id,
            kind: row.kind,
            assignmentId: row.assignment_id,
            epoch: Number(row.epoch),
            hostSessionId: row.host_session_id,
            requestDigest: row.request_digest,
            eventId: event.eventId,
            phase: "rejected",
            httpStatus: 409,
            body,
            receivedAt: row.received_at,
            completedAt: now().toISOString(),
          });
          recovered.push(event);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      recovered.forEach(notifyRuntimeEventListeners);
      return recovered.length;
    },
    pruneReceipts(olderThan) {
      const result = db
        .prepare("DELETE FROM command_receipts WHERE received_at < ?")
        .run(olderThan.toISOString());

      return Number(result.changes);
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
    },
    releaseWorkspace(id, releasedAt) {
      const result = db
        .prepare(
          "UPDATE workspaces SET released_at = ? WHERE id = ? AND released_at IS NULL",
        )
        .run(releasedAt, id);

      return Number(result.changes) > 0;
    },
    getRuntimeObject(id) {
      const row = db.prepare("SELECT * FROM runtime_objects WHERE id = ?").get(id);

      return row ? toHostRuntimeObjectRow(row) : null;
    },
    insertRuntimeObject(row) {
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
    },
    updateRuntimeObject(id, patch) {
      const existing = db.prepare("SELECT * FROM runtime_objects WHERE id = ?").get(id);
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
      const updated = db.prepare("SELECT * FROM runtime_objects WHERE id = ?").get(id);
      if (!updated) throw new Error(`runtime object ${id} vanished during update`);
      return toHostRuntimeObjectRow(updated);
    },
    appendRuntimeEvent(input) {
      db.exec("BEGIN IMMEDIATE");

      try {
        const event = appendRuntimeEventInTransaction(db, {
          hostKey,
          bootId,
          now,
          input,
        });

        db.exec("COMMIT");
        notifyRuntimeEventListeners(event);
        return event;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    putReceiptWithRuntimeEvent(receipt, eventInput) {
      db.exec("BEGIN IMMEDIATE");

      try {
        const event = appendRuntimeEventInTransaction(db, {
          hostKey,
          bootId,
          now,
          input: eventInput,
        });
        writeReceiptRow(db, { ...receipt, eventId: event.eventId });

        db.exec("COMMIT");
        notifyRuntimeEventListeners(event);
        return event;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
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

      const rows = db
        .prepare(
          `SELECT stream_id, sequence, event_id, envelope_json, encoded_bytes, occurred_at,
                  acknowledged_at, created_at
           FROM runtime_event_outbox
           WHERE stream_id = ? AND (? IS NULL OR sequence_sort_key > ?)
           ORDER BY sequence_sort_key ASC
           LIMIT ?`,
        )
        .all(streamId, afterSortKey, afterSortKey, validateRuntimeEventLimit(limit)) as RuntimeEventOutboxDbRow[];

      return rows.map(toHostRuntimeEventRow);
    },
    pendingRuntimeEvents(streamId, limit = 500) {
      getRuntimeEventStream(db, streamId);
      const rows = db
        .prepare(
          `SELECT stream_id, sequence, event_id, envelope_json, encoded_bytes, occurred_at,
                  acknowledged_at, created_at
           FROM runtime_event_outbox
           WHERE stream_id = ? AND acknowledged_at IS NULL
           ORDER BY sequence_sort_key ASC
           LIMIT ?`,
        )
        .all(streamId, validateRuntimeEventLimit(limit)) as RuntimeEventOutboxDbRow[];

      return rows.map(toHostRuntimeEventRow);
    },
    ackRuntimeEvents(streamId, throughSequence) {
      const through = parseHostEventSequence(throughSequence);
      const nowIso = now().toISOString();

      db.exec("BEGIN IMMEDIATE");

      try {
        const stream = getRuntimeEventStream(db, streamId);

        const next = parseHostEventSequence(stream.next_sequence);
        const acknowledged = stream.acknowledged_through
          ? parseHostEventSequence(stream.acknowledged_through)
          : -1n;

        if (through < acknowledged) {
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
          .all(
            streamId,
            hostEventSequenceSortKey(acknowledged),
            hostEventSequenceSortKey(through),
          ) as Array<{ sequence: string }>;

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
        db.prepare(
          `UPDATE runtime_event_outbox
           SET acknowledged_at = ?
           WHERE stream_id = ? AND sequence_sort_key <= ? AND acknowledged_at IS NULL`,
        ).run(nowIso, streamId, throughSortKey);
        db.exec("COMMIT");
        return throughText;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    runtimeEventOutboxStats() {
      return runtimeEventOutboxStats(db, ensureRuntimeEventStream(db, now).stream_id);
    },
    assertCanAcceptMutatingCommand() {
      const stats = runtimeEventOutboxStats(
        db,
        ensureRuntimeEventStream(db, now).stream_id,
      );

      if (stats.unacknowledgedBytes >= SOFT_RUNTIME_EVENT_OUTBOX_BYTES) {
        throw new HostRuntimeEventError(
          "event_outbox_soft_limit",
          "runtime event outbox is above the command admission soft limit",
        );
      }
    },
    pruneAcknowledgedRuntimeEvents(olderThan) {
      db.exec("BEGIN IMMEDIATE");

      try {
        const stream = ensureRuntimeEventStream(db, now);
        const rows = db
          .prepare(
            `SELECT sequence, sequence_sort_key FROM runtime_event_outbox
             WHERE stream_id = ? AND acknowledged_at IS NOT NULL AND acknowledged_at < ?
             ORDER BY sequence_sort_key ASC`,
          )
          .all(stream.stream_id, olderThan.toISOString()) as Array<{
          sequence: string;
          sequence_sort_key: string;
        }>;

        if (rows.length === 0) {
          db.exec("COMMIT");
          return 0;
        }

        const last = rows.at(-1);
        if (!last) throw new Error("acknowledged runtime-event rows disappeared");
        db.prepare(
          `UPDATE runtime_event_streams
           SET replay_floor_sequence = ?, replay_floor_sort_key = ?, updated_at = ?
           WHERE stream_id = ?`,
        ).run(last.sequence, last.sequence_sort_key, now().toISOString(), stream.stream_id);
        const result = db
          .prepare(
            `DELETE FROM runtime_event_outbox
             WHERE stream_id = ? AND acknowledged_at IS NOT NULL AND acknowledged_at < ?`,
          )
          .run(stream.stream_id, olderThan.toISOString());
        db.exec("COMMIT");
        return Number(result.changes);
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    subscribeRuntimeEvents(listener) {
      runtimeEventListeners.add(listener);
      return () => runtimeEventListeners.delete(listener);
    },
    close() {
      db.close();
    },
  };

  const pruned = state.pruneReceipts(
    new Date(now().getTime() - RECEIPT_TTL_MS),
  );

  log?.info(
    {
      hostKey,
      bootId,
      stateDir: stateDir ?? ":memory:",
      pinned: Boolean(pinned),
      prunedReceipts: pruned,
    },
    "execution-host-identity",
  );

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
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS retained_count,
         COALESCE(SUM(encoded_bytes), 0) AS retained_bytes,
         COALESCE(SUM(CASE WHEN acknowledged_at IS NULL THEN 1 ELSE 0 END), 0) AS unacknowledged_count,
         COALESCE(SUM(CASE WHEN acknowledged_at IS NULL THEN encoded_bytes ELSE 0 END), 0) AS unacknowledged_bytes
       FROM runtime_event_outbox WHERE stream_id = ?`,
    )
    .get(streamId) as {
    retained_count: number;
    retained_bytes: number;
    unacknowledged_count: number;
    unacknowledged_bytes: number;
  };

  return {
    streamId,
    acknowledgedThrough: stream.acknowledged_through,
    replayFloor: stream.replay_floor_sequence,
    unacknowledgedCount: Number(row.unacknowledged_count),
    unacknowledgedBytes: Number(row.unacknowledged_bytes),
    retainedCount: Number(row.retained_count),
    retainedBytes: Number(row.retained_bytes),
  };
}

function appendRuntimeEventInTransaction(
  db: DatabaseSync,
  args: {
    hostKey: string;
    bootId: string;
    now: () => Date;
    input: AppendRuntimeEventInput;
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
  const stats = runtimeEventOutboxStats(db, stream.stream_id);
  const projectedBytes = stats.retainedBytes + encodedBytes;

  if (args.input.terminal) {
    if (projectedBytes > MAX_RUNTIME_EVENT_OUTBOX_BYTES) {
      throw new HostRuntimeEventError(
        "event_outbox_terminal_reserve_exhausted",
        "runtime event terminal reserve is exhausted",
      );
    }
  } else if (projectedBytes > HARD_RUNTIME_EVENT_OUTBOX_BYTES) {
    throw new HostRuntimeEventError(
      "event_outbox_hard_limit",
      "runtime event outbox regular partition is full",
    );
  }

  const createdAt = args.now().toISOString();
  db.prepare(
    `INSERT INTO runtime_event_outbox
       (stream_id, sequence, sequence_sort_key, event_id, envelope_json, encoded_bytes,
        occurred_at, acknowledged_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    stream.stream_id,
    sequenceText,
    hostEventSequenceSortKey(sequence),
    envelope.eventId,
    envelopeJson,
    encodedBytes,
    envelope.occurredAt,
    createdAt,
  );
  db.prepare(
    "UPDATE runtime_event_streams SET next_sequence = ?, updated_at = ? WHERE stream_id = ?",
  ).run((sequence + 1n).toString(), createdAt, stream.stream_id);

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
  db.prepare(
    `INSERT INTO command_receipts
       (command_id, run_id, kind, assignment_id, epoch, host_session_id, request_digest, event_id, phase, http_status, body_json, received_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (command_id) DO UPDATE SET
       assignment_id = COALESCE(command_receipts.assignment_id, excluded.assignment_id),
       host_session_id = COALESCE(command_receipts.host_session_id, excluded.host_session_id),
       request_digest = COALESCE(command_receipts.request_digest, excluded.request_digest),
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
    row.eventId,
    row.phase,
    row.httpStatus,
    JSON.stringify(row.body ?? {}),
    row.receivedAt,
    row.completedAt,
  );
}

function auditRuntimeEventState(db: DatabaseSync): void {
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

  const rows = db
    .prepare(
      `SELECT stream_id, sequence, event_id, envelope_json, encoded_bytes, occurred_at,
              acknowledged_at, created_at
       FROM runtime_event_outbox WHERE stream_id = ? ORDER BY sequence_sort_key ASC`,
    )
    .all(stream.stream_id) as RuntimeEventOutboxDbRow[];
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
    if ((sequence <= acknowledged) !== (row.acknowledged_at !== null)) {
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
    throw new Error(`runtime event sequence must be a canonical decimal integer: ${value}`);
  }

  const sequence = BigInt(value);
  if (sequence > MAX_HOST_EVENT_SEQUENCE) {
    throw new Error(`runtime event sequence exceeds the host counter limit: ${value}`);
  }

  return sequence;
}

function hostEventSequenceSortKey(sequence: bigint): string {
  // The only internal negative value is the pre-first-event acknowledgement
  // sentinel. '-' sorts before the decimal digits under SQLite BINARY collation.
  if (sequence === -1n) return "-".padEnd(HOST_EVENT_SEQUENCE_SORT_WIDTH, "0");
  if (sequence < 0n || sequence > MAX_HOST_EVENT_SEQUENCE) {
    throw new Error(`runtime event sequence cannot be sorted: ${sequence.toString()}`);
  }

  return sequence.toString().padStart(HOST_EVENT_SEQUENCE_SORT_WIDTH, "0");
}

function validateRuntimeEventLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50_000) {
    throw new Error("runtime event replay limit must be an integer between 1 and 50000");
  }

  return limit;
}

function toHostRuntimeEventRow(row: RuntimeEventOutboxDbRow): HostRuntimeEventRow {
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
    sha256: row.sha256 === null || row.sha256 === undefined ? null : String(row.sha256),
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

// Receipts prune at boot (inside openHostState) and hourly thereafter.
export function startReceiptPruner(
  state: HostState,
  logger: Logger,
  now: () => Date = () => new Date(),
): () => void {
  const handle = setInterval(() => {
    const pruned = state.pruneReceipts(
      new Date(now().getTime() - RECEIPT_TTL_MS),
    );

    if (pruned > 0) logger.info({ pruned }, "command-receipts-pruned");
  }, RECEIPT_PRUNE_INTERVAL_MS);

  handle.unref();

  return () => clearInterval(handle);
}

export function startRuntimeEventPruner(
  state: HostState,
  logger: Logger,
  now: () => Date = () => new Date(),
): () => void {
  const prune = (): void => {
    const pruned = state.pruneAcknowledgedRuntimeEvents(
      new Date(now().getTime() - RUNTIME_EVENT_ACK_PRUNE_GRACE_MS),
    );

    if (pruned > 0) {
      logger.info({ pruned }, "runtime-event-outbox-pruned");
    }
  };

  prune();
  const handle = setInterval(prune, RUNTIME_EVENT_PRUNE_INTERVAL_MS);
  handle.unref();

  return () => clearInterval(handle);
}
