import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { openHostState } from "../host-state";
import { OUTBOX_BUDGET_SCHEMA } from "../outbox-budget";

describe("AT-02 physical runtime storage", () => {
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
          DROP TRIGGER runtime_event_budget_delete_v8;
          DROP TABLE runtime_event_ack_ranges;
          ${OUTBOX_BUDGET_SCHEMA}
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
