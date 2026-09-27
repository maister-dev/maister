import "server-only";

import type { Logger } from "pino";
import type { Db } from "./db";
import type { ExecutionHostTransport } from "./contracts";
import type { ExecutionCommand, ExecutionEvent } from "@/lib/db/schema";
import type { CommandOutputManifestV2 } from "../../../runtime/command-evidence";

import { and, asc, eq, gt, inArray, lte } from "drizzle-orm";
import pino from "pino";

import {
  HostSpanSignals,
  HostSpanUnavailable,
  hostSpanPages,
} from "./prompt-host-span";
import { CONSUMER_SIGNAL_EVENT_TYPES } from "./prompt-signal-events";

import {
  executionEventSkips,
  executionEventStreams,
  executionEvents,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "prompt-span-pages",
  level: process.env.LOG_LEVEL ?? "info",
});
const CANONICAL_PAGE_ROWS = 100;
const PAGE_BYTES = 1_048_576;

export function incomplete(causeCode: string): MaisterError {
  return new MaisterError(
    "PRECONDITION",
    "original command output is incomplete",
    {
      details: { reason: "required_output_incomplete", causeCode },
    },
  );
}

/** A sequence ingest stepped over (`execution_event_skips`). It has no row in
 * `execution_events`, so a canonical span read carries its skip-ledger entry
 * in its place; the verifier decides whether it may fill contiguity. */
export type SkippedSpanRow = Readonly<{
  skipped: true;
  eventId: string;
  hostSequence: bigint;
  runId: string;
  eventType: string;
  reason: "unknown_run" | "payload_unstorable";
}>;

export type SpanRow = ExecutionEvent | SkippedSpanRow;

export function isSkippedSpanRow(row: SpanRow): row is SkippedSpanRow {
  return "skipped" in row;
}

export type SpanReaders = {
  /** The stream row's `last_contiguous_sequence`, read fresh. */
  frontier(): Promise<bigint | null>;
  /** One bounded canonical page of `(after, through]`, events and skips. */
  canonicalPage(after: bigint, through: bigint): Promise<SpanRow[]>;
  /** One host page of `(after, through]`, normalized like ingested rows. */
  hostPage(after: bigint, through: bigint): Promise<ExecutionEvent[]>;
};

/** The settlement feed found the span's terminal in the canonical log: the
 * canonical feed settles it, so a `host_span` settlement never names a row
 * the host did not serve (ADR-184 D3.7). Never leaves the settlement feed. */
