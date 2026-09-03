import type { Logger } from "pino";

import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// ADR-166 D1/D3/D6/D7: the supervisor-private execution-host state store. One
// node:sqlite file holds the durable half of the host contract — its identity,
// the per-run fence high-water, adopted-workspace handles, and command
// receipts. The web tier never reads it.

export const HOST_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
export const HOST_STATE_FILE = "state.sqlite";
export const RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const RECEIPT_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;
export const EXECUTION_HOST_PROTOCOL_VERSION = 1;

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
  epoch: number;
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

export type HostState = {
  readonly hostKey: string;
  readonly bootId: string;
  readonly stateDir: string | null;
  getFence(runId: string): RunFence | null;
  setFence(runId: string, assignmentId: string, epoch: number): void;
  getReceipt(commandId: string): CommandReceiptRow | null;
  putReceipt(row: CommandReceiptRow): void;
  pruneReceipts(olderThan: Date): number;
  findWorkspaceByRealPath(runId: string, realPath: string): WorkspaceRow | null;
  getWorkspace(id: string): WorkspaceRow | null;
  insertWorkspace(row: WorkspaceRow): void;
  releaseWorkspace(id: string, releasedAt: string): boolean;
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
CREATE TABLE IF NOT EXISTS workspaces (
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
  released_at TEXT,
  UNIQUE (run_id, real_path)
);
CREATE TABLE IF NOT EXISTS command_receipts (
  command_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  phase TEXT NOT NULL,
  http_status INTEGER NOT NULL,
  body_json TEXT NOT NULL,
  received_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS command_receipts_received_idx ON command_receipts (received_at);
`;

export function openHostState(opts: OpenHostStateOptions = {}): HostState {
  const now = opts.now ?? (() => new Date());
  const log = opts.logger?.child({ component: "host-state" });
  const stateDir = opts.inMemory ? null : path.resolve(opts.stateDir ?? "");

  if (!opts.inMemory && !opts.stateDir) {
    throw new Error("openHostState requires stateDir unless inMemory is set");
  }

  let db: DatabaseSync;

  try {
    if (stateDir) {
      mkdirSync(stateDir, { recursive: true });
      accessSync(stateDir, fsConstants.W_OK);
    }
    db = new DatabaseSync(
      stateDir ? path.join(stateDir, HOST_STATE_FILE) : ":memory:",
    );
    if (stateDir) {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
    }
    db.exec(SCHEMA);
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

  const bootId = randomUUID();

  const state: HostState = {
    hostKey,
    bootId,
    stateDir,
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
          `SELECT command_id, run_id, kind, epoch, phase, http_status, body_json, received_at, completed_at
           FROM command_receipts WHERE command_id = ?`,
        )
        .get(commandId) as
        | {
            command_id: string;
            run_id: string;
            kind: string;
            epoch: number;
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
        epoch: Number(row.epoch),
        phase: row.phase,
        httpStatus: Number(row.http_status),
        body: JSON.parse(row.body_json) as unknown,
        receivedAt: row.received_at,
        completedAt: row.completed_at,
      };
    },
    putReceipt(row) {
      db.prepare(
        `INSERT INTO command_receipts
           (command_id, run_id, kind, epoch, phase, http_status, body_json, received_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (command_id) DO UPDATE SET
           phase = excluded.phase,
           http_status = excluded.http_status,
           body_json = excluded.body_json,
           completed_at = excluded.completed_at`,
      ).run(
        row.commandId,
        row.runId,
        row.kind,
        row.epoch,
        row.phase,
        row.httpStatus,
        JSON.stringify(row.body ?? {}),
        row.receivedAt,
        row.completedAt,
      );
    },
    pruneReceipts(olderThan) {
      const result = db
        .prepare("DELETE FROM command_receipts WHERE received_at < ?")
        .run(olderThan.toISOString());

      return Number(result.changes);
    },
    findWorkspaceByRealPath(runId, realPath) {
      const row = db
        .prepare("SELECT * FROM workspaces WHERE run_id = ? AND real_path = ?")
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
