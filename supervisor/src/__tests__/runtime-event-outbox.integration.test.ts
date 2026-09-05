import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { openHostState, type CommandReceiptRow } from "../host-state";
import {
  CONTROL_EVENT_MAX_BYTES,
  DEFAULT_RUNTIME_LIMITS,
  validateRuntimeLimits,
  runtimeLimitsFromEnv,
} from "../runtime-limits";

const SMALL_LIMITS = validateRuntimeLimits({
  ...DEFAULT_RUNTIME_LIMITS,
  eventLowBytes: 8 * 1024,
  eventSoftBytes: 16 * 1024,
  eventHardBytes: 32 * 1024,
  eventLowRows: 2,
  eventSoftRows: 4,
  eventHardRows: 6,
});

function createReceipt(commandId = randomUUID()): CommandReceiptRow {
  return {
    commandId,
    runId: "run-event-outbox",
    kind: "session.create",
    assignmentId: "b213c794-fa0a-4907-ae7c-2cf2c2e8f87a",
    epoch: 1,
    hostSessionId: null,
    requestDigest: "digest",
    eventId: null,
    phase: "accepted",
    httpStatus: 202,
    body: {},
    receivedAt: "2026-09-05T12:00:00.000Z",
    completedAt: null,
  };
}

function eventDraft(
  eventType: "session.created" | "session.command" = "session.created",
) {
  return {
    draft: {
      runId: "run-event-outbox",
      assignmentId: "b213c794-fa0a-4907-ae7c-2cf2c2e8f87a",
      assignmentEpoch: 1,
      hostSessionId: "9f314433-b7e9-49b9-baf7-3a23879eae68",
      eventType,
      occurredAt: "2026-09-04T12:00:00.000Z",
      payload: { sourceMonotonicId: 1 },
    },
    terminal: eventType === "session.command",
  };
}

