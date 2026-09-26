import type { Logger } from "pino";

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import {
  openHostState,
  startRuntimeEventPruner,
  type CommandReceiptRow,
  type HostState,
} from "../host-state";
import {
  DEFAULT_RUNTIME_LIMITS,
  validateRuntimeLimits,
} from "../runtime-limits";

import { waitFor } from "./_fixtures/boot-host";

// ADR-183: small ROW budgets (bytes stay at the defaults, far away) so a test
// crosses soft with a few hundred tiny events.
const LIMITS = validateRuntimeLimits({
  ...DEFAULT_RUNTIME_LIMITS,
  eventLowRows: 640,
  eventSoftRows: 800,
  eventHardRows: 1000,
});

const RUN_ID = "run-outbox-pressure";
const ASSIGNMENT_ID = "b213c794-fa0a-4907-ae7c-2cf2c2e8f87a";

function eventDraft(
  eventType: "session.created" | "session.command" = "session.created",
) {
  return {
    draft: {
      runId: RUN_ID,
      assignmentId: ASSIGNMENT_ID,
      assignmentEpoch: 1,
      hostSessionId: "9f314433-b7e9-49b9-baf7-3a23879eae68",
      eventType,
      occurredAt: "2026-09-26T12:00:00.000Z",
      payload: { sourceMonotonicId: 1 },
    },
    terminal: eventType === "session.command",
  };
}

