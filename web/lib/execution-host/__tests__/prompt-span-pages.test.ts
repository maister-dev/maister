// ADR-184 D3/D4: one pager reads a prompt span — canonically up to the
// manager's contiguous frontier, from the host above it — for the owner's
// output read and the settlement feed alike. Each case scripts the three
// readers (frontier, canonical page, host page) and asserts which source
// served which sequence, so a pager that ignores the frontier, retries a lost
// floor without an advance, or skips the signal rule on canonical rows fails
// here rather than in a load run.
import type { Logger } from "pino";
import type { ExecutionCommand, ExecutionEvent } from "@/lib/db/schema";
import type { CommandOutputManifestV2 } from "../../../../runtime/command-evidence";
import type {
  SpanReaders,
  SpanRow,
} from "@/lib/execution-host/prompt-span-pages";

import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { promptSpanPages, promptSpanReaders, SpanCanonicallyAvailable } =
  await import("@/lib/execution-host/prompt-span-pages");
const { HostSpanSignals, HostSpanUnavailable } = await import(
  "@/lib/execution-host/prompt-host-span"
);

const STREAM = "stream-row";
const SESSION = "host-session-1";
const ACCEPTED = 10;
const TERMINAL = 15;
const TERMINAL_ID = "terminal-event";
const command = {
  id: randomUUID(),
  runId: "run-1",
  executionHostId: "host-1",
  executionAssignmentId: "assignment-1",
  assignmentEpoch: 1,
} as ExecutionCommand;
const manifest = {
  hostSessionId: SESSION,
  acceptedSequence: String(ACCEPTED),
  terminalSequence: String(TERMINAL),
} as CommandOutputManifestV2;

function event(
  sequence: number,
  overrides: Partial<ExecutionEvent> = {},
): ExecutionEvent {
  const accepted = sequence === ACCEPTED;
  const terminal = sequence === TERMINAL;

  return {
    id: terminal ? TERMINAL_ID : `event-${sequence}`,
    source: "host",
    runId: command.runId,
    executionHostId: command.executionHostId,
    eventStreamId: STREAM,
    hostSequence: BigInt(sequence),
    executionAssignmentId: command.executionAssignmentId,
    assignmentEpoch: command.assignmentEpoch,
    hostSessionId: SESSION,
    eventType: accepted || terminal ? "session.command" : "session.update",
    payloadSchema: "maister.session.update.v1",
    payload: accepted
      ? { commandId: command.id, phase: "accepted", kind: "session.prompt" }
      : { sourceCommandId: command.id, sourceMonotonicId: sequence },
    payloadBytes: 64,
    ingestDisposition: "accepted",
    ...overrides,
  } as ExecutionEvent;
}

function range(from: number, through: number): ExecutionEvent[] {
  return Array.from({ length: through - from + 1 }, (_, i) => event(from + i));
}

type Script = {
  frontiers: Array<number | null>;
  canonical?: SpanRow[];
  host?: ExecutionEvent[];
  hostFloor?: number;
  hostPageSize?: number;
};

function readers(script: Script) {
  const calls: string[] = [];
  let frontierReads = 0;
  const readers: SpanReaders = {
    frontier: async () => {
      const value =
        script.frontiers[Math.min(frontierReads, script.frontiers.length - 1)];

      frontierReads += 1;

      return value === null ? null : BigInt(value);
    },
    canonicalPage: async (after, through) => {
      calls.push(`canonical(${after},${through}]`);

      return (script.canonical ?? []).filter(
        (row) =>
          (row.hostSequence ?? -1n) > after &&
          (row.hostSequence ?? -1n) <= through,
      );
    },
    hostPage: async (after, through) => {
      calls.push(`host(${after},${through}]`);
      // The readers resolve on microtasks, so a pager that retries without
      // end never reaches a timer (the abort signal would never fire).
      if (calls.length > 100) throw new Error("the pager loops on the host");
      if (script.hostFloor !== undefined && after < BigInt(script.hostFloor))
        throw new HostSpanUnavailable("replay_floor_lost");

      return (script.host ?? [])
        .filter(
          (row) =>
            (row.hostSequence ?? -1n) > after &&
            (row.hostSequence ?? -1n) <= through,
        )
        .slice(0, script.hostPageSize ?? 500);
    },
  };

  return { readers, calls };
}

function logger() {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  } as unknown as Logger & {
    info: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };
}

async function read(
  script: Script,
  mode: "canonical" | "fast" | "settlement" = "fast",
  log = logger(),
) {
  const { readers: spanReaders, calls } = readers(script);
  const terminal: { event: ExecutionEvent | null } = { event: null };
  const sequences: Array<bigint | null> = [];

  for await (const page of promptSpanPages({
    command,
    manifest,
    mode,
    readers: spanReaders,
    signal: AbortSignal.timeout(5_000),
    logger: log,
    terminal,
  }))
    for (const row of page) sequences.push(row.hostSequence);

  return { sequences, calls, terminal, log };
}

