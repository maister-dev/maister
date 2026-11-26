import type { SessionRecord } from "../types";

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  openHostState,
  type CommandReceiptRow,
  type HostState,
} from "../host-state";
import { OUTBOX_BUDGET_SCHEMA } from "../outbox-budget";
import { RuntimeEventPublisher } from "../runtime-event-publisher";
import {
  DEFAULT_RUNTIME_LIMITS,
  MAX_RECEIPT_BODY_BYTES,
  SQLITE_WRITE_HEADROOM_BYTES,
  validateRuntimeLimits,
} from "../runtime-limits";
import { RuntimeObjectRegistry } from "../runtime-objects";
import { createSqliteStorage } from "../sqlite-storage";
import { reuseSqliteStatements } from "../sqlite-statements";

import {
  bootHost,
  cleanupRuntimeRoot,
  createSession,
  waitFor,
} from "./_fixtures/boot-host";

it("keeps cached reads fresh and simultaneous SQLite cursors independent", () => {
  const database = reuseSqliteStatements(new DatabaseSync(":memory:"));

  try {
    database.exec("CREATE TABLE samples (value INTEGER PRIMARY KEY)");
    database.exec("INSERT INTO samples VALUES (1), (2), (3)");
    const query = "SELECT value FROM samples WHERE value >= ? ORDER BY value";
    const first = database.prepare(query).iterate(1);

    expect(first.next().value).toEqual({ value: 1 });
    expect(database.prepare(query).get(3)).toEqual({ value: 3 });
    const second = database.prepare(query).iterate(2);

    expect(second.next().value).toEqual({ value: 2 });
    expect(Array.from(first)).toEqual([{ value: 2 }, { value: 3 }]);
    expect(Array.from(second)).toEqual([{ value: 3 }]);
    database.exec("BEGIN IMMEDIATE");
    expect(database.isTransaction).toBe(true);
    database.prepare("INSERT INTO samples VALUES (?)").run(4);
    expect(database.prepare(query).get(4)).toEqual({ value: 4 });
    database.exec("ROLLBACK");
    expect(database.isTransaction).toBe(false);
    expect(database.prepare(query).get(4)).toBeUndefined();
  } finally {
    database.close();
  }
});

// ADR-183: the per-kind gate replaces the dead assertCanAcceptMutatingCommand;
// a `new_work` receipt runs the physical, soft and hard admission checks.
function admitNewWork(state: HostState): void {
  state.putReceipt(
    {
      commandId: randomUUID(),
      runId: "admission-probe",
      kind: "session.prompt",
      assignmentId: randomUUID(),
      epoch: 1,
      hostSessionId: null,
      requestDigest: "admission-probe",
      eventId: null,
      phase: "accepted",
      httpStatus: 202,
      body: {},
      receivedAt: new Date().toISOString(),
      completedAt: null,
    },
    { kind: "new_work" },
  );
}

