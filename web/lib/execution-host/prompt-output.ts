import "server-only";

import type { Db } from "./db";
import type { ExecutionHostTransport } from "./contracts";
import type { ExecutionCommand, ExecutionEvent } from "@/lib/db/schema";
import type {
  ImmutableObjectReference,
  CommandOutputManifestV2,
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

async function* commandEvents(input: {
  db: Db;
  command: ExecutionCommand;
  manifest: CommandOutputManifestV2;
  streamRowId: string;
  transport: ExecutionHostTransport;
  signal: AbortSignal;
}): AsyncGenerator<ExecutionEvent> {
  const { db, command, manifest, streamRowId, transport, signal } = input;
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

    for (const event of page) {
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
        if (event.id !== command.terminalEventId)
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
  const terminal = receipt.terminal!;
  const reference = parseCommandOutputReferenceV2(command.result.output);
  const [host] = await db
    .select()
    .from(executionHosts)
    .where(eq(executionHosts.id, command.executionHostId))
    .limit(1);

  if (!host || host.kind !== "local_direct") throw incomplete("host_route");
  readPromptRequest(command, host.hostKey);
  const transport = defaultTransport();
  const health = await transport.health();

  if (health.kind !== "ready" || health.identity?.hostKey !== host.hostKey)
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

  if (
    !stream ||
    stream.lastContiguousSequence === null ||
    stream.lastContiguousSequence < BigInt(manifest.terminalSequence)
  )
    throw incomplete("event_frontier");
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

  if (
    !accepted ||
    accepted.hostSessionId !== manifest.hostSessionId ||
    accepted.runId !== command.runId ||
    accepted.executionAssignmentId !== command.executionAssignmentId ||
    accepted.assignmentEpoch !== command.assignmentEpoch ||
    accepted.payload?.commandId !== command.id ||
    accepted.payload.phase !== "accepted" ||
    accepted.payload.kind !== "session.prompt"
  )
    throw incomplete("accepted_binding");
  const original = await readObjectJson(transport, manifest.response, signal);

  if (
    Object.keys(original).length !== 5 ||
    original.schema !== "maister.command-response.v2" ||
    original.commandId !== command.id ||
    original.hostSessionId !== manifest.hostSessionId ||
    original.requestSha256 !== command.requestSha256 ||
    !isRecord(original.response) ||
    original.response.stopReason !== command.result.stopReason
  )
    throw incomplete("response_binding");

  return {
    response: original.response,
    events: commandEvents({
      db,
      command,
      manifest,
      streamRowId: stream.id,
      transport,
      signal,
    }),
  };
}