export class SpanCanonicallyAvailable extends Error {
  constructor() {
    super("the span's terminal is in the canonical log");
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function assertAcceptedBinding(
  accepted: SpanRow | undefined,
  command: ExecutionCommand,
  manifest: CommandOutputManifestV2,
): void {
  if (accepted && isSkippedSpanRow(accepted))
    throw incomplete("event_span_gap");
  if (
    !accepted ||
    accepted.hostSequence !== BigInt(manifest.acceptedSequence) ||
    accepted.hostSessionId !== manifest.hostSessionId ||
    accepted.runId !== command.runId ||
    accepted.executionAssignmentId !== command.executionAssignmentId ||
    accepted.assignmentEpoch !== command.assignmentEpoch ||
    accepted.payload?.commandId !== command.id ||
    accepted.payload.phase !== "accepted" ||
    accepted.payload.kind !== "session.prompt"
  )
    throw incomplete("accepted_binding");
}

/** ADR-184 D3: one reader for a prompt span `[accepted, terminal]`, whoever
 * reads it. The host keeps every row above the manager's contiguous frontier
 * (host floor ≤ host ACK ≤ `last_contiguous_sequence`), so the prefix up to
 * the frontier comes from Postgres and only the rest from the host; the
 * frontier is re-read before every page because ingest moves it meanwhile.
 *
 * Modes: `canonical` — the frontier covered the terminal when the read
 * started, the feed of record; `fast` — the owner's output read ahead of
 * the frontier, which refuses a span carrying a consumer signal (D4);
 * `settlement` — the host-span settlement feed: `fast`, plus nothing is read
 * when the canonical log already holds the terminal (D3.7), and `terminal`
 * receives the host's terminal row.
 *
 * Yields the span strictly after its accepted row, which is checked here. */
export async function* promptSpanPages(input: {
  command: ExecutionCommand;
  manifest: CommandOutputManifestV2;
  mode: "canonical" | "fast" | "settlement";
  readers: SpanReaders;
  signal: AbortSignal;
  logger?: Logger;
  terminal?: { event: ExecutionEvent | null };
}): AsyncGenerator<SpanRow[]> {
  const { command, manifest, mode, readers, signal } = input;
  const logger = input.logger ?? log;
  const accepted = BigInt(manifest.acceptedSequence);
  const terminal = BigInt(manifest.terminalSequence);
  const counts = { canonicalRows: 0, hostRows: 0, skippedRows: 0 };
  let cursor = accepted - 1n;
  let frontierAtStart: bigint | null | undefined;
  let floorRetries = 0;
  let hostReads = 0;
  let terminalFromHost = false;

  while (cursor < terminal) {
    signal.throwIfAborted();
    const frontier = (await readers.frontier()) ?? -1n;

    if (frontierAtStart === undefined) {
      frontierAtStart = frontier;
      if (mode === "settlement" && frontier >= terminal)
        throw new SpanCanonicallyAvailable();
    }
    let rows: SpanRow[];
    let fromHost = false;

    if (cursor < frontier) {
      rows = await readers.canonicalPage(
        cursor,
        frontier < terminal ? frontier : terminal,
      );
    } else {
      hostReads += 1;
      try {
        rows = await readers.hostPage(cursor, terminal);
        fromHost = true;
      } catch (error) {
        if (
          !(error instanceof HostSpanUnavailable) ||
          error.reason !== "replay_floor_lost"
        )
          throw error;
        // The host pruned past the cursor after the frontier was read. Only a
        // frontier that has since passed the cursor makes those rows canonical;
        // otherwise the rows are gone from both sides (a restore, W3).
        const advanced = (await readers.frontier()) ?? -1n;

        if (advanced <= cursor) throw error;
        floorRetries += 1;
        logger.debug(
          {
            commandId: command.id,
            cursor: cursor.toString(),
            frontier: advanced.toString(),
          },
          "prompt-span-floor-retry",
        );
        continue;
      }
    }
    if (rows.length === 0) throw incomplete("event_span_gap");
    for (const row of rows) {
      if (row.hostSequence !== cursor + 1n) throw incomplete("event_span_gap");
      cursor = row.hostSequence;
      if (isSkippedSpanRow(row)) counts.skippedRows += 1;
      else if (fromHost) counts.hostRows += 1;
      else counts.canonicalRows += 1;
    }
    if (mode !== "canonical")
      for (const row of rows)
        if (
          !isSkippedSpanRow(row) &&
          row.hostSessionId === manifest.hostSessionId &&
          (CONSUMER_SIGNAL_EVENT_TYPES as readonly string[]).includes(
            row.eventType,
          )
        )
          throw new HostSpanSignals(row.eventType);
    if (rows[0]!.hostSequence === accepted)
      assertAcceptedBinding(rows[0], command, manifest);
    const last = rows.at(-1)!;

    if (last.hostSequence === terminal) {
      terminalFromHost = fromHost;
      if (input.terminal && !isSkippedSpanRow(last))
        input.terminal.event = last;
    }
    const rest = rows.filter((row) => row.hostSequence !== accepted);

    if (rest.length > 0) yield rest;
  }
  if (mode === "settlement" && !terminalFromHost)
    throw new SpanCanonicallyAvailable();
  if (hostReads > 0)
    logger.info(
      {
        commandId: command.id,
        ...counts,
        frontierAtStart: (frontierAtStart ?? -1n).toString(),
        floorRetries,
      },
      "prompt-span-read",
    );
}

/** The production readers over the manager's stream row and the host. */
export function promptSpanReaders(input: {
  db: Db;
  transport: ExecutionHostTransport;
  command: ExecutionCommand;
  manifest: CommandOutputManifestV2;
  hostKey: string;
  streamRowId: string;
  signal: AbortSignal;
}): SpanReaders {
  const { db, streamRowId } = input;

  return {
    async frontier() {
      const [row] = await db
        .select({ last: executionEventStreams.lastContiguousSequence })
        .from(executionEventStreams)
        .where(eq(executionEventStreams.id, streamRowId))
        .limit(1);

      return row?.last ?? null;
    },
    async canonicalPage(after, through) {
      const [headers, skips] = await Promise.all([
        db
          .select({
            id: executionEvents.id,
            hostSequence: executionEvents.hostSequence,
            bytes: executionEvents.payloadBytes,
          })
          .from(executionEvents)
          .where(
            and(
              eq(executionEvents.eventStreamId, streamRowId),
              gt(executionEvents.hostSequence, after),
              lte(executionEvents.hostSequence, through),
            ),
          )
          .orderBy(asc(executionEvents.hostSequence))
          .limit(CANONICAL_PAGE_ROWS),
        db
          .select()
          .from(executionEventSkips)
          .where(
            and(
              eq(executionEventSkips.eventStreamId, streamRowId),
              gt(executionEventSkips.hostSequence, after),
              lte(executionEventSkips.hostSequence, through),
            ),
          )
          .orderBy(asc(executionEventSkips.hostSequence))
          .limit(CANONICAL_PAGE_ROWS),
      ]);
      const merged = [
        ...headers.map((header) => ({ kind: "event" as const, ...header })),
        ...skips.map((skip) => ({
          kind: "skip" as const,
          hostSequence: skip.hostSequence,
          row: {
            skipped: true as const,
            eventId: skip.eventId,
            hostSequence: skip.hostSequence,
            runId: skip.runId,
            eventType: skip.eventType,
            reason: skip.reason,
          },
        })),
      ].sort((a, b) =>
        a.hostSequence! < b.hostSequence!
          ? -1
          : a.hostSequence! > b.hostSequence!
            ? 1
            : 0,
      );
      const taken: typeof merged = [];
      let pageBytes = 0;

      for (const item of merged.slice(0, CANONICAL_PAGE_ROWS)) {
        if (item.kind === "event") {
          if (item.bytes === null || item.bytes > PAGE_BYTES)
            throw incomplete("event_size");
          if (pageBytes + item.bytes > PAGE_BYTES) break;
          pageBytes += item.bytes;
        }
        taken.push(item);
      }
      const ids = taken.flatMap((item) =>
        item.kind === "event" ? [item.id] : [],
      );
      const events =
        ids.length === 0
          ? []
          : await db
              .select()
              .from(executionEvents)
              .where(inArray(executionEvents.id, ids));
      const byId = new Map(events.map((event) => [event.id, event]));

      return taken.map((item) =>
        item.kind === "skip" ? item.row : byId.get(item.id)!,
      );
    },
    async hostPage(after, through) {
      const pages = hostSpanPages({
        db,
        transport: input.transport,
        executionHostId: input.command.executionHostId,
        hostKey: input.hostKey,
        streamId: input.manifest.streamId,
        streamRowId,
        hostSessionId: input.manifest.hostSessionId,
        after,
        through,
        signal: input.signal,
      });

      try {
        const page = await pages.next();

        return page.done ? [] : page.value;
      } finally {
        await pages.return(undefined);
      }
    },
  };
}