describe("Stage B durable host event outbox", () => {
  it("never reopens a completed producer wallet after its terminal receipt has been pruned", () => {
    const state = openHostState({ inMemory: true });
    const receipt = createReceipt();

    try {
      state.reserveProducerReceipt(receipt, 0);
      state.putReceipt({
        ...receipt,
        phase: "completed",
        completedAt: receipt.receivedAt,
      });
      state.closeProducerWallet(receipt.commandId);
      state.pruneReceipts(new Date("2030-01-01T00:00:00Z"));
      expect(state.getReceipt(receipt.commandId)).toBeNull();
      expect(() => state.reserveProducerReceipt(receipt, 0)).toThrow(
        /cannot admit another execution/,
      );
      expect(state.getReceipt(receipt.commandId)).toBeNull();
      expect(state.runtimeEventOutboxStats().budget.reservedControlRows).toBe(
        0,
      );
    } finally {
      state.close();
    }
  });

  it("validates finite coupled settings and refuses to shrink below persisted terminal promises", () => {
    expect(runtimeLimitsFromEnv({})).toEqual(DEFAULT_RUNTIME_LIMITS);
    for (const value of ["", "Infinity", "1.5", "-1", "9007199254740992"]) {
      expect(() =>
        runtimeLimitsFromEnv({ MAISTER_EVENT_ACK_GRACE_MS: value }),
      ).toThrow(/integer/);
    }
    expect(() =>
      validateRuntimeLimits({
        ...SMALL_LIMITS,
        eventLowRows: SMALL_LIMITS.eventSoftRows,
      }),
    ).toThrow(/low < soft < hard/);
    expect(() =>
      validateRuntimeLimits({ ...SMALL_LIMITS, eventControlRows: 1025 }),
    ).toThrow(/16 KiB per row/);
    const stateDir = mkdtempSync(join(tmpdir(), "maister-outbox-settings-"));

    try {
      const state = openHostState({ stateDir });

      state.reserveProducerReceipt(createReceipt(), 32);
      state.close();
      expect(() =>
        openHostState({
          stateDir,
          limits: validateRuntimeLimits({
            ...DEFAULT_RUNTIME_LIMITS,
            eventControlRows: 82,
          }),
        }),
      ).toThrow(/cannot honor persisted/);
      const restored = openHostState({ stateDir });

      expect(
        restored.runtimeEventOutboxStats().budget.reservedControlRows,
      ).toBe(50);
      restored.close();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("replays bounded byte pages through the complete retained backlog", () => {
    const state = openHostState({ inMemory: true });

    try {
      for (let index = 0; index < 40; index += 1) {
        const input = eventDraft();

        state.appendRuntimeEvent({
          ...input,
          draft: { ...input.draft, payload: { text: "x".repeat(60 * 1024) } },
        });
      }
      const stream = state.getRuntimeEventStreamId();
      let cursor: string | null = null;
      const sequences: string[] = [];
      let pages = 0;

      for (;;) {
        const page = state.runtimeEventsAfter(stream, cursor, 500);

        if (page.length === 0) break;
        expect(
          page.reduce((sum, row) => sum + row.encodedBytes, 0),
        ).toBeLessThanOrEqual(1_048_576);
        cursor = page.at(-1)!.sequence;
        sequences.push(...page.map((row) => row.sequence));
        pages += 1;
      }
      expect(pages).toBeGreaterThan(1);
      expect(sequences).toEqual(
        Array.from({ length: 40 }, (_, index) => String(index)),
      );
      expect(state.hasRuntimeEventsAfter(stream, "38")).toBe(true);
      expect(state.hasRuntimeEventsAfter(stream, "39")).toBe(false);
    } finally {
      state.close();
    }
  });

  it("repairs accepted prompts and credited teardown after restart even when regular storage is full and receipts exceed seven days", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "maister-outbox-recovery-"));
    let clock = Date.parse("2026-09-05T12:00:00Z");
    let state = openHostState({
      stateDir,
      limits: SMALL_LIMITS,
      now: () => new Date(clock),
    });

    try {
      const create = createReceipt();
      const sessionId = eventDraft().draft.hostSessionId;

      state.reserveProducerReceipt(create, 0);
      state.bindProducerSession(create.commandId, sessionId);
      state.putReceipt({
        ...create,
        phase: "completed",
        completedAt: new Date(clock).toISOString(),
      });
      const prompt = {
        ...createReceipt(),
        kind: "session.prompt",
        hostSessionId: sessionId,
      };

      state.putReceipt(prompt);
      for (let index = 0; index < SMALL_LIMITS.eventHardRows; index += 1)
        state.appendRuntimeEvent(eventDraft());
      const teardown = {
        ...createReceipt(),
        kind: "session.checkpoint",
        hostSessionId: sessionId,
      };

      state.putReceiptWithRuntimeEvent(
        teardown,
        {
          ...eventDraft("session.command"),
          funding: {
            partition: "control",
            walletId: create.commandId,
            commandId: teardown.commandId,
          },
        },
        { kind: "teardown", walletId: create.commandId },
      );
      state.close();
      clock += 8 * 24 * 60 * 60 * 1000;
      state = openHostState({
        stateDir,
        limits: SMALL_LIMITS,
        now: () => new Date(clock),
      });
      expect(state.getReceipt(prompt.commandId)?.phase).toBe("accepted");
      expect(state.recoverAcceptedPromptReceipts()).toBe(2);
      expect(state.getReceipt(prompt.commandId)?.body).toMatchObject({
        details: { reason: "turn_lost" },
      });
      expect(state.getReceipt(teardown.commandId)?.phase).toBe("rejected");
      expect(state.runtimeEventOutboxStats().budget).toMatchObject({
        regular: { retainedCount: SMALL_LIMITS.eventHardRows },
        control: { retainedCount: 4 },
        reservedControlRows: 0,
      });
      expect(state.recoverAcceptedPromptReceipts()).toBe(0);
      expect(
        state.runtimeEventsAfter(state.getRuntimeEventStreamId(), null).at(-1)
          ?.envelope.eventType,
      ).toBe("session.crashed");
    } finally {
      state.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it.each(["rows", "bytes"] as const)(
    "bounds regular %s without spending promised terminal credit",
    (dimension) => {
      const state = openHostState({ inMemory: true, limits: SMALL_LIMITS });
      const receipt = createReceipt();

      try {
        state.reserveProducerReceipt(receipt, 32);
        const input = eventDraft();
        const regular =
          dimension === "rows"
            ? input
            : {
                ...input,
                draft: {
                  ...input.draft,
                  payload: { text: "x".repeat(10 * 1024) },
                },
              };
        const count = dimension === "rows" ? SMALL_LIMITS.eventHardRows : 3;

        for (let index = 0; index < count; index += 1)
          state.appendRuntimeEvent(regular);
        expect(() => state.assertCanAcceptMutatingCommand()).toThrow(
          /soft limit/,
        );
        expect(() => state.appendRuntimeEvent(regular)).toThrow(
          /regular partition is full/,
        );
        // The failed append neither allocates a sequence nor consumes a wallet.
        expect(state.runtimeEventOutboxStats().budget.reservedControlRows).toBe(
          50,
        );
        const terminal = state.appendRuntimeEvent({
          ...eventDraft("session.command"),
          funding: { partition: "control", walletId: receipt.commandId },
        });

        expect(terminal.sequence).toBe(String(count));
        expect(state.runtimeEventOutboxStats().budget).toMatchObject({
          control: { retainedCount: 1 },
          reservedControlRows: 49,
        });
      } finally {
        state.close();
      }
    },
  );

  it("reserves all maximum producer wallets before acceptance and preserves other producers' credits", () => {
    const state = openHostState({ inMemory: true });
    const receipts = Array.from({ length: 20 }, () => createReceipt());

    try {
      for (const receipt of receipts.slice(0, 19))
        state.reserveProducerReceipt(receipt, 32);
      state.reserveProducerReceipt(receipts[0]!, 32);
      expect(state.runtimeEventOutboxStats().budget.reservedControlRows).toBe(
        950,
      );
      expect(() => state.reserveProducerReceipt(receipts[19]!, 32)).toThrow(
        /cannot fund another producer/,
      );
      expect(state.getReceipt(receipts[19]!.commandId)).toBeNull();
      for (let index = 0; index < 50; index += 1) {
        state.appendRuntimeEvent({
          ...eventDraft(),
          funding: { partition: "control", walletId: receipts[0]!.commandId },
        });
      }
      expect(() =>
        state.appendRuntimeEvent({
          ...eventDraft(),
          funding: { partition: "control", walletId: receipts[0]!.commandId },
        }),
      ).toThrow(/available credit/);
      expect(state.runtimeEventOutboxStats().budget.reservedControlRows).toBe(
        900,
      );
      // A consumed reservation becomes retained replay; closing does not erase it.
      state.closeProducerWallet(receipts[0]!.commandId);
      expect(() => state.reserveProducerReceipt(receipts[19]!, 32)).toThrow(
        /cannot fund another producer/,
      );
      const other = state.appendRuntimeEvent({
        ...eventDraft(),
        funding: { partition: "control", walletId: receipts[1]!.commandId },
      });

      expect(other.sequence).toBe("50");
    } finally {
      state.close();
    }
  });

  it("rolls back a wallet spend for an invalid or cross-assignment event and bounds each control row", () => {
    const state = openHostState({ inMemory: true });
    const receipt = createReceipt();
    const input = eventDraft();
    const funding = {
      partition: "control",
      walletId: receipt.commandId,
    } as const;

    try {
      state.reserveProducerReceipt(receipt, 0);
      expect(() =>
        state.appendRuntimeEvent({
          ...input,
          funding,
          draft: { ...input.draft, assignmentEpoch: 2 },
        }),
      ).toThrow(/available credit/);
      expect(() =>
        state.appendRuntimeEvent({
          ...input,
          funding,
          draft: {
            ...input.draft,
            payload: { text: "x".repeat(CONTROL_EVENT_MAX_BYTES) },
          },
        }),
      ).toThrow(/exceeds 16 KiB/);
      expect(state.runtimeEventOutboxStats().budget.reservedControlRows).toBe(
        18,
      );
      expect(state.appendRuntimeEvent({ ...input, funding }).sequence).toBe(
        "0",
      );
    } finally {
      state.close();
    }
  });

  it("keeps the emergency floor outside producer wallets", () => {
    const state = openHostState({ inMemory: true });

    try {
      for (let index = 0; index < 64; index += 1) {
        state.appendRuntimeEvent({
          ...eventDraft(),
          funding: { partition: "emergency" },
        });
      }
      expect(() =>
        state.appendRuntimeEvent({
          ...eventDraft(),
          funding: { partition: "emergency" },
        }),
      ).toThrow(/emergency floor is exhausted/);
      state.reserveProducerReceipt(createReceipt(), 32);
      expect(state.runtimeEventOutboxStats().budget.reservedControlRows).toBe(
        50,
      );
    } finally {
      state.close();
    }
  });

  it("resumes below the low watermark only after ACKed replay is pruned, including across restart", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "maister-outbox-pressure-"));
    let clock = Date.now();
    let state = openHostState({
      stateDir,
      limits: SMALL_LIMITS,
      now: () => new Date(clock),
    });
    const snapshots: boolean[] = [];

    try {
      const receipt = createReceipt();

      state.reserveProducerReceipt(receipt, 0);
      for (let index = 0; index < 4; index += 1)
        state.appendRuntimeEvent(eventDraft());
      state.ackRuntimeEvents(state.getRuntimeEventStreamId(), "1");
      state.close();
      state = openHostState({
        stateDir,
        limits: SMALL_LIMITS,
        now: () => new Date(clock),
      });
      const unsubscribe = state.subscribeRuntimeCapacity((snapshot) =>
        snapshots.push(snapshot.pressured),
      );

      expect(state.runtimeEventOutboxStats().budget).toMatchObject({
        pressured: true,
        reservedControlRows: 18,
      });
      clock += SMALL_LIMITS.eventAckGraceMs + 1;
      state.pruneAcknowledgedRuntimeEvents(
        new Date(clock - SMALL_LIMITS.eventAckGraceMs),
      );
      expect(() => state.assertCanAcceptMutatingCommand()).toThrow(
        /low watermark/,
      );
      state.ackRuntimeEvents(state.getRuntimeEventStreamId(), "2");
      clock += SMALL_LIMITS.eventAckGraceMs + 1;
      state.pruneAcknowledgedRuntimeEvents(
        new Date(clock - SMALL_LIMITS.eventAckGraceMs),
      );
      expect(() => state.assertCanAcceptMutatingCommand()).not.toThrow();
      expect(snapshots).toEqual([true, true, false]);
      unsubscribe();
    } finally {
      state.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("migrates existing version 6 events into retained regular accounting without rewriting their envelopes", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "maister-outbox-v6-"));

    try {
      const state = openHostState({ stateDir });
      const first = state.appendRuntimeEvent(eventDraft());

      state.ackRuntimeEvents(state.getRuntimeEventStreamId(), "0");
      state.close();
      // Reconstruct the exact pre-budget schema with real persisted event bytes.
      const db = new DatabaseSync(join(stateDir, "state.sqlite"));

      db.exec(`UPDATE runtime_event_outbox SET acknowledged_at = (
          SELECT a.acknowledged_at FROM runtime_event_ack_ranges a WHERE a.stream_id = runtime_event_outbox.stream_id
            AND a.first_sort_key <= runtime_event_outbox.sequence_sort_key AND a.through_sort_key >= runtime_event_outbox.sequence_sort_key);
        DROP TRIGGER runtime_event_budget_insert; DROP TRIGGER runtime_event_budget_delete_v8;
        DROP TABLE runtime_event_ack_ranges; DROP TABLE runtime_event_budget;
        DROP TABLE runtime_event_frames; DROP TABLE runtime_event_teardowns;
        DROP TABLE runtime_event_wallets; DROP TABLE runtime_event_pressure;
        DROP INDEX command_receipts_pending_session;
        ALTER TABLE runtime_event_outbox DROP COLUMN budget_partition; PRAGMA user_version = 6;`);
      db.close();
      const upgraded = openHostState({ stateDir });

      expect(
        upgraded.runtimeEventsAfter(upgraded.getRuntimeEventStreamId(), null)[0]
          ?.envelope,
      ).toEqual(first.envelope);
      expect(upgraded.runtimeEventOutboxStats().budget.regular).toEqual({
        retainedCount: 1,
        retainedBytes: first.encodedBytes,
        unacknowledgedCount: 0,
        unacknowledgedBytes: 0,
      });
      upgraded.close();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("refuses admission when acknowledged replay still occupies the soft budget", () => {
    const state = openHostState({ inMemory: true, limits: SMALL_LIMITS });

    try {
      let lastSequence = "0";

      while (
        state.runtimeEventOutboxStats().retainedBytes <
        SMALL_LIMITS.eventSoftBytes
      ) {
        const input = eventDraft();
        const row = state.appendRuntimeEvent({
          ...input,
          draft: { ...input.draft, payload: { text: "x".repeat(6 * 1024) } },
        });

        lastSequence = row.sequence;
      }
      state.ackRuntimeEvents(state.getRuntimeEventStreamId(), lastSequence);
      expect(state.runtimeEventOutboxStats().unacknowledgedBytes).toBe(0);
      expect(() => state.assertCanAcceptMutatingCommand()).toThrow(
        /soft limit/,
      );
    } finally {
      state.close();
    }
  });

  it("allocates an atomic stream sequence and only acknowledges a contiguous prefix", () => {
    const state = openHostState({ inMemory: true });
    const first = state.appendRuntimeEvent(eventDraft());
    const second = state.appendRuntimeEvent(eventDraft("session.command"));
    const streamId = state.getRuntimeEventStreamId();

    expect(first.sequence).toBe("0");
    expect(second.sequence).toBe("1");
    expect(
      state.runtimeEventsAfter(streamId, null).map(({ sequence }) => sequence),
    ).toEqual(["0", "1"]);
    expect(state.ackRuntimeEvents(streamId, "1")).toBe("1");
    // Acknowledgement advances the host's durable delivery watermark without
    // destroying its replay window. A reconnect with an older Last-Event-ID
    // can therefore still be served; a fresh delivery loop asks for pending
    // events and observes none.
    expect(
      state.runtimeEventsAfter(streamId, null).map(({ sequence }) => sequence),
    ).toEqual(["0", "1"]);
    expect(state.pendingRuntimeEvents(streamId)).toEqual([]);
    state.close();
  });

  it("does not advance acknowledgement across a missing sequence", () => {
    const state = openHostState({ inMemory: true });
    const streamId = state.getRuntimeEventStreamId();

    state.appendRuntimeEvent(eventDraft());
    expect(() => state.ackRuntimeEvents(streamId, "4")).toThrow(/contiguous/i);
    state.close();
  });

  it("keeps the one host-global stream and unacknowledged replay across a supervisor restart", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "maister-event-outbox-"));

    try {
      const first = openHostState({ stateDir });
      const streamId = first.getRuntimeEventStreamId();

      first.appendRuntimeEvent(eventDraft());
      first.close();

      const restarted = openHostState({ stateDir });

      expect(restarted.getRuntimeEventStreamId()).toBe(streamId);
      expect(
        restarted
          .pendingRuntimeEvents(streamId)
          .map(({ sequence }) => sequence),
      ).toEqual(["0"]);
      restarted.close();
    } finally {
      rmSync(stateDir, { force: true, recursive: true });
    }
  });
});
