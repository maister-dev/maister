import "server-only";

import type { Db } from "./db";
import type { ExecutionHostTransport } from "./contracts";
import type { ExecutionEvent } from "@/lib/db/schema";

import {
  classifyEnvelopeDisposition,
  normalizeRuntimeEnvelope,
  runtimeEventPayloadBytes,
  runtimeEventPayloadSha256,
} from "./events/ingest";

import { MaisterError } from "@/lib/errors";

/** The host cannot serve the span now. Never a command outcome: the caller
 * keeps waiting for the canonical feed. */
export class HostSpanUnavailable extends MaisterError {
  constructor(readonly reason: string) {
    super("EXECUTOR_UNAVAILABLE", "host event span is unavailable", {
      details: { reason: "host_span_unavailable", spanReason: reason },
    });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** ADR-167 D5 amendment (D-B4): the host's retained envelopes for
 * `(after, through]`, paged and turned into the same row shape ingest would
 * store — same parse, same jsonb-safe escape, same payload digest and size,
 * same assignment disposition. Nothing is written: these rows are transient
 * evidence for one verification, never canonical events.
 *
 * Only rows of `hostSessionId` are classified against assignments; the
 * verifier reads every other row for contiguity alone, and classifying the
 * whole shared stream would cost one lookup per other run's event.
 */
export async function* hostSpanPages(input: {
  db: Db;
  transport: ExecutionHostTransport;
  executionHostId: string;
  hostKey: string;
  streamId: string;
  streamRowId: string;
  hostSessionId: string;
  after: bigint;
  through: bigint;
  signal: AbortSignal;
}): AsyncGenerator<ExecutionEvent[]> {
  // A span starting at the stream's first event has no expressible lower bound.
  if (input.after < 0n) throw new HostSpanUnavailable("stream_origin");
  let after = input.after.toString();
  const through = input.through.toString();

  for (;;) {
    input.signal.throwIfAborted();
    const page = await input.transport.readRuntimeEventSpan({
      streamId: input.streamId,
      after,
      through,
      signal: input.signal,
    });

    if (page.state === "unavailable")
      throw new HostSpanUnavailable(page.reason);
    const events: ExecutionEvent[] = [];

    for (const raw of page.events) {
      const envelope = normalizeRuntimeEnvelope(raw);
      const own = envelope.hostSessionId === input.hostSessionId;
      const classified = own
        ? await classifyEnvelopeDisposition(
            input.db,
            input.executionHostId,
            envelope,
          )
        : { assignmentId: null, disposition: "accepted" as const };

      if (
        envelope.hostKey !== input.hostKey ||
        envelope.streamId !== input.streamId
      )
        throw new HostSpanUnavailable("identity_mismatch");
      events.push({
        id: envelope.eventId,
        source: "host",
        sourceKey: null,
        runId: envelope.runId,
        executionHostId: input.executionHostId,
        eventStreamId: input.streamRowId,
        hostSequence: BigInt(envelope.sequence),
        executionAssignmentId: classified.assignmentId,
        assignmentEpoch: envelope.assignmentEpoch,
        runSessionIncarnationId: null,
        hostBootId: envelope.hostBootId,
        hostSessionId: envelope.hostSessionId,
        envelopeVersion: envelope.envelopeVersion,
        eventType: envelope.eventType,
        payloadSchema: envelope.payloadSchema,
        payload: envelope.payload,
        payloadSha256: runtimeEventPayloadSha256(envelope.payload),
        payloadBytes: runtimeEventPayloadBytes(envelope.payload),
        occurredAt: new Date(envelope.occurredAt),
        receivedAt: new Date(),
        runSequence: null,
        ingestDisposition: classified.disposition,
        ingestError: null,
      });
    }
    if (events.length > 0) yield events;
    if (page.state === "complete") return;
    // A cursor that does not advance to this page's last row would re-read
    // the same page until the caller's abort.
    if (
      page.nextAfter === null ||
      page.nextAfter !== page.events.at(-1)?.sequence ||
      BigInt(page.nextAfter) <= BigInt(after)
    )
      throw new HostSpanUnavailable("page_cursor");
    after = page.nextAfter;
  }
}
