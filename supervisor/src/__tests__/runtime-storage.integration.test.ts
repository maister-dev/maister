import { mkdtempSync, rmSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { openHostState, type CommandReceiptRow } from "../host-state";
import { OUTBOX_BUDGET_SCHEMA } from "../outbox-budget";
import {
  DEFAULT_RUNTIME_LIMITS,
  MAX_RECEIPT_BODY_BYTES,
  SQLITE_WRITE_HEADROOM_BYTES,
  validateRuntimeLimits,
} from "../runtime-limits";
import { createSqliteStorage } from "../sqlite-storage";

import {
  bootHost,
  cleanupRuntimeRoot,
  createSession,
  waitFor,
} from "./_fixtures/boot-host";

describe("AT-02 physical runtime storage", () => {
  it("preserves default-scale retained pressure and terminal capacity across restart", () => {
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
      expect(() => state.assertCanAcceptMutatingCommand()).toThrow();
      state.ackRuntimeEvents(streamId, lastSequence);
      expect(state.runtimeEventOutboxStats().unacknowledgedCount).toBe(0);
      expect(state.runtimeEventOutboxStats().retainedBytes).toBe(retainedBytes);
      expect(() => state.assertCanAcceptMutatingCommand()).toThrow();
      state.close();
      state = openHostState({ stateDir });
      expect(state.runtimeEventOutboxStats().retainedCount).toBe(count);
      expect(state.pruneAcknowledgedRuntimeEvents(new Date())).toBe(0);
      expect(() =>
        state.reserveProducerReceipt(
          { ...receipt, commandId: randomUUID() },
          0,
        ),
      ).toThrow();
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
      state.putReceipt(receipt);
      const written = statSync(join(stateDir, "state.sqlite-wal")).size;

      expect(written).toBeLessThan(SQLITE_WRITE_HEADROOM_BYTES);
      expect(() =>
        state.putReceipt({
          ...receipt,
          body: "x".repeat(MAX_RECEIPT_BODY_BYTES),
        }),
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

    try {
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
          expect(error).toMatchObject({ reason: "event_outbox_soft_limit" });
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
      expect(() => state.assertCanAcceptMutatingCommand()).toThrow(/physical/);
      observer.exec("ROLLBACK");
      observer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      expect(() => state.assertCanAcceptMutatingCommand()).not.toThrow();
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
      const entries = sessions.map(
        (session) => host.registry.get(session.sessionId)!,
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
      expect(() => host.hostState.assertCanAcceptMutatingCommand()).toThrow(
        /repair/,
      );
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
});
