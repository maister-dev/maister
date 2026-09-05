import { createHash } from "node:crypto";

import { z } from "zod";

/** Exact host-owned session payload; the reference event is availability evidence. */
export const SessionContentReferenceSchema = z
  .object({
    schema: z.literal("maister.session-content.v2"),
    commandId: z.string().uuid(),
    hostSessionId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
    source: z.enum(["raw_stdout", "session_update", "terminal_output"]),
    firstFrame: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    frameCount: z.literal(1),
    objectId: z.string().uuid(),
    kind: z.literal("raw_transcript"),
    logicalName: z.literal("session-content.json"),
    mimeType: z.literal("application/json"),
    generation: z.number().int().min(1).max(2_147_483_647),
    sizeBytes: z.number().int().min(0).max(2_097_152),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    retentionClass: z.literal("run"),
    state: z.literal("available"),
    sealedAt: z.string().datetime({ offset: true }),
    expiresAt: z.null(),
  })
  .strict();

export type SessionContentReference = z.infer<
  typeof SessionContentReferenceSchema
>;

export const StdoutSegmentMetadataSchema = z
  .object({
    commandId: z.string().uuid(),
    firstLogByteOffset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    capturedBytes: z.number().int().min(1).max(2_097_152),
    completeFrames: z.number().int().min(0).max(2_097_152),
    trailingFrameBytes: z.number().int().min(0).max(2_097_152),
  })
  .strict()
  .refine(
    (value) =>
      value.completeFrames <= value.capturedBytes &&
      value.trailingFrameBytes <= value.capturedBytes &&
      Number.isSafeInteger(value.firstLogByteOffset + value.capturedBytes),
    "stdout segment bounds are inconsistent",
  );

const SessionContentPayloadSchema = z
  .object({
    sourceMonotonicId: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    sessionName: z.string().min(1).max(128),
    nodeAttemptId: z.string().uuid().optional(),
    contentRef: SessionContentReferenceSchema,
  })
  .strict();

export function sessionContentSource(
  eventType: string,
): SessionContentReference["source"] {
  if (eventType === "session.line") return "raw_stdout";
  if (
    ["session.command", "session.exited", "session.crashed"].includes(eventType)
  )
    return "terminal_output";

  return "session_update";
}

export const MAX_RUNTIME_EVENT_BYTES = 1_048_576;
export const MAX_RUNTIME_EVENT_DEPTH = 16;
export const MAX_RUNTIME_EVENT_KEYS = 256;
export const MAX_RUNTIME_EVENT_ARRAY = 1_024;
export const MAX_RUNTIME_EVENT_STRING_BYTES = 65_536;

const SEQUENCE = /^(0|[1-9][0-9]{0,18})$/;
// The default identity is `eh_<uuid-without-dashes>`, but a pinned local
// identity is deliberately allowed by the execution-host contract too.
const HOST_KEY = /^[A-Za-z0-9_-]{8,64}$/;
const HOST_SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;
const SECRET_KEY =
  /authorization|cookie|(^|[_-])(access|refresh|auth)?token(s)?$|secret|password|api[_-]?key|headers|environment|^env$/i;
const ABSOLUTE_PATH = /(?:^|\s)\/(?:[^\s]*)/;
const FILE_URI = /^file:\/\//i;

export const RUNTIME_EVENT_TYPES = [
  "session.created",
  "session.line",
  "session.update",
  "session.permission_request",
  "session.hook_trip",
  "session.command",
  "session.chat_turn",
  "session.exited",
  "session.crashed",
  "usage.recorded",
  "runtime_object.available",
  "runtime_object.state",
] as const;

export const RUNTIME_EVENT_PAYLOAD_SCHEMAS = [
  "maister.session.created.v1",
  "maister.session.line.v1",
  "maister.session.update.v1",
  "maister.session.permission-request.v1",
  "maister.session.hook-trip.v1",
  "maister.session.command.v1",
  "maister.session.chat-turn.v1",
  "maister.session.exited.v1",
  "maister.session.crashed.v1",
  "maister.usage.recorded.v1",
  "maister.runtime-object.available.v1",
  "maister.runtime-object.state.v1",
  "maister.session.content.v2",
] as const;

const EVENT_SCHEMA_PAIRS = new Map(
  RUNTIME_EVENT_TYPES.map((eventType, index) => [
    eventType,
    RUNTIME_EVENT_PAYLOAD_SCHEMAS[index],
  ]),
);

export const RuntimeEventSequenceSchema = z
  .string()
  .regex(SEQUENCE)
  .refine(
    (value) =>
      SEQUENCE.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n,
    "sequence exceeds signed BIGINT",
  );