function promptReceipt(
  overrides: Partial<CommandReceiptRow> = {},
): CommandReceiptRow {
  return {
    commandId: randomUUID(),
    runId: RUN_ID,
    kind: "session.prompt",
    assignmentId: ASSIGNMENT_ID,
    epoch: 1,
    hostSessionId: null,
    requestDigest: "digest",
    eventId: null,
    phase: "accepted",
    httpStatus: 202,
    body: {},
    receivedAt: "2026-09-26T12:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

// A `new_work` admission: the receipt write runs the soft + hard gate.
function admitNewWork(state: HostState): void {
  state.putReceipt(promptReceipt(), { kind: "new_work" });
}

function appendBatch(state: HostState, count: number): string {
  let last = "";

  for (let index = 0; index < count; index += 1)
    last = state.appendRuntimeEvent(eventDraft()).sequence;

  return last;
}

function regularRetained(state: HostState): number {
  return state.runtimeEventOutboxStats().budget.regular.retainedCount;
}

type LogLine = Record<string, unknown> & { msg: string };

function captureLogger(): { logger: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const logger = pino(
    { level: "debug" },
    { write: (line: string) => lines.push(JSON.parse(line) as LogLine) },
  );

  return { logger, lines };
}

const cleanups: Array<() => void> = [];

async function settle(rounds = 50): Promise<void> {
  for (let index = 0; index < rounds; index += 1)
    await new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function openStore(logger: Logger): { state: HostState; stateDir: string } {
  const stateDir = mkdtempSync(join(tmpdir(), "maister-outbox-semantics-"));
  const state = openHostState({ stateDir, limits: LIMITS, logger });

  cleanups.push(() => {
    state.close();
    rmSync(stateDir, { recursive: true, force: true });
  });

  return { state, stateDir };
}

describe("ADR-183 outbox pressure semantics", () => {
  it("B1: a fully-ACKed stream never pressures; retained rows are pruned before grace instead", async () => {
    const { logger, lines } = captureLogger();
    const { state } = openStore(logger);
    const stopPruner = startRuntimeEventPruner(state, logger);

    cleanups.push(stopPruner);
    const streamId = state.getRuntimeEventStreamId();
    let committed = 0;

    // 3× the soft budget, ACKed batch by batch like a caught-up manager.
    while (committed < LIMITS.eventSoftRows * 3) {
      const last = appendBatch(state, 50);

      committed += 50;
      state.ackRuntimeEvents(streamId, last);
      expect(state.runtimeEventHealthSnapshot().pressured).toBe(false);
      expect(() => admitNewWork(state)).not.toThrow();
      // Appends here never yield on their own (production appends arrive from
      // I/O callbacks), so give the pruner a turn every batch; the pass runs
      // off the commit that crossed soft and yields between pages.
      await new Promise((resolve) => setImmediate(resolve));
      await waitFor(
        () => regularRetained(state) < LIMITS.eventSoftRows,
        5_000,
        5,
      );
    }
    await settle();

    const snapshot = state.runtimeEventHealthSnapshot();

    expect(snapshot).toMatchObject({ pressured: false, pressure: null });
    expect(
      lines.filter((line) => line.msg === "outbox-pressure-changed"),
    ).toHaveLength(0);
    const episodes = lines.filter(
      (line) => line.msg === "outbox-retained-pressure-prune",
    );

    // One line per retained episode (soft → below low), and each episode
    // pruned down to the low budget, never below the rows it could not see.
    expect(episodes.length).toBeGreaterThanOrEqual(2);
    for (const episode of episodes) {
      expect(episode.retainedBefore as number).toBeGreaterThanOrEqual(
        LIMITS.eventSoftRows,
      );
      expect(episode.retainedAfter as number).toBeLessThan(LIMITS.eventLowRows);
      expect(episode.pruned as number).toBeGreaterThan(0);
      expect(episode.pages as number).toBeGreaterThanOrEqual(1);
    }
    expect(
      lines.filter(
        (line) => line.msg === "outbox-retained-pressure-prune-stalled",
      ),
    ).toHaveLength(0);
  });

  it("B2: unACKed rows at soft pressure the host with an episode; an ACK below low clears it without any prune", () => {
    const { logger, lines } = captureLogger();
    const { state, stateDir } = openStore(logger);
    const streamId = state.getRuntimeEventStreamId();
    const before = Date.now();
    const last = appendBatch(state, LIMITS.eventSoftRows);

    const pressured = state.runtimeEventHealthSnapshot();

    expect(pressured.pressured).toBe(true);
    expect(pressured.pressure).not.toBeNull();
    expect(pressured.pressure?.unacknowledgedCountAtStart).toBe(
      LIMITS.eventSoftRows,
    );
    expect(pressured.pressure?.episodes).toBe(0);
    expect(Date.parse(pressured.pressure?.since ?? "")).toBeGreaterThanOrEqual(
      before - 1,
    );
    expect(() => admitNewWork(state)).toThrow(/soft limit/);
    const entered = lines.filter(
      (line) => line.msg === "outbox-pressure-changed",
    );

    expect(entered).toHaveLength(1);
    expect(entered[0]).toMatchObject({
      pressured: true,
      unacknowledgedCount: LIMITS.eventSoftRows,
      episodes: 0,
    });

    // Hysteresis: an ACK that leaves unACKed rows at or above low keeps it.
    state.ackRuntimeEvents(
      streamId,
      String(LIMITS.eventSoftRows - LIMITS.eventLowRows - 1),
    );
    expect(state.runtimeEventHealthSnapshot().pressured).toBe(true);

    // Relief is an ACK — no pruner is running and nothing was pruned.
    state.ackRuntimeEvents(streamId, last);
    const cleared = state.runtimeEventHealthSnapshot();

    expect(cleared).toMatchObject({ pressured: false, pressure: null });
    expect(regularRetained(state)).toBe(LIMITS.eventSoftRows);
    expect(regularRetained(state)).toBeGreaterThanOrEqual(LIMITS.eventLowRows);
    expect(() => admitNewWork(state)).not.toThrow();
    const changes = lines.filter(
      (line) => line.msg === "outbox-pressure-changed",
    );

    expect(changes).toHaveLength(2);
    expect(changes[1]).toMatchObject({ pressured: false, episodes: 1 });

    // The episode counter is durable host state (SQLite v14).
    state.close();
    cleanups.pop();
    const reopened = openHostState({ stateDir, limits: LIMITS, logger });

    cleanups.push(() => {
      reopened.close();
      rmSync(stateDir, { recursive: true, force: true });
    });
    // Make room under hard first: every row is ACKed, so a retained-pressure
    // page loop may drop them all before their grace.
    while (
      reopened.pruneAcknowledgedRuntimeEvents(new Date(), {
        mode: "retained_pressure",
      }) > 0
    );
    expect(regularRetained(reopened)).toBe(0);
    const again = appendBatch(reopened, LIMITS.eventSoftRows);

    expect(reopened.runtimeEventHealthSnapshot().pressure?.episodes).toBe(1);
    reopened.ackRuntimeEvents(streamId, again);
    expect(reopened.runtimeEventHealthSnapshot()).toMatchObject({
      pressured: false,
      pressure: null,
    });
  });

  it("B2: an open episode survives a restart with its original start", () => {
    const { logger } = captureLogger();
    const { state, stateDir } = openStore(logger);

    appendBatch(state, LIMITS.eventSoftRows);
    const since = state.runtimeEventHealthSnapshot().pressure?.since;

    expect(since).toBeDefined();
    state.close();
    cleanups.pop();
    const reopened = openHostState({ stateDir, limits: LIMITS, logger });

    cleanups.push(() => {
      reopened.close();
      rmSync(stateDir, { recursive: true, force: true });
    });
    expect(reopened.runtimeEventHealthSnapshot()).toMatchObject({
      pressured: true,
      pressure: { since, unacknowledgedCountAtStart: LIMITS.eventSoftRows },
    });
  });

  it("B2: stream.pressured ignores retained rows at the hard budget and keeps refusing new work there", () => {
    const { logger } = captureLogger();
    const { state } = openStore(logger);
    const streamId = state.getRuntimeEventStreamId();

    // ACK every batch, never prune: retained climbs to hard with zero unACKed.
    while (regularRetained(state) < LIMITS.eventHardRows) {
      const last = appendBatch(
        state,
        Math.min(100, LIMITS.eventHardRows - regularRetained(state)),
      );

      state.ackRuntimeEvents(streamId, last);
    }
    expect(state.runtimeEventHealthSnapshot().pressured).toBe(false);
    expect(() => admitNewWork(state)).toThrow(/hard limit/);
  });
});

function streamRow(stateDir: string): {
  replay_floor_sequence: string | null;
  replay_floor_sort_key: string | null;
  acknowledged_through: string | null;
} {
  const db = new DatabaseSync(join(stateDir, "state.sqlite"), {
    readOnly: true,
  });

  try {
    return db
      .prepare(
        "SELECT replay_floor_sequence, replay_floor_sort_key, acknowledged_through FROM runtime_event_streams",
      )
      .get() as {
      replay_floor_sequence: string | null;
      replay_floor_sort_key: string | null;
      acknowledged_through: string | null;
    };
  } finally {
    db.close();
  }
}

function ackRangesThroughAtOrBelow(stateDir: string, sortKey: string): number {
  const db = new DatabaseSync(join(stateDir, "state.sqlite"), {
    readOnly: true,
  });

  try {
    return (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM runtime_event_ack_ranges WHERE through_sort_key <= ?",
        )
        .get(sortKey) as { n: number }
    ).n;
  } finally {
    db.close();
  }
}

describe("ADR-183 retained-pressure prune: protected spans, floor, paging", () => {
  it("B3a/B3b/B3c: stops at an unsettled v2 span, keeps the floor under the manager watermark, and prunes ACK ranges with the rows", async () => {
    const { logger, lines } = captureLogger();
    const { state, stateDir } = openStore(logger);
    const streamId = state.getRuntimeEventStreamId();
    const stopPruner = startRuntimeEventPruner(state, logger);

    cleanups.push(stopPruner);
    // 200 + 1 + 700 rows stay under hard (1000); the appends never yield, so
    // the prune starts after the ACK below.
    appendBatch(state, 200);
    // An accepted v2 prompt whose terminal is not written: it owns every row
    // from its accepted sequence on.
    const accepted = state.putReceiptWithRuntimeEvent(
      promptReceipt({ requestVersion: 2 }),
      eventDraft("session.command"),
      { kind: "new_work" },
    );
    let last = appendBatch(state, 700);

    state.ackRuntimeEvents(streamId, last);
    await waitFor(() => regularRetained(state) <= 701, 5_000, 5);
    await settle();

    const floor = streamRow(stateDir);

    // B3a: everything before the span went, nothing at or after it.
    expect(regularRetained(state)).toBe(701);
    expect(
      state.runtimeEventsAfter(streamId, floor.replay_floor_sequence, 1)[0]
        ?.sequence,
    ).toBe(accepted.sequence);
    // B3b: the floor is the last DELETED sequence, never past the watermark.
    expect(floor.replay_floor_sequence).toBe(
      String(BigInt(accepted.sequence) - 1n),
    );
    expect(BigInt(floor.replay_floor_sequence ?? "-1")).toBeLessThanOrEqual(
      BigInt(floor.acknowledged_through ?? "-1"),
    );
    expect(() =>
      state.runtimeEventsAfter(
        streamId,
        String(BigInt(floor.replay_floor_sequence ?? "0") - 1n),
      ),
    ).toThrow(/below the retained floor/);
    expect(
      state.runtimeEventsAfter(streamId, floor.replay_floor_sequence, 1),
    ).toHaveLength(1);
    // B3c: no ACK range survives wholly below the floor.
    expect(
      ackRangesThroughAtOrBelow(stateDir, floor.replay_floor_sort_key ?? ""),
    ).toBe(0);

    // Only the span remains: more ACKed traffic still prunes nothing, and the
    // stall is reported once for the episode.
    for (let round = 0; round < 3; round += 1) {
      last = appendBatch(state, 10);
      state.ackRuntimeEvents(streamId, last);
      await settle();
    }
    expect(regularRetained(state)).toBe(731);
    const stalled = lines.filter(
      (line) => line.msg === "outbox-retained-pressure-prune-stalled",
    );

    expect(stalled).toHaveLength(1);
    expect(stalled[0]).toMatchObject({
      protectedFromSequence: accepted.sequence,
      acknowledgedThrough: expect.any(String),
    });
    expect(state.runtimeEventHealthSnapshot().pressured).toBe(false);
  });

  it("B3d: a 20 000-row retained prune takes ≥ 200 bounded pages and an ACK commits between them", async () => {
    const limits = validateRuntimeLimits({
      ...DEFAULT_RUNTIME_LIMITS,
      eventLowRows: 1,
      eventSoftRows: 20_000,
      eventHardRows: 25_000,
    });
    const { logger, lines } = captureLogger();
    const stateDir = mkdtempSync(join(tmpdir(), "maister-outbox-paging-"));
    const state = openHostState({ stateDir, limits, logger });

    cleanups.push(() => {
      state.close();
      rmSync(stateDir, { recursive: true, force: true });
    });
    const streamId = state.getRuntimeEventStreamId();
    let last = "";

    // Appends and ACKs happen before the pruner exists, so the whole prune is
    // one retained-pressure pass started by the pruner's own boot check.
    for (let batch = 0; batch < 20; batch += 1) {
      last = appendBatch(state, 1_000);
      state.ackRuntimeEvents(streamId, last);
    }
    const stopPruner = startRuntimeEventPruner(state, logger);

    cleanups.push(stopPruner);
    await waitFor(() => regularRetained(state) < 20_000, 5_000, 1);
    // Mid-prune: schedule one append + ACK and time it to its commit.
    const scheduledAt = performance.now();
    const committed = await new Promise<{ ms: number; retained: number }>(
      (resolve) =>
        setTimeout(() => {
          const sequence = state.appendRuntimeEvent(eventDraft()).sequence;

          state.ackRuntimeEvents(streamId, sequence);
          resolve({
            ms: performance.now() - scheduledAt,
            retained: regularRetained(state),
          });
        }, 0),
    );

    expect(committed.ms).toBeLessThan(250);
    // It committed while the pass was still running, not after it.
    expect(committed.retained).toBeGreaterThan(100);
    // The episode line follows the pass's final (empty) page.
    await waitFor(
      () => lines.some((line) => line.msg === "outbox-retained-pressure-prune"),
      30_000,
      5,
    );
    expect(regularRetained(state)).toBe(0);
    const episode = lines.find(
      (line) => line.msg === "outbox-retained-pressure-prune",
    );

    expect(episode).toBeDefined();
    expect(episode?.pages as number).toBeGreaterThanOrEqual(200);
    expect(episode?.pruned as number).toBe(20_001);
    const pageLines = lines.filter(
      (line) =>
        line.msg === "runtime-event-outbox-pruned" &&
        line.mode === "retained_pressure",
    );

    expect(pageLines.every((line) => (line.pruned as number) <= 100)).toBe(
      true,
    );
  });
});
