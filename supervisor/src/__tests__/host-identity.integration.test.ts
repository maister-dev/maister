// ADR-166 T2.1 — host identity + state store (H1–H9).
import { mkdtemp, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  HostKeyConflictError,
  HostStateUnwritableError,
  HOST_KEY_PATTERN,
  HOST_STATE_FILE,
  HOST_STATE_SCHEMA_VERSION,
  openHostState,
} from "../host-state";
import { bootExecutionHost } from "../main";
import { DEFAULT_RUNTIME_LIMITS } from "../runtime-limits";

import {
  bootHost,
  cleanupRuntimeRoot,
  silentLogger,
  type BootedHost,
} from "./_fixtures/boot-host";

const booted: BootedHost[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const host of booted.splice(0)) await host.stop();
  for (const root of roots.splice(0)) await cleanupRuntimeRoot(root);
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eh-identity-"));

  roots.push(root);

  return root;
}

describe("execution-host identity", () => {
  it("applies, removes and reapplies explicit resource settings on the actual boot path", async () => {
    const root = await tempRoot();
    const env = { MAISTER_EVENT_OUTBOX_SOFT_ROWS: "70000" };

    for (const config of [env, {}, env]) {
      const state = bootExecutionHost({
        runtimeRoot: root,
        logger: silentLogger,
        env: config,
      });

      try {
        expect(state.limits.eventSoftRows).toBe(
          "MAISTER_EVENT_OUTBOX_SOFT_ROWS" in config
            ? 70000
            : DEFAULT_RUNTIME_LIMITS.eventSoftRows,
        );
      } finally {
        state.close();
      }
    }
    expect(() =>
      bootExecutionHost({
        runtimeRoot: root,
        logger: silentLogger,
        env: { MAISTER_EVENT_OUTBOX_SOFT_ROWS: "garbage" },
      }),
    ).toThrow(/MAISTER_EVENT_OUTBOX_SOFT_ROWS/);
  });

  it("H1: a fresh state dir mints a key matching the pattern and /health reports it with a bootId", async () => {
    const host = await bootHost({ runtimeRoot: await tempRoot() });

    booted.push(host);
    const res = await fetch(`${host.url}/health`);
    const body = (await res.json()) as {
      host: { hostKey: string; bootId: string; protocolVersion: number };
    };

    expect(res.status).toBe(200);
    expect(body.host.hostKey).toMatch(HOST_KEY_PATTERN);
    expect(body.host.hostKey.startsWith("eh_")).toBe(true);
    expect(body.host.hostKey).toBe(host.hostState.hostKey);
    expect(body.host.bootId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.host.protocolVersion).toBe(1);
  });

  it("H2: reopening the same state dir keeps the key and mints a new bootId", async () => {
    const root = await tempRoot();
    const stateDir = join(root, "state");
    const first = openHostState({ stateDir });
    const firstKey = first.hostKey;
    const firstBoot = first.bootId;

    first.close();
    const second = openHostState({ stateDir });

    expect(second.hostKey).toBe(firstKey);
    expect(second.bootId).not.toBe(firstBoot);
    second.close();
  });

  it("H3: a pin on a fresh dir becomes the stored key", async () => {
    const root = await tempRoot();
    const state = openHostState({
      stateDir: join(root, "s"),
      pinnedKey: "eh_pinned_key_001",
    });

    expect(state.hostKey).toBe("eh_pinned_key_001");
    state.close();

    const reopened = openHostState({ stateDir: join(root, "s") });

    expect(reopened.hostKey).toBe("eh_pinned_key_001");
    reopened.close();
  });

  it("H4: a pin equal to the stored key boots", async () => {
    const root = await tempRoot();
    const state = openHostState({ stateDir: join(root, "s") });
    const key = state.hostKey;

    state.close();
    const reopened = openHostState({
      stateDir: join(root, "s"),
      pinnedKey: key,
    });

    expect(reopened.hostKey).toBe(key);
    reopened.close();
  });

  it("H5: a pin that conflicts with the stored key refuses to open, naming both prefixes", async () => {
    const root = await tempRoot();
    const state = openHostState({ stateDir: join(root, "s") });
    const stored = state.hostKey;

    state.close();

    let caught: unknown;

    try {
      openHostState({
        stateDir: join(root, "s"),
        pinnedKey: "eh_other_key_0002",
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(HostKeyConflictError);
    const conflict = caught as HostKeyConflictError;

    expect(conflict.storedKeyPrefix).toBe(stored.slice(0, 8));
    expect(conflict.pinnedKeyPrefix).toBe("eh_other");
    expect(conflict.message).not.toContain(stored.slice(8));

    // The stored identity is untouched by the refused boot.
    const reopened = openHostState({ stateDir: join(root, "s") });

    expect(reopened.hostKey).toBe(stored);
    reopened.close();
  });

  it("H6: an unwritable state dir throws HostStateUnwritableError", async () => {
    if (process.getuid?.() === 0) return; // root ignores mode bits

    const root = await tempRoot();
    const locked = join(root, "locked");

    await mkdir(locked);
    await chmod(locked, 0o500);

    try {
      expect(() =>
        openHostState({ stateDir: join(locked, "execution-host") }),
      ).toThrow(HostStateUnwritableError);
    } finally {
      await chmod(locked, 0o700);
    }
  });

  it("H7: /health carries no filesystem path and no state-dir string", async () => {
    const root = await tempRoot();
    const host = await bootHost({ runtimeRoot: root });

    booted.push(host);
    const text = await (await fetch(`${host.url}/health`)).text();

    expect(text).not.toContain(root);
    expect(text).not.toContain(host.stateDir);
    expect(text).not.toContain("/");
  });

  it("H8: a user_version 0 store (inline UNIQUE on workspaces) is rebuilt under the partial unique index, keeping every row", async () => {
    const root = await tempRoot();
    const stateDir = join(root, "s");
    const released = `ws_${"a".repeat(32)}`;
    const active = `ws_${"b".repeat(32)}`;
    const fresh = `ws_${"c".repeat(32)}`;
    const row = (id: string, runId: string, releasedAt: string | null) => ({
      id,
      runId,
      projectSlug: "demo",
      kind: "directory",
      path: `/srv/ws/${runId}`,
      realPath: `/srv/ws/${runId}`,
      repoPath: null,
      runDir: `/srv/rt/.maister/demo/runs/${runId}`,
      contextMounts: null,
      adoptedAt: "2026-09-01T00:00:00.000Z",
      releasedAt,
    });

    await mkdir(stateDir, { recursive: true });
    const legacy = new DatabaseSync(join(stateDir, HOST_STATE_FILE));

    legacy.exec(LEGACY_SCHEMA);
    legacy
      .prepare(
        "INSERT INTO host_identity (id, host_key, created_at) VALUES (1, ?, ?)",
      )
      .run("eh_legacy_key_0001", "2026-09-01T00:00:00.000Z");
    const insert = legacy.prepare(
      `INSERT INTO workspaces
         (id, run_id, project_slug, kind, path, real_path, repo_path, run_dir, context_mounts, adopted_at, released_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    insert.run(
      released,
      "run-1",
      "demo",
      "directory",
      "/srv/ws/run-1",
      "/srv/ws/run-1",
      null,
      "/srv/rt/.maister/demo/runs/run-1",
      null,
      "2026-09-01T00:00:00.000Z",
      "2026-09-01T01:00:00.000Z",
    );
    insert.run(
      active,
      "run-2",
      "demo",
      "directory",
      "/srv/ws/run-2",
      "/srv/ws/run-2",
      null,
      "/srv/rt/.maister/demo/runs/run-2",
      "[]",
      "2026-09-01T00:00:00.000Z",
      null,
    );
    expect(legacy.prepare("PRAGMA user_version").get()).toEqual({
      user_version: 0,
    });
    legacy.close();

    const state = openHostState({ stateDir });

    expect(state.hostKey).toBe("eh_legacy_key_0001");
    expect(state.getWorkspace(released)).toMatchObject({
      runId: "run-1",
      releasedAt: "2026-09-01T01:00:00.000Z",
    });
    expect(state.getWorkspace(active)).toMatchObject({
      runId: "run-2",
      releasedAt: null,
      contextMounts: [],
    });
    // The released row is history: it no longer answers a lookup, and no
    // longer blocks a fresh ACTIVE handle at the same (run, realpath) ...
    expect(state.findWorkspaceByRealPath("run-1", "/srv/ws/run-1")).toBeNull();
    state.insertWorkspace(row(fresh, "run-1", null));
    expect(state.findWorkspaceByRealPath("run-1", "/srv/ws/run-1")?.id).toBe(
      fresh,
    );
    // ... while two ACTIVE handles for one (run, realpath) are still refused.
    expect(() =>
      state.insertWorkspace(row(`ws_${"d".repeat(32)}`, "run-1", null)),
    ).toThrow();
    state.close();

    const migrated = new DatabaseSync(join(stateDir, HOST_STATE_FILE));
    const table = migrated
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'",
      )
      .get();
    const index = migrated
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'workspaces_active_uq'",
      )
      .get();

    expect(migrated.prepare("PRAGMA user_version").get()).toEqual({
      user_version: HOST_STATE_SCHEMA_VERSION,
    });
    expect(String(table?.sql)).not.toMatch(/UNIQUE/);
    expect(String(index?.sql)).toMatch(/WHERE released_at IS NULL/);
    migrated.close();
  });

  it("H9: a fresh store starts at the current user_version and reopens without migrating", async () => {
    const root = await tempRoot();
    const stateDir = join(root, "s");
    const state = openHostState({ stateDir });

    state.close();
    const db = new DatabaseSync(join(stateDir, HOST_STATE_FILE));

    expect(db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: HOST_STATE_SCHEMA_VERSION,
    });
    db.close();

    const reopened = openHostState({ stateDir });

    expect(reopened.hostKey).toBe(state.hostKey);
    reopened.close();
  });
});

// The pre-partial-index DDL a user_version 0 store was created with.
const LEGACY_SCHEMA = `
CREATE TABLE host_identity (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  host_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE run_fences (
  run_id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE workspaces (
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
CREATE TABLE command_receipts (
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
CREATE INDEX command_receipts_received_idx ON command_receipts (received_at);
`;