export const RuntimeEventEnvelopeSchema = z
  .object({
    envelopeVersion: z.literal(1),
    eventId: z.string().uuid(),
    hostKey: z.string().regex(HOST_KEY),
    hostBootId: z.string().uuid(),
    streamId: z.string().uuid(),
    sequence: RuntimeEventSequenceSchema,
    runId: z.string().min(1).max(128),
    assignmentId: z.string().uuid(),
    assignmentEpoch: z.number().int().min(1).max(2_147_483_647),
    hostSessionId: z.string().regex(HOST_SESSION_ID).nullable(),
    eventType: z.enum(RUNTIME_EVENT_TYPES),
    occurredAt: z.string().datetime({ offset: true }),
    payloadSchema: z.enum(RUNTIME_EVENT_PAYLOAD_SCHEMAS),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.payload.stdoutSegment !== undefined) {
      const parsed = StdoutSegmentMetadataSchema.safeParse(
        value.payload.stdoutSegment,
      );

      if (
        !parsed.success ||
        value.eventType !== "runtime_object.available" ||
        value.hostSessionId === null ||
        value.payload.kind !== "raw_transcript" ||
        value.payload.logicalName !== "stdout-overflow.ndjson" ||
        value.payload.mimeType !== "application/x-ndjson" ||
        parsed.data.capturedBytes !== value.payload.sizeBytes
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["payload", "stdoutSegment"],
          message:
            "stdout segment metadata does not match its available object",
        });
      }
    }
    if (value.payloadSchema === "maister.session.content.v2") {
      const parsed = SessionContentPayloadSchema.safeParse(value.payload);

      if (
        !value.eventType.startsWith("session.") ||
        !parsed.success ||
        parsed.data.contentRef.hostSessionId !== value.hostSessionId ||
        parsed.data.contentRef.firstFrame !== parsed.data.sourceMonotonicId ||
        parsed.data.contentRef.source !== sessionContentSource(value.eventType)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["payload"],
          message:
            "session content reference has an invalid payload or source binding",
        });
      }
    } else if (
      value.payload.contentRef !== undefined ||
      EVENT_SCHEMA_PAIRS.get(value.eventType) !== value.payloadSchema
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payloadSchema"],
        message: "payloadSchema does not match eventType or referenced content",
      });
    }
    try {
      assertRuntimeEventPayloadSafe(value.payload);
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload"],
        message:
          error instanceof Error
            ? error.message
            : "unsafe runtime event payload",
      });
    }
  });

export type RuntimeEventEnvelope = z.infer<typeof RuntimeEventEnvelopeSchema>;
export type RuntimeEventType = (typeof RUNTIME_EVENT_TYPES)[number];
export type RuntimeEventPayloadSchema =
  (typeof RUNTIME_EVENT_PAYLOAD_SCHEMAS)[number];

