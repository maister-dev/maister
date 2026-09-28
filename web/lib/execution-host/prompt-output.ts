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

import { and, count, eq, gte, lte } from "drizzle-orm";

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
import { HostSpanSignals, HostSpanUnavailable } from "./prompt-host-span";
import {
  incomplete,
  isSkippedSpanRow,
  promptSpanPages,
  promptSpanReaders,
  SpanCanonicallyAvailable,
  type SpanRow,
} from "./prompt-span-pages";

import {
  executionEvents,
  executionEventSkips,
  executionEventStreams,
  executionHosts,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

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

/** The one verifier of a command's event span, whichever feed pages it.
 * Exported for its unit tests over synthetic pages. */
export async function* commandEvents(input: {
  command: ExecutionCommand;
  manifest: CommandOutputManifestV2;
  terminalEventId: string;
  pages: AsyncIterable<SpanRow[]>;
  streamRowId: string;
  transport: ExecutionHostTransport;
  signal: AbortSignal;
}): AsyncGenerator<ExecutionEvent> {
  const { command, manifest, streamRowId, transport, signal } = input;
  const terminal = BigInt(manifest.terminalSequence);
  let cursor = BigInt(manifest.acceptedSequence);

  for await (const page of input.pages) {
    for (const event of page) {
      // ADR-184 D3: another run's skipped sequence fills contiguity; the
      // prompt's own run's, or the terminal's, is unverifiable.
      if (isSkippedSpanRow(event)) {
        if (
          event.hostSequence !== cursor + 1n ||
          event.hostSequence === terminal ||
          event.runId === command.runId
        )
          throw incomplete("event_span_gap");
        cursor = event.hostSequence;
        continue;
      }
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
  const accepted = BigInt(manifest.acceptedSequence);
  const terminal = BigInt(manifest.terminalSequence);
  // A stream with no contiguous frontier yet is behind the terminal too.
  const fast =
    stream.lastContiguousSequence === null ||
    stream.lastContiguousSequence < terminal;

  // Behind-the-frontier reads are verified as they page; a caught-up span
  // refuses a missing sequence before the owner starts work on it.
  if (!fast) {
    const [[stored], [skipped]] = await Promise.all([
      db
        .select({ n: count() })
        .from(executionEvents)
        .where(
          and(
            eq(executionEvents.eventStreamId, stream.id),
            gte(executionEvents.hostSequence, accepted),
            lte(executionEvents.hostSequence, terminal),
          ),
        ),
      db
        .select({ n: count() })
        .from(executionEventSkips)
        .where(
          and(
            eq(executionEventSkips.eventStreamId, stream.id),
            gte(executionEventSkips.hostSequence, accepted),
            lte(executionEventSkips.hostSequence, terminal),
          ),
        ),
    ]);

    if (BigInt(stored!.n) + BigInt(skipped!.n) !== terminal - accepted + 1n)
      throw incomplete("event_span_gap");
  }
  const events = commandEvents({
    command,
    manifest,
    terminalEventId,
    pages: promptSpanPages({
      command,
      manifest,
      mode: fast ? "fast" : "canonical",
      readers: promptSpanReaders({
        db,
        transport,
        command,
        manifest,
        hostKey: opened.hostKey,
        streamRowId: stream.id,
        signal,
      }),
      signal,
    }),
    streamRowId: stream.id,
    transport,
    signal,
  });

  return {
    response: opened.response,
    events: fast ? frontierFallback(events) : events,
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
 * the host's terminal row for the reducer. The span's prefix up to the
 * manager's frontier is read canonically (ADR-184). `canonical_available`:
 * the canonical log already holds the terminal, so the canonical feed settles
 * it and nothing here may (D3.7). Throws `HostSpanUnavailable`,
 * `HostSpanSignals`, or an incomplete-output refusal. */
export async function verifyHostPromptSpan(input: {
  db: Db;
  command: ExecutionCommand;
  signal: AbortSignal;
}): Promise<ExecutionEvent | "canonical_available"> {
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

  try {
    for await (const event of commandEvents({
      command,
      manifest: opened.manifest,
      terminalEventId: receipt.terminal.eventId,
      pages: promptSpanPages({
        command,
        manifest: opened.manifest,
        mode: "settlement",
        readers: promptSpanReaders({
          db,
          transport: opened.transport,
          command,
          manifest: opened.manifest,
          hostKey: opened.hostKey,
          streamRowId: opened.stream.id,
          signal,
        }),
        signal,
        terminal,
      }),
      streamRowId: opened.stream.id,
      transport: opened.transport,
      signal,
    }))
      void event;
  } catch (error) {
    if (error instanceof SpanCanonicallyAvailable) return "canonical_available";
    throw error;
  }
  if (!terminal.event) throw incomplete("terminal_identity");

  return terminal.event;
}
