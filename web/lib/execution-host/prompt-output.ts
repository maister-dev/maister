import "server-only";

import type { Db } from "./db";
import type { ExecutionHostTransport } from "./contracts";
import type { ExecutionCommand, ExecutionEvent } from "@/lib/db/schema";
import type {
  CommandOutputManifestV2,
  CommandReceiptV2,
  ImmutableObjectReference,
} from "../../../runtime/command-evidence";

import { createHash } from "node:crypto";

import { and, asc, eq, gt, inArray, lte, sql } from "drizzle-orm";

import {
  parseCommandOutputManifestV2,
  parseCommandOutputReferenceV2,
} from "../../../runtime/command-evidence";

import { getCommand } from "./commands";
import { defaultTransport } from "./default-transport";
import { readPromptRequest } from "./command-request";
import {
  SessionContentReferenceSchema,
  sessionContentSource,
} from "./runtime-events";
import { reconcileStoredPromptEvidence } from "./prompt-evidence";
import { HostSpanUnavailable, hostSpanPages } from "./prompt-host-span";
import { CONSUMER_SIGNAL_EVENT_TYPES } from "./prompt-signal-events";

import {
  executionEvents,
  executionEventStreams,
  executionHosts,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

function incomplete(causeCode: string): MaisterError {
  return new MaisterError(
    "PRECONDITION",
    "original command output is incomplete",
    {
      details: { reason: "required_output_incomplete", causeCode },
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read one bounded immutable object. No byte or parsed-value cache survives
 * this call; command replay always checks the original size and digest.
 */
async function readObjectJson(
  transport: ExecutionHostTransport,
  reference: ImmutableObjectReference,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  signal.throwIfAborted();
  if (reference.sizeBytes > 2_097_152) throw incomplete("object_size");
  const metadata = await transport.getRuntimeObject(reference.objectId);

  if (
    !metadata ||
    metadata.state !== "available" ||
    metadata.generation !== reference.generation ||
    metadata.sizeBytes !== reference.sizeBytes ||
    metadata.sha256 !== reference.sha256
  )
    throw incomplete("object_metadata");
  const response = await transport.openRuntimeObjectContent(
    reference.objectId,
    { signal },
  );
  const reader = response.body.getReader();
  let completed = false;

  try {
    if (
      response.contentRange !== null ||
      response.contentLength !== reference.sizeBytes
    )
      throw incomplete("object_length");
    const bytes = new Uint8Array(reference.sizeBytes);
    const hash = createHash("sha256");
    let offset = 0;

    for (;;) {
      const next = await reader.read();

      if (next.done) {
        completed = true;
        break;
      }
      if (offset + next.value.byteLength > bytes.byteLength)
        throw incomplete("object_length");
      bytes.set(next.value, offset);
      hash.update(next.value);
      offset += next.value.byteLength;
    }
    if (offset !== bytes.byteLength || hash.digest("hex") !== reference.sha256)
      throw incomplete("object_digest");
    let value: unknown;

    try {
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      throw incomplete("object_json");
    }
    if (!isRecord(value)) throw incomplete("object_shape");

    return value;
  } finally {
    if (!completed) await reader.cancel();
    reader.releaseLock();
  }
}

/** Canonical rows of `(acceptedSequence, terminalSequence]`, in bounded pages. */
async function* canonicalPages(input: {
  db: Db;
  manifest: CommandOutputManifestV2;
  streamRowId: string;
  signal: AbortSignal;
}): AsyncGenerator<ExecutionEvent[]> {
  const { db, manifest, streamRowId, signal } = input;
  const terminal = BigInt(manifest.terminalSequence);
  let cursor = BigInt(manifest.acceptedSequence);

  while (cursor < terminal) {
    signal.throwIfAborted();
    const headers = await db
      .select({ id: executionEvents.id, bytes: executionEvents.payloadBytes })
      .from(executionEvents)
      .where(
        and(
          eq(executionEvents.eventStreamId, streamRowId),
          gt(executionEvents.hostSequence, cursor),
          lte(executionEvents.hostSequence, terminal),
        ),
      )
      .orderBy(asc(executionEvents.hostSequence))
      .limit(100);
    const ids: string[] = [];
    let pageBytes = 0;

    for (const header of headers) {
      if (header.bytes === null || header.bytes > 1_048_576)
        throw incomplete("event_size");
      if (pageBytes + header.bytes > 1_048_576) break;
      pageBytes += header.bytes;
      ids.push(header.id);
    }
    if (ids.length === 0) throw incomplete("event_span_gap");
    const page = await db
      .select()
      .from(executionEvents)
      .where(inArray(executionEvents.id, ids))
      .orderBy(asc(executionEvents.hostSequence));

    yield page;
    cursor = page.at(-1)?.hostSequence ?? terminal;
  }
}

function assertAcceptedBinding(
  accepted: ExecutionEvent | undefined,
  command: ExecutionCommand,
  manifest: CommandOutputManifestV2,
): void {
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

/** The host's verified rows for the same span (ADR-167 D5 amendment, D-B4).
 * The accepted row is checked here, as the canonical path checks it before
 * paging. A span carrying an event the flow consumer reacts to is refused:
 * such a turn must reach its owner only through the canonical feed.
 * `terminal` receives the host's terminal row for a settlement. */
async function* hostOutputPages(input: {
  db: Db;
  transport: ExecutionHostTransport;
  command: ExecutionCommand;
  manifest: CommandOutputManifestV2;
  hostKey: string;
  streamRowId: string;
  signal: AbortSignal;
  terminal?: { event: ExecutionEvent | null };
}): AsyncGenerator<ExecutionEvent[]> {
  const { command, manifest } = input;
  let accepted = false;

  for await (const page of hostSpanPages({
    db: input.db,
    transport: input.transport,
    executionHostId: command.executionHostId,
    hostKey: input.hostKey,
    streamId: manifest.streamId,
    streamRowId: input.streamRowId,
    hostSessionId: manifest.hostSessionId,
    after: BigInt(manifest.acceptedSequence) - 1n,
    through: BigInt(manifest.terminalSequence),
    signal: input.signal,
  })) {
    for (const event of page)
      if (
        event.hostSessionId === manifest.hostSessionId &&
        (CONSUMER_SIGNAL_EVENT_TYPES as readonly string[]).includes(
          event.eventType,
        )
      )
        throw new HostSpanSignals(event.eventType);
    if (!accepted) {
      assertAcceptedBinding(page[0], command, manifest);
      accepted = true;
    }
    const rest = page.filter(
      (event) => event.hostSequence !== BigInt(manifest.acceptedSequence),
    );

    if (input.terminal) {
      const last = rest.at(-1);

      if (last?.hostSequence === BigInt(manifest.terminalSequence))
        input.terminal.event = last;
    }
    if (rest.length > 0) yield rest;
  }
}

/** A consumer-signal event lies inside a host span (D-B8). */
export class HostSpanSignals extends MaisterError {
  constructor(readonly eventType: string) {
    super("PRECONDITION", "host span carries a consumer signal event", {
      details: { reason: "span_has_signal_events", eventType },
    });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The one verifier of a command's event span, whichever feed pages it.
 * Exported for its unit tests over synthetic pages. */
export async function* commandEvents(input: {
  command: ExecutionCommand;
  manifest: CommandOutputManifestV2;
  terminalEventId: string;
  pages: AsyncIterable<ExecutionEvent[]>;
  streamRowId: string;
  transport: ExecutionHostTransport;
  signal: AbortSignal;
}): AsyncGenerator<ExecutionEvent> {
  const { command, manifest, streamRowId, transport, signal } = input;
  const terminal = BigInt(manifest.terminalSequence);
  let cursor = BigInt(manifest.acceptedSequence);

  for await (const page of input.pages) {
    for (const event of page) {
      if (event.payloadBytes === null || event.payloadBytes > 1_048_576)
        throw incomplete("event_size");
      if (
        event.hostSequence !== cursor + 1n ||
        event.eventStreamId !== streamRowId ||
        event.executionHostId !== command.executionHostId ||
        event.source !== "host" ||
        !["accepted", "stale_epoch"].includes(event.ingestDisposition)
      )
        throw incomplete("event_span_gap");
      cursor = event.hostSequence;
      if (cursor === terminal) {
        if (event.id !== input.terminalEventId)
          throw incomplete("terminal_identity");
        continue;
      }
      if (
        event.hostSessionId !== manifest.hostSessionId ||
        !event.eventType.startsWith("session.") ||
        event.eventType === "session.command"
      )
        continue;
      if (
        event.runId !== command.runId ||
        event.executionAssignmentId !== command.executionAssignmentId ||
        event.assignmentEpoch !== command.assignmentEpoch ||
        event.payload?.sourceCommandId !== command.id
      )
        throw incomplete("source_command_binding");
      if (event.payload.contentRef === undefined) {
        yield event;
        continue;
      }
      const reference = SessionContentReferenceSchema.parse(
        event.payload.contentRef,
      );

      if (
        event.payloadSchema !== "maister.session.content.v2" ||
        reference.source !== sessionContentSource(event.eventType) ||
        reference.commandId !== command.id ||
        reference.hostSessionId !== manifest.hostSessionId ||
        reference.firstFrame !== event.payload.sourceMonotonicId
      )
        throw incomplete("content_binding");
      const payload = await readObjectJson(transport, reference, signal);

      if (
        payload.sourceCommandId !== command.id ||
        payload.sourceMonotonicId !== event.payload.sourceMonotonicId ||
        payload.sessionName !== event.payload.sessionName ||
        payload.nodeAttemptId !== event.payload.nodeAttemptId ||
        payload.contentRef !== undefined
      )
        throw incomplete("content_binding");
      // This historical read does not project object or domain associations.
      yield { ...event, payload, payloadBytes: reference.sizeBytes };
    }
  }
  if (cursor !== terminal) throw incomplete("event_span_gap");
}

/** Host, manifest and original response of a completed v2 prompt, verified
 * against the command before any event of its span is read. */
async function openPromptOutput(input: {
  db: Db;
  command: ExecutionCommand;
  receipt: CommandReceiptV2;
  stopReason: unknown;
  signal: AbortSignal;
}) {
  const { db, command, receipt, signal } = input;
  const terminal = receipt.terminal!;
  const reference = parseCommandOutputReferenceV2(terminal.result?.output);
  const [host] = await db
    .select()
    .from(executionHosts)
    .where(eq(executionHosts.id, command.executionHostId))
    .limit(1);

  if (!host || host.kind !== "local_direct") throw incomplete("host_route");
  readPromptRequest(command, host.hostKey);
  const transport = defaultTransport();
  const health = await transport.health();

  if (health.kind !== "ready")
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "command output host is not ready",
      {
        details: { reason: "prompt_output_host_unavailable" },
      },
    );
  if (health.identity?.hostKey !== host.hostKey)
    throw incomplete("host_identity");
  const manifest = parseCommandOutputManifestV2(
    await readObjectJson(transport, reference, signal),
  );

  if (
    manifest.commandId !== command.id ||
    manifest.hostKey !== host.hostKey ||
    manifest.runId !== command.runId ||
    manifest.assignmentId !== command.executionAssignmentId ||
    manifest.assignmentEpoch !== command.assignmentEpoch ||
    manifest.hostSessionId !== command.targetSessionId ||
    manifest.requestSha256 !== command.requestSha256 ||
    manifest.streamId !== terminal.streamId ||
    manifest.acceptedSequence !== reference.acceptedSequence ||
    manifest.terminalSequence !== reference.terminalSequence ||
    manifest.terminalSequence !== terminal.sequence
  )
    throw incomplete("manifest_binding");
  const [stream] = await db
    .select()
    .from(executionEventStreams)
    .where(
      and(
        eq(executionEventStreams.executionHostId, command.executionHostId),
        eq(executionEventStreams.streamId, manifest.streamId),
      ),
    )
    .limit(1);
  const original = await readObjectJson(transport, manifest.response, signal);

  if (
    Object.keys(original).length !== 5 ||
    original.schema !== "maister.command-response.v2" ||
    original.commandId !== command.id ||
    original.hostSessionId !== manifest.hostSessionId ||
    original.requestSha256 !== command.requestSha256 ||
    !isRecord(original.response) ||
    original.response.stopReason !== input.stopReason
  )
    throw incomplete("response_binding");

  return {
    transport,
    hostKey: host.hostKey,
    manifest,
    stream,
    response: original.response,
  };
}

/** Internal owner replay only. Browser callers must separately grant repository
 * content access. Consumers must exhaust events successfully before applying
 * a result; a partial iterator is never complete terminal output.
 */
export async function readPromptOutput(input: {
  db: Db;
  commandId: string;
  signal: AbortSignal;
}): Promise<{
  response: Record<string, unknown>;
  events: AsyncIterable<ExecutionEvent>;
}> {
  const { db, commandId, signal } = input;
  const evidence = await reconcileStoredPromptEvidence(db, commandId, signal);
  const command = await getCommand(db, commandId);

  if (
    evidence.disposition !== "settled" ||
    !command ||
    command.state !== "succeeded" ||
    !command.receiptEvidence?.evidenceV2?.terminal ||
    !command.result
  )
    throw incomplete("terminal_evidence");
  const receipt = command.receiptEvidence.evidenceV2;
  const opened = await openPromptOutput({
    db,
    command,
    receipt,
    stopReason: command.result.stopReason,
    signal,
  });
  const { manifest, stream, transport } = opened;

  if (!stream) throw incomplete("event_frontier");
  // The receipt names the terminal event, so a turn settled from the host's
  // span before its canonical event was bound verifies the same identity.
  const terminalEventId = command.terminalEventId ?? receipt.terminal!.eventId;

  // A stream with no contiguous frontier yet is behind the terminal too: the
  // span that settled the turn is read from the host exactly as it was then.
  if (
    stream.lastContiguousSequence === null ||
    stream.lastContiguousSequence < BigInt(manifest.terminalSequence)
  )
    return {
      response: opened.response,
      events: frontierFallback(
        commandEvents({
          command,
          manifest,
          terminalEventId,
          pages: hostOutputPages({
            db,
            transport,
            command,
            manifest,
            hostKey: opened.hostKey,
            streamRowId: stream.id,
            signal,
          }),
          streamRowId: stream.id,
          transport,
          signal,
        }),
      ),
    };
  const [span] = await db
    .select({ count: sql<string>`count(*)::text` })
    .from(executionEvents)
    .where(
      and(
        eq(executionEvents.eventStreamId, stream.id),
        gt(
          executionEvents.hostSequence,
          BigInt(manifest.acceptedSequence) - 1n,
        ),
        lte(executionEvents.hostSequence, BigInt(manifest.terminalSequence)),
      ),
    );

  if (
    BigInt(span.count) !==
    BigInt(manifest.terminalSequence) - BigInt(manifest.acceptedSequence) + 1n
  )
    throw incomplete("event_span_gap");
  const [accepted] = await db
    .select()
    .from(executionEvents)
    .where(
      and(
        eq(executionEvents.eventStreamId, stream.id),
        eq(executionEvents.hostSequence, BigInt(manifest.acceptedSequence)),
      ),
    )
    .limit(1);

  assertAcceptedBinding(accepted, command, manifest);

  return {
    response: opened.response,
    events: commandEvents({
      command,
      manifest,
      terminalEventId,
      pages: canonicalPages({ db, manifest, streamRowId: stream.id, signal }),
      streamRowId: stream.id,
      transport,
      signal,
    }),
  };
}

/** A host span that cannot be read, or that carries a consumer signal, leaves
 * the output exactly where it was before host evidence was admissible: behind
 * the canonical frontier. */
async function* frontierFallback(
  events: AsyncGenerator<ExecutionEvent>,
): AsyncGenerator<ExecutionEvent> {
  try {
    yield* events;
  } catch (error) {
    if (
      error instanceof HostSpanUnavailable ||
      error instanceof HostSpanSignals
    )
      throw incomplete("event_frontier");
    throw error;
  }
}

/** ADR-167 D5 amendment (D-B4): prove a completed, not yet settled v2 turn
 * from the host's own span — the same manifest, response, contiguity,
 * identity, source and content checks the owner will later apply — and return
 * the host's terminal row for the reducer. Throws `HostSpanUnavailable`,
 * `HostSpanSignals`, or an incomplete-output refusal. */
export async function verifyHostPromptSpan(input: {
  db: Db;
  command: ExecutionCommand;
  signal: AbortSignal;
}): Promise<ExecutionEvent> {
  const { db, command, signal } = input;
  const receipt = command.receiptEvidence?.evidenceV2;

  if (
    !receipt?.terminal ||
    receipt.phase !== "completed" ||
    command.terminalEvidenceSha256 !== null
  )
    throw incomplete("terminal_evidence");
  const opened = await openPromptOutput({
    db,
    command,
    receipt,
    stopReason: receipt.terminal.result?.stopReason,
    signal,
  });

  // No manager stream row means no ingest ever observed this host stream.
  if (!opened.stream) throw new HostSpanUnavailable("stream_unknown");
  const terminal: { event: ExecutionEvent | null } = { event: null };

  for await (const event of commandEvents({
    command,
    manifest: opened.manifest,
    terminalEventId: receipt.terminal.eventId,
    pages: hostOutputPages({
      db,
      transport: opened.transport,
      command,
      manifest: opened.manifest,
      hostKey: opened.hostKey,
      streamRowId: opened.stream.id,
      signal,
      terminal,
    }),
    streamRowId: opened.stream.id,
    transport: opened.transport,
    signal,
  }))
    void event;
  if (!terminal.event) throw incomplete("terminal_identity");

  return terminal.event;
}