describe("AT-02 physical runtime storage", () => {
  it("measures file-backed admission without reading diagnostic page statistics", () => {
    const directory = mkdtempSync(join(tmpdir(), "maister-physical-reads-"));
    const file = join(directory, "state.sqlite");
    const db = new DatabaseSync(file);

    try {
      db.exec(
        "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; CREATE TABLE samples (value INTEGER)",
      );
      const storage = createSqliteStorage({
        db,
        file,
        limits: DEFAULT_RUNTIME_LIMITS,
      });
      const prepare = vi.spyOn(db, "prepare");

      expect(storage.canAdmit(0)).toBe(true);
      storage.write(() => db.exec("INSERT INTO samples VALUES (1)"));
      const queries = prepare.mock.calls.map(([sql]) => sql);

      prepare.mockRestore();
      expect(storage.snapshot().pageCount).toBeGreaterThan(0);
      expect(db.prepare("SELECT value FROM samples").get()).toEqual({
        value: 1,
      });
      expect(queries).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves default-scale retained capacity and terminal capacity across restart", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "maister-default-capacity-"));
    let state = openHostState({ stateDir });
    const receipt: CommandReceiptRow = {
      commandId: randomUUID(),
      runId: "default-capacity",
      kind: "session.create",
      assignmentId: randomUUID(),
      epoch: 1,
      hostSessionId: randomUUID(),
      requestDigest: "default-capacity",
      eventId: null,
      phase: "accepted",
      httpStatus: 202,
      body: {},
      receivedAt: new Date().toISOString(),
      completedAt: null,
    };
    const draft = {
      runId: receipt.runId,
      assignmentId: receipt.assignmentId!,
      assignmentEpoch: 1,
      hostSessionId: receipt.hostSessionId!,
      occurredAt: receipt.receivedAt,
    };
    let lastSequence = "0";
    let count = 0;

    try {
      state.reserveProducerReceipt(receipt, 3);
      const line = "x".repeat(60 * 1024);

      while (
        state.runtimeEventOutboxStats().retainedBytes <
        DEFAULT_RUNTIME_LIMITS.eventSoftBytes
      ) {
        const row = state.appendRuntimeEvent({
          draft: { ...draft, eventType: "session.line", payload: { line } },
        });

        lastSequence = row.sequence;
        count += 1;
        expect(count).toBeLessThan(8_000);
      }
      const streamId = state.getRuntimeEventStreamId();
      const retainedBytes = state.runtimeEventOutboxStats().retainedBytes;

      expect(state.runtimeStorageSnapshot().totalBytes).toBeLessThan(
        DEFAULT_RUNTIME_LIMITS.stateMaxBytes,
      );
      // ADR-183: unACKed rows at soft are pressure …
      expect(() => admitNewWork(state)).toThrow(/soft limit/);
      state.ackRuntimeEvents(streamId, lastSequence);
      expect(state.runtimeEventOutboxStats().unacknowledgedCount).toBe(0);
      expect(state.runtimeEventOutboxStats().retainedBytes).toBe(retainedBytes);
      // … the same rows retained after their ACK are not.
      expect(state.runtimeEventHealthSnapshot().pressured).toBe(false);
      expect(() => admitNewWork(state)).not.toThrow();
      state.close();
      state = openHostState({ stateDir });
      expect(state.runtimeEventOutboxStats().retainedCount).toBe(count);
      expect(state.pruneAcknowledgedRuntimeEvents(new Date())).toBe(0);
      // Retained replay at the soft budget is housekeeping, not capacity: a
      // new producer is still funded across the restart (ADR-183).
      expect(state.runtimeEventHealthSnapshot().pressured).toBe(false);
      expect(() =>
        state.reserveProducerReceipt(
          { ...receipt, commandId: randomUUID() },
          0,
        ),
      ).not.toThrow();
      const terminal = state.appendRuntimeEvent({
        draft: {
          ...draft,
          eventType: "session.exited",
          payload: { exitCode: 0 },
        },
        terminal: true,
        funding: { partition: "control", walletId: receipt.commandId },
      });

      expect(BigInt(terminal.sequence)).toBe(BigInt(lastSequence) + 1n);
      expect(state.runtimeEventOutboxStats().retainedCount).toBe(count + 1);
      expect(state.runtimeStorageAvailable()).toBe(true);
      expect(state.runtimeStorageSnapshot().totalBytes).toBeLessThan(
        DEFAULT_RUNTIME_LIMITS.stateMaxBytes,
      );
    } finally {
      state.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("bounds receipt write/retire WAL work and preserves the prior receipt on oversized replacement", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "maister-receipt-wal-"));
    const state = openHostState({ stateDir });
    const observer = new DatabaseSync(join(stateDir, "state.sqlite"));
    const receipt: CommandReceiptRow = {
      commandId: randomUUID(),
      runId: "receipt-footprint",
      kind: "session.prompt",
      assignmentId: randomUUID(),
      epoch: 1,
      hostSessionId: randomUUID(),
      requestDigest: "receipt-footprint",
      eventId: null,
      phase: "completed",
      httpStatus: 200,
      body: "x".repeat(MAX_RECEIPT_BODY_BYTES - 2),
      receivedAt: "2020-01-01T00:00:00.000Z",
      completedAt: "2020-01-01T00:00:01.000Z",
    };

    try {
      observer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      observer.exec("BEGIN");
      observer.prepare("SELECT COUNT(*) FROM command_receipts").get();
      state.putReceipt(receipt, { kind: "new_work" });
      const written = statSync(join(stateDir, "state.sqlite-wal")).size;

      expect(written).toBeLessThan(SQLITE_WRITE_HEADROOM_BYTES);
      expect(() =>
        state.putReceipt(
          {
            ...receipt,
            body: "x".repeat(MAX_RECEIPT_BODY_BYTES),
          },
          { kind: "new_work" },
        ),
      ).toThrow(/2 MiB/);
      expect(
        Buffer.byteLength(
          JSON.stringify(state.getReceipt(receipt.commandId)!.body),
        ),
      ).toBe(MAX_RECEIPT_BODY_BYTES);
      expect(
        state.retireReceipt(receipt.commandId, {
          expectedRequestSha256: "receipt-footprint",
          expectedPhase: "completed",
          assignmentEpoch: 1,
        }).outcome,
      ).toBe("retired");
      expect(
        statSync(join(stateDir, "state.sqlite-wal")).size - written,
      ).toBeLessThan(SQLITE_WRITE_HEADROOM_BYTES);
      expect(state.runtimeStorageAvailable()).toBe(true);
    } finally {
      if (observer.isTransaction) observer.exec("ROLLBACK");
      observer.close();
      state.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("pauses regular writes below physical high-water with a pinned WAL reader and resumes after checkpoint", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "maister-state-cap-"));
    const limits = validateRuntimeLimits({
      ...DEFAULT_RUNTIME_LIMITS,
      eventLowBytes: 48 * 1024 * 1024,
      eventSoftBytes: 60 * 1024 * 1024,
      eventHardBytes: 64 * 1024 * 1024,
      eventControlRows: 82,
      eventControlBytes: 82 * 16 * 1024,
      stateMaxBytes: 96 * 1024 * 1024,
    });
    const state = openHostState({ stateDir, limits });
    const observer = new DatabaseSync(join(stateDir, "state.sqlite"));
    const walletId = randomUUID();

    try {
      state.reserveProducerReceipt(
        {
          commandId: walletId,
          runId: "physical-frame",
          kind: "session.create",
          assignmentId: randomUUID(),
          epoch: 1,
          hostSessionId: null,
          requestDigest: "physical-frame",
          eventId: null,
          phase: "accepted",
          httpStatus: 202,
          body: {},
          receivedAt: new Date().toISOString(),
          completedAt: null,
        },
        0,
      );
      observer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      observer.exec("BEGIN");
      observer.prepare("SELECT COUNT(*) FROM runtime_event_outbox").get();
      let refused = false;

      for (let index = 0; index < 1000; index += 1) {
        try {
          state.appendRuntimeEvent({
            draft: {
              runId: "physical-capacity",
              assignmentId: "b213c794-fa0a-4907-ae7c-2cf2c2e8f87a",
              assignmentEpoch: 1,
              hostSessionId: "storage-session",
              eventType: "session.line",
              occurredAt: new Date().toISOString(),
              payload: { line: "x".repeat(60 * 1024) },
            },
          });
        } catch (error) {
          expect(error).toMatchObject({
            reason: "event_outbox_physical_limit",
          });
          refused = true;
          break;
        }
      }
      expect(refused).toBe(true);
      const bytes = [
        "state.sqlite",
        "state.sqlite-wal",
        "state.sqlite-shm",
      ].reduce((total, file) => total + statSync(join(stateDir, file)).size, 0);

      expect(bytes).toBeLessThan(limits.stateMaxBytes);
      expect(state.runtimeEventOutboxStats().retainedBytes).toBeLessThan(
        limits.eventSoftBytes,
      );
      expect(() => admitNewWork(state)).toThrow(/physical/);
      expect(state.tryReserveRuntimeFrame(walletId, 128)).toBeNull();
      observer.exec("ROLLBACK");
      observer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      expect(() => admitNewWork(state)).not.toThrow();
      const frame = state.tryReserveRuntimeFrame(walletId, 128);

      expect(frame).not.toBeNull();
      state.releaseRuntimeFrame(frame!);
    } finally {
      if (observer.isTransaction) observer.exec("ROLLBACK");
      observer.close();
      state.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("latches unavailable after a real SQLite full error and preserves committed rows", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "maister-state-full-"));
    const file = join(stateDir, "storage.sqlite");
    const db = new DatabaseSync(file);

    try {
      db.exec("CREATE TABLE evidence (body BLOB NOT NULL)");
      db.exec("INSERT INTO evidence VALUES ('preserved')");
      const storage = createSqliteStorage({
        db,
        file,
        limits: DEFAULT_RUNTIME_LIMITS,
      });
      const pages = db.prepare("PRAGMA page_count").get() as {
        page_count: number;
      };

      db.exec(`PRAGMA max_page_count = ${pages.page_count + 1}`);
      expect(() =>
        storage.write(() =>
          db.exec("INSERT INTO evidence VALUES (zeroblob(262144))"),
        ),
      ).toThrow(/full/);
      expect(storage.available()).toBe(false);
      expect(() =>
        storage.write(() => db.exec("DELETE FROM evidence")),
      ).toThrow(/repair/);
      expect(db.prepare("SELECT body FROM evidence").all()).toEqual([
        { body: "preserved" },
      ]);
    } finally {
      db.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("returns unavailable readiness after a real storage error without claiming durable terminal evidence", async () => {
    const host = await bootHost({ fixtureArgs: ["--hang", "--lines", "0"] });
    const db = new DatabaseSync(join(host.stateDir, "fault.sqlite"));

    try {
      const sessions = await Promise.all([
        createSession(host, { runId: "storage-failure-first" }),
        createSession(host, { runId: "storage-failure-second" }),
      ]);
      const entries = sessions.map((session) =>
        host.registry.get(session.sessionId)!,
      );
      const retained = host.hostState.runtimeEventOutboxStats().retainedCount;

      db.exec("CREATE TABLE evidence (body BLOB NOT NULL)");
      const pages = db.prepare("PRAGMA page_count").get() as {
        page_count: number;
      };

      db.exec(`PRAGMA max_page_count = ${pages.page_count + 1}`);
      const before = await fetch(`${host.url}/health`);

      expect(before.status).toBe(200);
      await before.body?.cancel();
      try {
        db.exec("INSERT INTO evidence VALUES (zeroblob(262144))");
        expect.fail("the real SQLite write must exhaust its page limit");
      } catch (error) {
        expect(error).toMatchObject({ code: "ERR_SQLITE_ERROR" });
        host.hostState.reportRuntimeStorageFailure(
          new Error("storage boundary failed", { cause: error }),
        );
      }
      const after = await fetch(`${host.url}/health`);

      expect(after.status).toBe(503);
      expect(await after.json()).toMatchObject({
        code: "EXECUTOR_UNAVAILABLE",
        details: { reason: "runtime_storage_unavailable" },
      });
      expect(() => admitNewWork(host.hostState)).toThrow(/repair/);
      await waitFor(() =>
        entries.every(
          (entry) =>
            entry.child.exitCode !== null || entry.child.signalCode !== null,
        ),
      );
      const terminals = await Promise.allSettled(
        entries.map((entry) => entry.record.outputTerminal),
      );

      expect(
        terminals.every(
          (result) =>
            result.status === "rejected" &&
            result.reason.reason === "runtime_storage_unavailable",
        ),
      ).toBe(true);
      expect(
        entries.every(
          (entry) =>
            entry.record.outputFailure?.details?.reason ===
            "runtime_storage_unavailable",
        ),
      ).toBe(true);
      expect(entries.every((entry) => !entry.record.terminalPublished)).toBe(
        true,
      );
      expect(host.hostState.runtimeEventOutboxStats().retainedCount).toBe(
        retained,
      );
    } finally {
      db.close();
      await host.stop();
      await cleanupRuntimeRoot(host.runtimeRoot);
    }
  });

  it("upgrades a v7 ACK timestamp without rewriting history and prunes a bounded contiguous prefix", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "maister-ack-upgrade-"));
    let clock = Date.now();
    let state = openHostState({ stateDir, now: () => new Date(clock) });

    try {
      for (let index = 0; index < 205; index += 1) {
        state.appendRuntimeEvent({
          draft: {
            runId: "storage-upgrade",
            assignmentId: "b213c794-fa0a-4907-ae7c-2cf2c2e8f87a",
            assignmentEpoch: 1,
            hostSessionId: "storage-session",
            eventType: "session.line",
            occurredAt: new Date(clock).toISOString(),
            payload: { line: `event ${index}` },
          },
        });
      }
      const streamId = state.getRuntimeEventStreamId();

      state.ackRuntimeEvents(streamId, "104");
      const original = state.runtimeEventsAfter(streamId, null, 205);

      state.close();
      const db = new DatabaseSync(join(stateDir, "state.sqlite"));

      try {
        db.exec(`UPDATE runtime_event_outbox SET acknowledged_at = (
          SELECT a.acknowledged_at FROM runtime_event_ack_ranges a WHERE a.stream_id = runtime_event_outbox.stream_id
            AND a.first_sort_key <= runtime_event_outbox.sequence_sort_key AND a.through_sort_key >= runtime_event_outbox.sequence_sort_key);
          DROP TRIGGER runtime_file_wallet_close;
        DROP TABLE runtime_frame_file_credits;
        DROP TABLE runtime_files;
        DROP TABLE runtime_file_wallets;
        DROP TABLE runtime_file_budget;
        DROP TRIGGER runtime_event_budget_delete_v8;
          DROP TABLE runtime_event_ack_ranges;
          ${OUTBOX_BUDGET_SCHEMA}
        ALTER TABLE command_receipts DROP COLUMN request_schema;
        ALTER TABLE command_receipts DROP COLUMN request_version;
        ALTER TABLE command_receipts DROP COLUMN host_key;
        ALTER TABLE command_receipts DROP COLUMN accepted_sequence;
        ALTER TABLE command_receipts DROP COLUMN terminal_stream_id;
        ALTER TABLE command_receipts DROP COLUMN terminal_sequence;
        ALTER TABLE command_receipts DROP COLUMN retired_at;
        ALTER TABLE workspaces DROP COLUMN company_id;
        ALTER TABLE runtime_objects DROP COLUMN producer_path;
        ALTER TABLE runtime_objects DROP COLUMN sealed_device;
        ALTER TABLE runtime_objects DROP COLUMN sealed_inode;
          PRAGMA user_version = 7;`);
      } finally {
        db.close();
      }
      state = openHostState({ stateDir, now: () => new Date(clock) });
      expect(state.runtimeEventsAfter(streamId, null, 205)).toEqual(original);
      expect(state.runtimeEventOutboxStats()).toMatchObject({
        retainedCount: 205,
        unacknowledgedCount: 100,
      });
      expect(
        state.pruneAcknowledgedRuntimeEvents(
          new Date(clock + 10 * state.limits.eventAckGraceMs),
        ),
      ).toBe(0);

      clock += state.limits.eventAckGraceMs + 1;
      state.ackRuntimeEvents(streamId, "104");
      state.ackRuntimeEvents(streamId, "204");
      expect(state.pruneAcknowledgedRuntimeEvents(new Date(clock))).toBe(100);
      expect(state.pruneAcknowledgedRuntimeEvents(new Date(clock))).toBe(5);
      expect(state.pruneAcknowledgedRuntimeEvents(new Date(clock))).toBe(0);
      expect(state.runtimeEventOutboxStats()).toMatchObject({
        retainedCount: 100,
        unacknowledgedCount: 0,
        replayFloor: "104",
      });
      state.close();
      state = openHostState({ stateDir, now: () => new Date(clock) });
      expect(state.runtimeEventsAfter(streamId, "104", 205)).toHaveLength(100);
      clock += state.limits.eventAckGraceMs + 1;
      expect(state.pruneAcknowledgedRuntimeEvents(new Date(clock))).toBe(100);
      expect(state.runtimeEventOutboxStats()).toMatchObject({
        retainedCount: 0,
        replayFloor: "204",
      });
    } finally {
      state.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("never skips a protected ACK range when the host clock moves backwards", () => {
    let clock = Date.now();
    const state = openHostState({ inMemory: true, now: () => new Date(clock) });

    try {
      for (let index = 0; index < 2; index += 1) {
        state.appendRuntimeEvent({
          draft: {
            runId: "storage-clock",
            assignmentId: "b213c794-fa0a-4907-ae7c-2cf2c2e8f87a",
            assignmentEpoch: 1,
            hostSessionId: "storage-session",
            eventType: "session.line",
            occurredAt: new Date(clock).toISOString(),
            payload: { line: `event ${index}` },
          },
        });
      }
      state.ackRuntimeEvents(state.getRuntimeEventStreamId(), "0");
      clock -= 2 * state.limits.eventAckGraceMs;
      state.ackRuntimeEvents(state.getRuntimeEventStreamId(), "1");
      clock += state.limits.eventAckGraceMs + 1;
      expect(state.pruneAcknowledgedRuntimeEvents(new Date(clock))).toBe(0);
      expect(state.runtimeEventOutboxStats()).toMatchObject({
        retainedCount: 2,
        replayFloor: null,
      });
    } finally {
      state.close();
    }
  });

  it("ACKs a large retained prefix with bounded WAL growth while a reader pins the previous snapshot", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "maister-ack-wal-"));
    const state = openHostState({ stateDir });
    const observer = new DatabaseSync(join(stateDir, "state.sqlite"));

    try {
      for (let index = 0; index < 128; index += 1) {
        state.appendRuntimeEvent({
          draft: {
            runId: "physical-storage",
            assignmentId: "b213c794-fa0a-4907-ae7c-2cf2c2e8f87a",
            assignmentEpoch: 1,
            hostSessionId: "storage-session",
            eventType: "session.line",
            occurredAt: new Date().toISOString(),
            payload: { line: "x".repeat(60 * 1024) },
          },
        });
      }
      observer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      observer.exec("BEGIN");
      observer.prepare("SELECT COUNT(*) FROM runtime_event_outbox").get();
      const before = statSync(join(stateDir, "state.sqlite-wal")).size;

      state.ackRuntimeEvents(state.getRuntimeEventStreamId(), "127");
      const growth = statSync(join(stateDir, "state.sqlite-wal")).size - before;

      expect(growth).toBeLessThanOrEqual(512 * 1024);
      expect(state.runtimeEventOutboxStats()).toMatchObject({
        retainedCount: 128,
        unacknowledgedCount: 0,
      });
    } finally {
      if (observer.isTransaction) observer.exec("ROLLBACK");
      observer.close();
      state.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps inline code text frames out of runtime-objects and seals real offloads in one post-rename transaction", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "maister-offload-tx-"));
    const objectsRoot = join(stateDir, "runtime-objects");
    const state = openHostState({ stateDir });
    const logger = pino({ level: "silent" });
    const objects = new RuntimeObjectRegistry(state, objectsRoot);
    const publisher = new RuntimeEventPublisher(
      state,
      logger,
      () => new Date("2026-11-25T12:00:00.000Z"),
      objects,
    );
    const walletId = randomUUID();
    const assignmentId = randomUUID();
    const sessionId = randomUUID();
    const runId = "inline-code-no-offload";

    try {
      state.reserveProducerReceipt(
        {
          commandId: walletId,
          runId,
          kind: "session.create",
          assignmentId,
          epoch: 1,
          hostSessionId: sessionId,
          requestDigest: "inline-code-no-offload",
          eventId: null,
          phase: "accepted",
          httpStatus: 202,
          body: {},
          receivedAt: "2026-11-25T12:00:00.000Z",
          completedAt: null,
        },
        0,
      );
      const frameReservation = state.tryReserveRuntimeFrame(walletId, 1024);

      expect(frameReservation).not.toBeNull();
      const record = {
        sessionId,
        runId,
        sessionName: "main",
        assignmentId,
        assignmentEpoch: 1,
        createdByCommandId: walletId,
        outputEventReservationId: frameReservation!,
        terminalPublished: false,
      } as unknown as SessionRecord;

      const codeLine = JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "acp-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "const x = a / b; // comment\nreturn <Button />;",
            },
          },
        },
      });

      publisher.publishTextFrame(record, [
        {
          type: "session.line",
          sessionId,
          monotonicId: 1,
          line: codeLine,
        },
        {
          type: "session.update",
          sessionId,
          monotonicId: 2,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "const x = a / b; // comment\nreturn <Button />;",
            },
          },
        },
      ]);

      expect(existsSync(objectsRoot) ? readdirSync(objectsRoot) : []).toEqual(
        [],
      );
      state.releaseRuntimeFrame(frameReservation!);

      // Real host path offload must commit insertRuntimeObject + sealRuntimeFile
      // in a single post-rename SQLite transaction (never separate insert + seal).
      const offloadReservation = state.tryReserveRuntimeFrame(walletId, 1024);

      expect(offloadReservation).not.toBeNull();
      const insertSpy = vi.spyOn(state, "insertRuntimeObject");
      const sealFileSpy = vi.spyOn(state, "sealRuntimeFile");
      const execSpy = vi.spyOn(DatabaseSync.prototype, "exec");
      const captured = objects.captureSessionContent({
        runId,
        assignmentId,
        assignmentEpoch: 1,
        hostSessionId: sessionId,
        funding: {
          kind: "frame",
          walletId,
          reservationId: offloadReservation!,
        },
        payload: {
          line: "opened /Users/dev/secret.ts",
        },
      });
      const commits = execSpy.mock.calls.filter(([sql]) => sql === "COMMIT");

      // 1 commit for reserveRuntimeFile + 1 combined post-rename commit = 2 total
      expect(commits).toHaveLength(2);
      expect(insertSpy).not.toHaveBeenCalled();
      expect(sealFileSpy).not.toHaveBeenCalled();
      expect(state.getRuntimeObject(captured.objectId)?.state).toBe(
        "available",
      );
      expect(state.getRuntimeFile(`object:${captured.objectId}`)?.sealed).toBe(
        true,
      );
      state.releaseRuntimeFrame(offloadReservation!);

      // Verify sealCapturedRuntimeObject rolls back runtime_objects insert if seal fails
      const rollbackObjectId = randomUUID();

      expect(() =>
        state.sealCapturedRuntimeObject(
          {
            ...state.getRuntimeObject(captured.objectId)!,
            id: rollbackObjectId,
          },
          `object:${rollbackObjectId}`,
          10,
        ),
      ).toThrow();
      expect(state.getRuntimeObject(rollbackObjectId)).toBeNull();
    } finally {
      vi.restoreAllMocks();
      state.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("configures SQLite cache/temp pragmas and amortizes healthy physicalSnapshot checks while measuring fresh on snapshot or near threshold", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "maister-pragma-amortize-"));
    let openedDb: DatabaseSync | undefined;
    const origExec = DatabaseSync.prototype.exec;
    const execSpy = vi
      .spyOn(DatabaseSync.prototype, "exec")
      .mockImplementation(function (this: DatabaseSync, sql: string) {
        openedDb = this;

        return origExec.call(this, sql);
      });
    const state = openHostState({ stateDir });

    execSpy.mockRestore();
    try {
      expect(openedDb).toBeDefined();
      expect(openedDb!.prepare("PRAGMA cache_size").get()).toEqual({
        cache_size: -65536,
      });
      expect(openedDb!.prepare("PRAGMA temp_store").get()).toEqual({
        temp_store: 2,
      });
    } finally {
      state.close();
      rmSync(stateDir, { recursive: true, force: true });
    }

    const storageDir = mkdtempSync(join(tmpdir(), "maister-amortize-fs-"));
    const file = join(storageDir, "state.sqlite");
    const db = new DatabaseSync(file);

    try {
      db.exec(
        "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; CREATE TABLE samples (value INTEGER)",
      );
      const storage = createSqliteStorage({
        db,
        file,
        limits: DEFAULT_RUNTIME_LIMITS,
      });
      const statfsSpy = vi.spyOn(fs, "statfsSync");

      syncBuiltinESMExports();
      for (let i = 0; i < 16; i += 1) {
        storage.write(() => {
          db.prepare("INSERT INTO samples VALUES (?)").run(i);
        });
      }
      const healthyMeasurements = statfsSpy.mock.calls.length;

      expect(healthyMeasurements).toBeLessThanOrEqual(2);

      // Explicit diagnostic snapshot always measures fresh
      statfsSpy.mockClear();
      storage.snapshot();
      expect(statfsSpy.mock.calls.length).toBe(1);

      // A single write whose estimated byte delta exceeds 512 KiB must measure fresh
      statfsSpy.mockClear();
      storage.write(() => {
        db.prepare("INSERT INTO samples VALUES (?)").run(99);
      }, 600 * 1024);
      expect(statfsSpy.mock.calls.length).toBe(1);

      // Near threshold (within 8 MiB of stateMaxBytes): measures fresh every write
      const tightLimits = {
        ...DEFAULT_RUNTIME_LIMITS,
        // Tight ceiling within 8 MiB of SQLITE_WRITE_HEADROOM_BYTES
        stateMaxBytes: SQLITE_WRITE_HEADROOM_BYTES + 4 * 1024 * 1024,
      };
      const tightStorage = createSqliteStorage({
        db,
        file,
        limits: tightLimits,
      });

      statfsSpy.mockClear();
      for (let i = 0; i < 4; i += 1) {
        tightStorage.write(() => {
          db.prepare("INSERT INTO samples VALUES (?)").run(100 + i);
        });
      }
      expect(statfsSpy.mock.calls.length).toBe(4);
    } finally {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
      db.close();
      rmSync(storageDir, { recursive: true, force: true });
    }
  });
});
