import "server-only";

import type { Db } from "../db";
import type { ExecutionEvent } from "@/lib/db/schema";

import { createHash } from "node:crypto";

import {
  SessionContentReferenceSchema,
  sessionContentSource,
} from "../runtime-events";
import { defaultTransport } from "../default-transport";
import { getRuntimeObjectForRun } from "../runtime-objects";

import { ExecutionEventProjectionError } from "./projector";
import { projectionTransaction } from "./projection-transaction";
import { projectRuntimeObject } from "./runtime-object-projector";

import { MaisterError } from "@/lib/errors";

function corrupt(): ExecutionEventProjectionError {
  return new ExecutionEventProjectionError(
    "session content reference failed its identity or byte integrity check",
    true,
  );
}

export function prepareTranscriptContent(
  db: Db,
  event: ExecutionEvent,
  signal: AbortSignal,
): Promise<ExecutionEvent> {
  return event.eventType === "session.update"
    ? prepareSessionContent(db, event, signal)
    : Promise.resolve(event);
}

export function preparePromptContent(
  db: Db,
  event: ExecutionEvent,
  signal: AbortSignal,
): Promise<ExecutionEvent> {
  return event.eventType === "session.command"
    ? prepareSessionContent(db, event, signal)
    : Promise.resolve(event);
}

export function prepareArtifactContent(
  db: Db,
  event: ExecutionEvent,
  signal: AbortSignal,
): Promise<ExecutionEvent> {
  return event.eventType === "session.update" ||
    event.eventType === "session.permission_request"
    ? prepareSessionContent(db, event, signal)
    : Promise.resolve(event);
}

/** Internal run consumers only; browser entrypoints must grant readRepoFiles. */
export async function prepareSessionContent(
  db: Db,
  event: ExecutionEvent,
  signal: AbortSignal,
): Promise<ExecutionEvent> {
  if (event.payload?.contentRef === undefined) return event;
  const parsed = SessionContentReferenceSchema.safeParse(
    event.payload.contentRef,
  );

  if (
    event.payloadSchema !== "maister.session.content.v2" ||
    !parsed.success ||
    parsed.data.source !== sessionContentSource(event.eventType) ||
    parsed.data.firstFrame !== event.payload.sourceMonotonicId ||
    parsed.data.hostSessionId !== event.hostSessionId ||
    event.source !== "host" ||
    event.ingestDisposition !== "accepted"
  )
    throw corrupt();
  const reference = parsed.data;

  // A reference is its own availability evidence. This independent bounded
  // transaction avoids a dependency on another consumer's scheduling order.
  await projectionTransaction(db, (tx) => projectRuntimeObject(tx, event));
  const loaded = await projectionTransaction(db, (tx) =>
    getRuntimeObjectForRun({
      db: tx,
      runId: event.runId,
      objectId: reference.objectId,
    }),
  );

  if (!loaded || loaded.object.state !== "available") {
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "referenced session content is not available",
      { details: { reason: "runtime_object_missing", eventId: event.id } },
    );
  }
  if (
    loaded.object.executionHostId !== event.executionHostId ||
    loaded.object.executionAssignmentId !== event.executionAssignmentId ||
    loaded.object.assignmentEpoch !== event.assignmentEpoch ||
    loaded.object.generation !== reference.generation ||
    loaded.object.sha256 !== reference.sha256 ||
    loaded.object.sizeBytes !== BigInt(reference.sizeBytes)
  )
    throw corrupt();
  if (loaded.executionHost.kind !== "local_direct") {
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "session content transport is unavailable",
    );
  }
  const response = await defaultTransport().openRuntimeObjectContent(
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
      throw corrupt();
    const bytes = new Uint8Array(reference.sizeBytes);
    const hash = createHash("sha256");
    let offset = 0;

    for (;;) {
      const next = await reader.read();

      if (next.done) {
        completed = true;
        break;
      }
      if (offset + next.value.byteLength > bytes.byteLength) throw corrupt();
      bytes.set(next.value, offset);
      hash.update(next.value);
      offset += next.value.byteLength;
    }
    if (offset !== bytes.byteLength || hash.digest("hex") !== reference.sha256)
      throw corrupt();
    let value: unknown;

    try {
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      throw corrupt();
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw corrupt();
    const payload = value as Record<string, unknown>;

    if (
      payload.sourceMonotonicId !== event.payload.sourceMonotonicId ||
      payload.sessionName !== event.payload.sessionName ||
      payload.nodeAttemptId !== event.payload.nodeAttemptId ||
      payload.contentRef !== undefined
    )
      throw corrupt();

    return { ...event, payload, payloadBytes: reference.sizeBytes };
  } finally {
    if (!completed) await reader.cancel();
    reader.releaseLock();
  }
}