export type RuntimeEventDraft = {
  runId: string;
  assignmentId: string;
  assignmentEpoch: number;
  hostSessionId: string | null;
  eventType: RuntimeEventType;
  occurredAt: string;
  payload: Record<string, unknown>;
};

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function encodedByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function normalizeJsonValue(value: unknown): JsonValue {
  let serialized: string | undefined;

  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new Error(
      `runtime event payload is not JSON serializable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (serialized === undefined) {
    throw new Error("runtime event payload is not JSON serializable");
  }

  return JSON.parse(serialized) as JsonValue;
}

function assertJsonValue(
  value: unknown,
  depth: number,
): asserts value is JsonValue {
  if (depth > MAX_RUNTIME_EVENT_DEPTH) {
    throw new Error("runtime event payload exceeds maximum depth");
  }
  if (value === null || typeof value === "boolean" || typeof value === "number")
    return;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_RUNTIME_EVENT_STRING_BYTES) {
      throw new Error("runtime event payload string exceeds maximum bytes");
    }

    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_RUNTIME_EVENT_ARRAY) {
      throw new Error("runtime event payload array exceeds maximum items");
    }
    for (const entry of value) assertJsonValue(entry, depth + 1);

    return;
  }
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error("runtime event payload must contain plain JSON values");
  }
  const entries = Object.entries(value);

  if (entries.length > MAX_RUNTIME_EVENT_KEYS) {
    throw new Error("runtime event payload object exceeds maximum keys");
  }
  for (const [, entry] of entries) assertJsonValue(entry, depth + 1);
}

function redactValue(value: JsonValue): JsonValue {
  if (typeof value === "string") {
    return FILE_URI.test(value) || ABSOLUTE_PATH.test(value)
      ? "[REDACTED_HOST_PATH]"
      : value;
  }
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !SECRET_KEY.test(key))
        .map(([key, entry]) => [key, redactValue(entry)]),
    );
  }

  return value;
}

function assertNoUnsafePayloadValue(value: JsonValue, key?: string): void {
  if (key && SECRET_KEY.test(key)) {
    throw new Error(
      `runtime event payload contains a secret-bearing key: ${key}`,
    );
  }
  if (
    typeof value === "string" &&
    (FILE_URI.test(value) || ABSOLUTE_PATH.test(value))
  ) {
    throw new Error("runtime event payload contains a host filesystem path");
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertNoUnsafePayloadValue(entry);

    return;
  }
  if (value && typeof value === "object") {
    for (const [entryKey, entry] of Object.entries(value)) {
      assertNoUnsafePayloadValue(entry, entryKey);
    }
  }
}

export function assertRuntimeEventPayloadSafe(
  value: unknown,
): asserts value is Record<string, JsonValue> {
  assertJsonValue(value, 0);
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("runtime event payload must be an object");
  }
  assertNoUnsafePayloadValue(value);
  if (encodedByteLength(value) > MAX_RUNTIME_EVENT_BYTES) {
    throw new Error("runtime event payload exceeds maximum encoded bytes");
  }
}

export function redactRuntimeEventPayload(
  value: unknown,
): Record<string, JsonValue> {
  const normalized = normalizeJsonValue(value);

  assertJsonValue(normalized, 0);
  if (
    !normalized ||
    Array.isArray(normalized) ||
    typeof normalized !== "object"
  ) {
    throw new Error("runtime event payload must be an object");
  }
  const redacted = redactValue(normalized) as Record<string, JsonValue>;

  if (encodedByteLength(redacted) > MAX_RUNTIME_EVENT_BYTES) {
    throw new Error("runtime event payload exceeds maximum encoded bytes");
  }

  return redacted;
}

export function payloadSchemaForRuntimeEvent(
  eventType: RuntimeEventType,
): RuntimeEventPayloadSchema {
  const payloadSchema = EVENT_SCHEMA_PAIRS.get(eventType);

  if (!payloadSchema) {
    throw new Error(`no payload schema is registered for ${eventType}`);
  }

  return payloadSchema as RuntimeEventPayloadSchema;
}

export function buildRuntimeEventEnvelope(input: {
  hostKey: string;
  hostBootId: string;
  streamId: string;
  sequence: string;
  draft: RuntimeEventDraft;
}): RuntimeEventEnvelope {
  const payload = redactRuntimeEventPayload(input.draft.payload);
  const envelope = {
    envelopeVersion: 1 as const,
    eventId: deterministicRuntimeEventId({
      hostKey: input.hostKey,
      streamId: input.streamId,
      sequence: input.sequence,
    }),
    hostKey: input.hostKey,
    hostBootId: input.hostBootId,
    streamId: input.streamId,
    sequence: input.sequence,
    runId: input.draft.runId,
    assignmentId: input.draft.assignmentId,
    assignmentEpoch: input.draft.assignmentEpoch,
    hostSessionId: input.draft.hostSessionId,
    eventType: input.draft.eventType,
    occurredAt: input.draft.occurredAt,
    payloadSchema:
      payload.contentRef === undefined
        ? payloadSchemaForRuntimeEvent(input.draft.eventType)
        : "maister.session.content.v2",
    payload,
  };
  const parsed = RuntimeEventEnvelopeSchema.parse(envelope);

  if (encodedByteLength(parsed) > MAX_RUNTIME_EVENT_BYTES) {
    throw new Error("runtime event envelope exceeds maximum encoded bytes");
  }

  return parsed;
}

export const RuntimeEventAckSchema = z
  .object({
    streamId: z.string().uuid(),
    throughSequence: RuntimeEventSequenceSchema,
  })
  .strict();

export type RuntimeEventAck = z.infer<typeof RuntimeEventAckSchema>;

function uuidFromSha1(hash: Buffer): string {
  const bytes = Buffer.from(hash.subarray(0, 16));

  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function deterministicRuntimeEventId(input: {
  hostKey: string;
  streamId: string;
  sequence: string;
}): string {
  const namespace = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
  const name = `urn:maister:execution-event:host:${encodeURIComponent(input.hostKey)}:stream:${encodeURIComponent(input.streamId)}:sequence:${encodeURIComponent(input.sequence)}`;

  return uuidFromSha1(
    createHash("sha1")
      .update(namespace.toString("hex"), "hex")
      .update(name, "utf8")
      .digest(),
  );
}