function refusal(causeCode: string) {
  return expect.objectContaining({
    details: { reason: "required_output_incomplete", causeCode },
  });
}

describe("prompt span pager (ADR-184)", () => {
  it("(a) reads the prefix up to the frontier canonically and only the rest from the host", async () => {
    const { sequences, calls } = await read({
      frontiers: [12],
      canonical: range(10, 15),
      host: range(13, 15),
      hostFloor: 12,
    });

    expect(sequences).toEqual([11n, 12n, 13n, 14n, 15n]);
    expect(calls).toEqual(["canonical(9,12]", "host(12,15]"]);
  });

  it("(b) switches to canonical pages once the frontier passes the cursor mid-read", async () => {
    const { sequences, calls } = await read({
      frontiers: [11, 11, 15],
      canonical: range(10, 15),
      host: range(12, 15),
      hostFloor: 11,
      hostPageSize: 1,
    });

    expect(sequences).toEqual([11n, 12n, 13n, 14n, 15n]);
    expect(calls).toEqual([
      "canonical(9,11]",
      "host(11,15]",
      "canonical(12,15]",
    ]);
  });

  it("(c) a floor the host pruned past the cursor is re-read from canonical when the frontier advanced", async () => {
    const log = logger();
    const { sequences, calls } = await read(
      {
        frontiers: [10, 10, 13],
        canonical: range(10, 15),
        host: range(13, 15),
        hostFloor: 13,
      },
      "fast",
      log,
    );

    expect(sequences).toEqual([11n, 12n, 13n, 14n, 15n]);
    expect(calls).toEqual([
      "canonical(9,10]",
      "host(10,15]",
      "canonical(10,13]",
      "host(13,15]",
    ]);
    expect(log.debug).toHaveBeenCalledWith(
      { commandId: command.id, cursor: "10", frontier: "13" },
      "prompt-span-floor-retry",
    );
  });

  it("(d) a lost floor without a frontier advance is a genuine loss, never retried", async () => {
    const { readers: spanReaders, calls } = readers({
      frontiers: [10],
      canonical: range(10, 15),
      host: range(13, 15),
      hostFloor: 13,
    });
    const pages = promptSpanPages({
      command,
      manifest,
      mode: "fast",
      readers: spanReaders,
      signal: AbortSignal.timeout(5_000),
      logger: logger(),
    });

    await expect(
      (async () => {
        for await (const page of pages) void page;
      })(),
    ).rejects.toMatchObject({ reason: "replay_floor_lost" });
    expect(calls).toEqual(["canonical(9,10]", "host(10,15]"]);
  });

  it("(d′) a null frontier reads the whole span from the host, as before", async () => {
    const { sequences, calls } = await read({
      frontiers: [null],
      host: range(10, 15),
    });

    expect(sequences).toEqual([11n, 12n, 13n, 14n, 15n]);
    expect(calls).toEqual(["host(9,15]"]);
  });

  it("(e) a sequence at or below the frontier present in neither table is a gap", async () => {
    await expect(
      read({ frontiers: [12], canonical: [event(10), event(12)] }),
    ).rejects.toEqual(refusal("event_span_gap"));
    await expect(
      read({ frontiers: [12], canonical: [], host: range(10, 15) }),
    ).rejects.toEqual(refusal("event_span_gap"));
  });

  it("(f) a frontier covering the terminal at the start never calls the host", async () => {
    const { sequences, calls, log } = await read(
      { frontiers: [20], canonical: range(10, 15), host: range(10, 15) },
      "canonical",
    );

    expect(sequences).toEqual([11n, 12n, 13n, 14n, 15n]);
    expect(calls).toEqual(["canonical(9,15]"]);
    expect(log.info).not.toHaveBeenCalled();
  });

  describe("settlement feed (D3.7: settled_from stays truthful)", () => {
    it("reads nothing when the frontier already covers the terminal", async () => {
      const { readers: spanReaders, calls } = readers({
        frontiers: [15],
        canonical: range(10, 15),
      });

      await expect(
        (async () => {
          for await (const page of promptSpanPages({
            command,
            manifest,
            mode: "settlement",
            readers: spanReaders,
            signal: AbortSignal.timeout(5_000),
            logger: logger(),
            terminal: { event: null },
          }))
            void page;
        })(),
      ).rejects.toBeInstanceOf(SpanCanonicallyAvailable);
      expect(calls).toEqual([]);
    });

    it("answers canonical_available when the frontier reached the terminal mid-read", async () => {
      await expect(
        read(
          {
            frontiers: [11, 11, 15],
            canonical: range(10, 15),
            host: range(12, 15),
            hostFloor: 11,
            hostPageSize: 1,
          },
          "settlement",
        ),
      ).rejects.toBeInstanceOf(SpanCanonicallyAvailable);
    });

    it("hands back the host's terminal row, and logs the mixed read once", async () => {
      const log = logger();
      const { terminal } = await read(
        {
          frontiers: [12],
          canonical: range(10, 15),
          host: range(13, 15),
          hostFloor: 12,
        },
        "settlement",
        log,
      );

      expect(terminal.event?.id).toBe(TERMINAL_ID);
      expect(log.info).toHaveBeenCalledTimes(1);
      expect(log.info).toHaveBeenCalledWith(
        {
          commandId: command.id,
          canonicalRows: 3,
          hostRows: 3,
          skippedRows: 0,
          frontierAtStart: "12",
          floorRetries: 0,
        },
        "prompt-span-read",
      );
    });
  });

  describe("signal rule over the whole span (D4)", () => {
    const signalRow = event(11, { eventType: "session.permission_request" });

    it("a fast read refuses an own-session signal row served canonically", async () => {
      await expect(
        read({
          frontiers: [12],
          canonical: [event(10), signalRow, event(12)],
          host: range(13, 15),
        }),
      ).rejects.toBeInstanceOf(HostSpanSignals);
    });

    it("a fast read refuses an own-session signal row served by the host", async () => {
      await expect(
        read({
          frontiers: [null],
          host: [event(10), signalRow, ...range(12, 15)],
        }),
      ).rejects.toBeInstanceOf(HostSpanSignals);
    });

    it("the canonical read does not refuse on signals (the canonical feed delivers them)", async () => {
      const { sequences } = await read(
        {
          frontiers: [20],
          canonical: [event(10), signalRow, ...range(12, 15)],
        },
        "canonical",
      );

      expect(sequences).toEqual([11n, 12n, 13n, 14n, 15n]);
    });

    it("another session's signal row is not the command's signal", async () => {
      const { sequences } = await read({
        frontiers: [12],
        canonical: [
          event(10),
          event(11, {
            eventType: "session.permission_request",
            hostSessionId: "another-session",
            runId: "another-run",
          }),
          event(12),
        ],
        host: range(13, 15),
      });

      expect(sequences).toEqual([11n, 12n, 13n, 14n, 15n]);
    });
  });

  describe("the accepted row", () => {
    it("a skipped accepted row is a gap (it is the prompt's own row)", async () => {
      await expect(
        read({
          frontiers: [12],
          canonical: [
            {
              skipped: true,
              eventId: "skip-10",
              hostSequence: 10n,
              runId: command.runId,
              eventType: "session.command",
              reason: "payload_unstorable",
            },
            event(11),
            event(12),
          ],
          host: range(13, 15),
        }),
      ).rejects.toEqual(refusal("event_span_gap"));
    });

    it("a canonical accepted row of another command is refused", async () => {
      await expect(
        read({
          frontiers: [12],
          canonical: [
            event(10, {
              payload: {
                commandId: randomUUID(),
                phase: "accepted",
                kind: "session.prompt",
              },
            }),
            event(11),
            event(12),
          ],
          host: range(13, 15),
        }),
      ).rejects.toEqual(refusal("accepted_binding"));
    });

    it("passes a foreign skipped row through for the verifier and counts it", async () => {
      const log = logger();
      const { sequences } = await read(
        {
          frontiers: [12],
          canonical: [
            event(10),
            {
              skipped: true,
              eventId: "skip-11",
              hostSequence: 11n,
              runId: "unknown-run",
              eventType: "session.update",
              reason: "unknown_run",
            },
            event(12),
          ],
          host: range(13, 15),
        },
        "fast",
        log,
      );

      expect(sequences).toEqual([11n, 12n, 13n, 14n, 15n]);
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ canonicalRows: 2, skippedRows: 1 }),
        "prompt-span-read",
      );
    });
  });
});

// R6: the canonical reader takes a page's headers, then its bodies. A row
// deleted in between is a gap in the span, typed like every other incomplete
// read — never an `undefined` row handed to the verifier.
describe("the canonical span reader", () => {
  it("an event deleted between its header read and its body read is event_span_gap", async () => {
    const results: unknown[][] = [
      [{ id: "event-11", hostSequence: 11n, bytes: 64 }],
      [],
      [],
    ];
    const query = (rows: unknown[]) => {
      const chain = {
        from: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => chain,
        then: (
          resolve: (value: unknown[]) => unknown,
          reject: (reason: unknown) => unknown,
        ) => Promise.resolve(rows).then(resolve, reject),
      };

      return chain;
    };
    const readers = promptSpanReaders({
      db: { select: () => query(results.shift()!) } as never,
      transport: {} as never,
      command,
      manifest,
      hostKey: "host-key",
      streamRowId: STREAM,
      signal: new AbortController().signal,
    });

    await expect(readers.canonicalPage(10n, 15n)).rejects.toMatchObject({
      code: "PRECONDITION",
      details: {
        reason: "required_output_incomplete",
        causeCode: "event_span_gap",
      },
    });
  });
});
