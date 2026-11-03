// ADR-166 T2.1 — host identity + state store (H1–H9).
import { randomUUID } from "node:crypto";
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
  type CommandReceiptRow,
} from "../host-state";
import { bootExecutionHost } from "../main";
import { DEFAULT_RUNTIME_LIMITS } from "../runtime-limits";
import { readHostProcessContext } from "../session-process-context";

import {
  bootHost,
  cleanupRuntimeRoot,
  silentLogger,
  type BootedHost,
} from "./_fixtures/boot-host";

const booted: BootedHost[] = [];
const roots: string[] = [];

function processReceipt(): CommandReceiptRow {
  return {
    commandId: randomUUID(),
    runId: randomUUID(),
    kind: "session.create",
    assignmentId: randomUUID(),
    epoch: 1,
    hostSessionId: null,
    requestDigest: "process-obligation-fixture",
    eventId: null,
    phase: "accepted",
    httpStatus: 202,
    body: {},
    receivedAt: "2026-11-03T12:00:00.000Z",
    completedAt: null,
  };
}

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

describe("durable session process obligations", () => {
  it.each([
    "retained",
    "ack-pruned-and-compacted",
    "closed-missing-receipt",
  ] as const)(
    "holds a legacy restart-closed producer without rewriting %s history",
    async (history) => {
      const stateDir = await tempRoot();
      let clock = Date.parse("2026-11-03T12:00:00.000Z");
      let state = openHostState({ stateDir, now: () => new Date(clock) });
      const receipt = processReceipt();
      const sessionId = randomUUID();

      state.reserveProducerReceipt(receipt, 0);
      state.bindProducerSession(receipt.commandId, sessionId);
      state.putReceipt({
        ...receipt,
        phase: "completed",
        httpStatus: 201,
        body: { sessionId, pid: 54321, acpSessionId: "old-owned-adapter" },
        completedAt: new Date(clock).toISOString(),
      });
      const terminal = state.appendRuntimeEvent({
        terminal: true,
        funding: { partition: "control", walletId: receipt.commandId },
        draft: {
          runId: receipt.runId,
          assignmentId: receipt.assignmentId!,
          assignmentEpoch: receipt.epoch,
          hostSessionId: sessionId,
          eventType: "session.crashed",
          occurredAt: new Date(clock).toISOString(),
          payload: { exitCode: null, signal: null, reason: "host_restart" },
        },
      });

      expect(state.producerWalletOpen(receipt.commandId)).toBe(false);
      if (history !== "retained") {
        state.ackRuntimeEvents(terminal.streamId, terminal.sequence);
        clock += 120_000;
        expect(
          state.pruneAcknowledgedRuntimeEvents(new Date(clock), {
            mode: "retained_pressure",
          }),
        ).toBe(1);
        expect(
          state.retireReceipt(receipt.commandId, {
            expectedRequestSha256: receipt.requestDigest,
            expectedPhase: "completed",
            assignmentEpoch: 1,
          }).outcome,
        ).toBe("retired");
      }
      state.close();
      const legacy = new DatabaseSync(join(stateDir, HOST_STATE_FILE));
      if (history === "closed-missing-receipt")
        legacy
          .prepare("DELETE FROM command_receipts WHERE command_id=?")
          .run(receipt.commandId);
      const receiptBefore = legacy
        .prepare("SELECT * FROM command_receipts WHERE command_id=?")
        .get(receipt.commandId);
      const eventsBefore = legacy
        .prepare(
          "SELECT * FROM runtime_event_outbox ORDER BY sequence_sort_key",
        )
        .all();

      legacy.exec(
        "DROP TABLE session_process_obligations; PRAGMA user_version=15;",
      );
      legacy.close();
      state = openHostState({ stateDir, now: () => new Date(clock) });
      try {
        expect(state.sessionProcessesForRun(receipt.runId)).toEqual([
          expect.objectContaining({
            commandId: receipt.commandId,
            hostSessionId: sessionId,
            phase: "unproven",
            processGroup: null,
            retiredAt: null,
            registeredAt: new Date(clock).toISOString(),
          }),
        ]);
        expect(state.releaseSessionProcessesFromPriorBoot()).toBe(0);
        expect(state.recoverAcceptedPromptReceipts()).toBe(0);
        const inspected = new DatabaseSync(join(stateDir, HOST_STATE_FILE));

        try {
          expect(
            inspected
              .prepare("SELECT * FROM command_receipts WHERE command_id=?")
              .get(receipt.commandId),
          ).toEqual(receiptBefore);
          expect(
            inspected
              .prepare(
                "SELECT * FROM runtime_event_outbox ORDER BY sequence_sort_key",
              )
              .all(),
          ).toEqual(eventsBefore);
        } finally {
          inspected.close();
        }
      } finally {
        state.close();
      }
    },
  );

  it("recovers only one released create and its prompt while another accepted producer remains live", () => {
    const state = openHostState({ inMemory: true });
    const retired = processReceipt();
    const live = processReceipt();
    const retiredSession = randomUUID();
    const liveSession = randomUUID();

    try {
      for (const [receipt, hostSessionId, processGroup] of [
        [retired, retiredSession, 54321],
        [live, liveSession, 54322],
      ] as const) {
        state.setFence(receipt.runId, receipt.assignmentId!, receipt.epoch);
        state.reserveProducerReceipt(receipt, 0);
        state.registerSessionProcess({
          commandId: receipt.commandId,
          runId: receipt.runId,
          assignmentId: receipt.assignmentId!,
          epoch: receipt.epoch,
          hostSessionId,
          processGroup,
        });
        state.bindProducerSession(receipt.commandId, hostSessionId);
      }
      const prompt = {
        ...retired,
        commandId: randomUUID(),
        kind: "session.prompt",
        hostSessionId: retiredSession,
      };
      const livePrompt = {
        ...live,
        commandId: randomUUID(),
        kind: "session.prompt",
        hostSessionId: liveSession,
      };

      state.putReceipt(prompt, { kind: "new_work" });
      state.putReceipt(livePrompt, { kind: "new_work" });
      const liveReceiptBefore = state.getReceipt(live.commandId);
      const livePromptBefore = state.getReceipt(livePrompt.commandId);

      expect(state.recoverReleasedSessionProcess(retired.commandId)).toBe(0);
      state.releaseSessionProcess(retired.commandId, new Date().toISOString());
      expect(state.recoverReleasedSessionProcess(retired.commandId)).toBe(2);
      expect(state.getReceipt(retired.commandId)).toMatchObject({
        phase: "rejected",
        body: {
          details: {
            sessionCreateQuiescence: { version: 1, process: "terminated" },
          },
        },
      });
      expect(state.getReceipt(prompt.commandId)?.phase).toBe("rejected");
      expect(state.producerWalletOpen(retired.commandId)).toBe(false);
      expect(state.getReceipt(live.commandId)).toEqual(liveReceiptBefore);
      expect(state.getReceipt(livePrompt.commandId)).toEqual(livePromptBefore);
      expect(state.producerWalletOpen(live.commandId)).toBe(true);
      expect(state.recoverReleasedSessionProcess(retired.commandId)).toBe(0);
      expect(
        state.runtimeEventsAfter(state.getRuntimeEventStreamId(), null),
      ).toHaveLength(3);
    } finally {
      state.close();
    }
  });

  it("seeds a missing current-schema owner on every boot and releases only positively different OS boots", async () => {
    const stateDir = await tempRoot();
    const context = readHostProcessContext();
    let state = openHostState({ stateDir });
    const [priorBoot, otherNamespace, unknownBoot] = [
      processReceipt(),
      processReceipt(),
      processReceipt(),
    ];

    for (const receipt of [priorBoot, otherNamespace, unknownBoot])
      state.reserveProducerReceipt(receipt, 0);
    state.close();
    state = openHostState({ stateDir });
    expect(state.pendingSessionProcesses()).toHaveLength(3);
    state.close();
    const historical = new DatabaseSync(join(stateDir, HOST_STATE_FILE));
    const oldBoot =
      context.osBootIdentity === "00000000-0000-0000-0000-000000000001"
        ? "00000000-0000-0000-0000-000000000002"
        : "00000000-0000-0000-0000-000000000001";

    historical
      .prepare(
        "UPDATE session_process_obligations SET os_boot_identity=? WHERE command_id=?",
      )
      .run(oldBoot, priorBoot.commandId);
    historical
      .prepare(
        "UPDATE session_process_obligations SET pid_namespace='historical-other-namespace' WHERE command_id=?",
      )
      .run(otherNamespace.commandId);
    historical
      .prepare(
        "UPDATE session_process_obligations SET os_boot_identity=NULL WHERE command_id=?",
      )
      .run(unknownBoot.commandId);
    historical.close();
    state = openHostState({ stateDir });
    try {
      expect(state.releaseSessionProcessesFromPriorBoot()).toBe(1);
      expect(state.releaseSessionProcessesFromPriorBoot()).toBe(0);
      expect(state.sessionProcessesForRun(priorBoot.runId)).toEqual([
        expect.objectContaining({
          phase: "released",
          processGroup: null,
          osBootIdentity: oldBoot,
          retiredOsBootIdentity: context.osBootIdentity,
          retiredAt: expect.any(String),
        }),
      ]);
      expect(
        state
          .pendingSessionProcesses()
          .map((owner) => owner.commandId)
          .sort(),
      ).toEqual([otherNamespace.commandId, unknownBoot.commandId].sort());
      expect(state.recoverAcceptedPromptReceipts()).toBe(1);
      expect(state.getReceipt(priorBoot.commandId)).toMatchObject({
        phase: "rejected",
        body: {
          details: {
            sessionCreateQuiescence: { version: 1, process: "terminated" },
          },
        },
      });
      expect(state.getReceipt(otherNamespace.commandId)?.phase).toBe(
        "accepted",
      );
      expect(state.getReceipt(unknownBoot.commandId)?.phase).toBe("accepted");
    } finally {
      state.close();
    }
  });

  it("fails the legacy migration when an open producer has lost its create receipt", async () => {
    const stateDir = await tempRoot();
    const state = openHostState({ stateDir });
    const receipt = processReceipt();

    state.reserveProducerReceipt(receipt, 0);
    state.close();
    const legacy = new DatabaseSync(join(stateDir, HOST_STATE_FILE));

    legacy.exec(
      "DROP TABLE session_process_obligations; DELETE FROM command_receipts; PRAGMA user_version=15;",
    );
    legacy.close();
    expect(() => openHostState({ stateDir })).toThrow(HostStateUnwritableError);
    const inspected = new DatabaseSync(join(stateDir, HOST_STATE_FILE));

    try {
      expect(inspected.prepare("PRAGMA user_version").get()).toEqual({
        user_version: 15,
      });
      expect(
        inspected
          .prepare(
            "SELECT count(*) count FROM runtime_event_wallets WHERE closed=0",
          )
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      inspected.close();
    }
  });

  it("registers only the current accepted producer, keeps pending ownership through restart, and releases without rewriting its identity", async () => {
    const stateDir = await tempRoot();
    const clock = new Date("2026-11-03T12:00:00.000Z");
    let state = openHostState({ stateDir, now: () => clock });
    const receipt = processReceipt();
    const process = {
      commandId: receipt.commandId,
      runId: receipt.runId,
      assignmentId: receipt.assignmentId!,
      epoch: receipt.epoch,
      hostSessionId: randomUUID(),
      processGroup: 54321,
    };

    try {
      expect(() => state.registerSessionProcess(process)).toThrow();
      state.setFence(receipt.runId, receipt.assignmentId!, receipt.epoch);
      state.reserveProducerReceipt(receipt, 0);
      state.registerSessionProcess(process);
      state.registerSessionProcess(process);
      state.bindProducerSession(receipt.commandId, process.hostSessionId);
      const failure = {
        version: 1,
        stage: "acp_handshake",
        causeChain: [{ name: "Error", code: "ETIMEDOUT" }],
      };

      state.putReceipt(
        {
          ...receipt,
          httpStatus: 503,
          body: { details: { sessionCreateFailure: failure } },
        },
        { kind: "producer", outputBindingCount: 0 },
      );
      expect(state.pendingSessionProcesses()).toEqual([
        {
          ...process,
          ...readHostProcessContext(),
          retiredOsBootIdentity: null,
          phase: "registered",
          registeredAt: clock.toISOString(),
          retiredAt: null,
        },
      ]);
      expect(() =>
        state.registerSessionProcess({ ...process, processGroup: 54322 }),
      ).toThrow();
      expect(() =>
        state.registerSessionProcess({
          ...process,
          hostSessionId: randomUUID(),
        }),
      ).toThrow();
      state.close();
      state = openHostState({ stateDir, now: () => clock });
      expect(state.recoverAcceptedPromptReceipts()).toBe(0);
      expect(state.getReceipt(receipt.commandId)).toMatchObject({
        phase: "accepted",
        completedAt: null,
        body: { details: { reason: "session_create_exit_unconfirmed" } },
      });
      expect(state.producerWalletOpen(receipt.commandId)).toBe(true);
      state.setFence(receipt.runId, randomUUID(), 2);
      expect(() => state.registerSessionProcess(process)).toThrow();
      const retiredAt = "2026-11-03T12:01:00.000Z";

      state.releaseSessionProcess(receipt.commandId, retiredAt);
      state.releaseSessionProcess(
        receipt.commandId,
        "2026-11-03T12:02:00.000Z",
      );
      expect(state.pendingSessionProcesses()).toEqual([]);
      expect(state.sessionProcessesForRun(receipt.runId)).toEqual([
        {
          ...process,
          ...readHostProcessContext(),
          retiredOsBootIdentity: null,
          phase: "released",
          registeredAt: clock.toISOString(),
          retiredAt,
        },
      ]);
      expect(state.recoverAcceptedPromptReceipts()).toBe(1);
      expect(state.getReceipt(receipt.commandId)).toMatchObject({
        phase: "rejected",
        body: {
          details: {
            sessionCreateFailure: failure,
            sessionCreateQuiescence: { version: 1, process: "terminated" },
          },
        },
      });
    } finally {
      state.close();
    }
  });

  it("migrates legacy open wallets as unproven without inventing retirement or changing terminal receipts", async () => {
    const stateDir = await tempRoot();
    let state = openHostState({ stateDir });
    const accepted = processReceipt();
    const completed = processReceipt();
    const closed = processReceipt();
    const contradicted = processReceipt();
    const completedBody = {
      sessionId: randomUUID(),
      pid: 12345,
      acpSessionId: "legacy-acp",
    };

    for (const receipt of [accepted, completed, contradicted]) {
      state.reserveProducerReceipt(receipt, 0);
      state.bindProducerSession(receipt.commandId, randomUUID());
    }
    state.putReceipt({
      ...completed,
      phase: "completed",
      httpStatus: 201,
      body: completedBody,
      completedAt: "2026-11-03T12:01:00.000Z",
    });
    state.reserveProducerReceipt(closed, 0);
    state.putReceipt({
      ...closed,
      phase: "rejected",
      httpStatus: 503,
      body: {
        details: {
          sessionCreateQuiescence: { version: 1, process: "not_started" },
        },
      },
      completedAt: "2026-11-03T12:01:00.000Z",
    });
    state.putReceipt({
      ...contradicted,
      phase: "rejected",
      httpStatus: 503,
      body: {
        details: {
          sessionCreateQuiescence: { version: 1, process: "not_started" },
        },
      },
      completedAt: "2026-11-03T12:01:00.000Z",
    });
    state.closeProducerWallet(contradicted.commandId);
    state.close();
    const legacy = new DatabaseSync(join(stateDir, HOST_STATE_FILE));

    legacy.exec(
      "DROP TABLE session_process_obligations; PRAGMA user_version=15;",
    );
    legacy.close();
    state = openHostState({ stateDir });
    try {
      expect(state.pendingSessionProcesses()).toHaveLength(3);
      expect(state.sessionProcessesForRun(closed.runId)).toEqual([]);
      expect(state.sessionProcessesForRun(contradicted.runId)).toEqual([
        expect.objectContaining({ phase: "unproven" }),
      ]);
      expect(state.sessionProcessesForRun(accepted.runId)).toEqual([
        expect.objectContaining({
          commandId: accepted.commandId,
          processGroup: null,
          phase: "unproven",
          retiredAt: null,
        }),
      ]);
      expect(() =>
        state.releaseSessionProcess(
          accepted.commandId,
          new Date().toISOString(),
        ),
      ).toThrow();
      expect(state.recoverAcceptedPromptReceipts()).toBe(0);
      expect(state.getReceipt(accepted.commandId)).toMatchObject({
        phase: "accepted",
        body: { details: { reason: "session_create_exit_unconfirmed" } },
      });
      expect(state.getReceipt(completed.commandId)).toMatchObject({
        phase: "completed",
        body: completedBody,
      });
      expect(state.producerWalletOpen(accepted.commandId)).toBe(true);
      expect(state.producerWalletOpen(completed.commandId)).toBe(true);
      state.close();
      state = openHostState({ stateDir });
      expect(state.pendingSessionProcesses()).toHaveLength(3);
      expect(state.recoverAcceptedPromptReceipts()).toBe(0);
    } finally {
      state.close();
    }
  });

  it("does not compact a terminal create while its registered process still owns retirement", () => {
    const state = openHostState({ inMemory: true });
    const receipt = processReceipt();

    try {
      state.setFence(receipt.runId, receipt.assignmentId!, receipt.epoch);
      state.reserveProducerReceipt(receipt, 0);
      state.registerSessionProcess({
        commandId: receipt.commandId,
        runId: receipt.runId,
        assignmentId: receipt.assignmentId!,
        epoch: 1,
        hostSessionId: randomUUID(),
        processGroup: 54321,
      });
      state.putReceipt({
        ...receipt,
        phase: "completed",
        completedAt: "2026-11-03T12:01:00.000Z",
      });
      state.closeProducerWallet(receipt.commandId);
      const proof = {
        expectedRequestSha256: receipt.requestDigest,
        expectedPhase: "completed" as const,
        assignmentEpoch: 1,
      };

      expect(state.retireReceipt(receipt.commandId, proof)).toEqual({
        outcome: "producer_open",
      });
      expect(state.sessionProcessesForRun(receipt.runId)[0].phase).toBe(
        "registered",
      );
      state.releaseSessionProcess(receipt.commandId, new Date().toISOString());
      expect(state.retireReceipt(receipt.commandId, proof).outcome).toBe(
        "retired",
      );
    } finally {
      state.close();
    }
  });
});
