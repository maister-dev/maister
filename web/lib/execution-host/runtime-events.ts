import { z } from "zod";

// Stage B's web-side copy of the transport boundary. It intentionally shares
// JSON fixtures, not a runtime package, with the supervisor so remote adapters
// cannot gain an implicit import dependency on the local control plane.
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
] as const;

const SEQUENCE = /^(0|[1-9][0-9]{0,18})$/;
// Match the supervisor's durable host-state contract: the default is an
// `eh_` UUID, while a validated operator-pinned key remains supported.
const HOST_KEY = /^[A-Za-z0-9_-]{8,64}$/;
const SECRET_KEY = /authorization|cookie|token|secret|password|api[_-]?key|headers|environment|^env$/i;
const ABSOLUTE_PATH = /(?:^|\s)\/(?:[^\s]*)/;
const FILE_URI = /^file:\/\//i;
const MAX_RUNTIME_EVENT_BYTES = 1_048_576;

const EVENT_SCHEMA_PAIRS = new Map(
  RUNTIME_EVENT_TYPES.map((eventType, index) => [
    eventType,
    RUNTIME_EVENT_PAYLOAD_SCHEMAS[index],
  ]),
);

export function assertRuntimeEventPayloadSafe(value: Record<string, unknown>): void {
  const visit = (current: unknown, key?: string): void => {
    if (key && SECRET_KEY.test(key)) {
      throw new Error(`runtime event payload contains a secret-bearing key: ${key}`);
    }
    if (typeof current === "string" && (FILE_URI.test(current) || ABSOLUTE_PATH.test(current))) {
      throw new Error("runtime event payload contains a host filesystem path");
    }
    if (Array.isArray(current)) {
      current.forEach((entry) => visit(entry));
      return;
    }
    if (current && typeof current === "object") {
      Object.entries(current).forEach(([entryKey, entry]) => visit(entry, entryKey));
    }
  };

  visit(value);
}

export const RuntimeEventEnvelopeSchema = z
  .object({
    envelopeVersion: z.literal(1),
    eventId: z.string().uuid(),
    hostKey: z.string().regex(HOST_KEY),
    hostBootId: z.string().uuid(),
    streamId: z.string().uuid(),
    sequence: z.string().regex(SEQUENCE).refine(
      (value) =>
        SEQUENCE.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n,
      "sequence exceeds signed BIGINT",
    ),
    runId: z.string().min(1).max(128),
    assignmentId: z.string().uuid(),
    assignmentEpoch: z.number().int().min(1).max(2_147_483_647),
    hostSessionId: z.string().uuid().nullable(),
    eventType: z.enum(RUNTIME_EVENT_TYPES),
    occurredAt: z.string().datetime({ offset: true }),
    payloadSchema: z.enum(RUNTIME_EVENT_PAYLOAD_SCHEMAS),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict()
  .superRefine((value, context) => {
    if (EVENT_SCHEMA_PAIRS.get(value.eventType) !== value.payloadSchema) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payloadSchema"],
        message: "payloadSchema does not match eventType",
      });
    }
    try {
      assertRuntimeEventPayloadSafe(value.payload);
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload"],
        message: error instanceof Error ? error.message : "unsafe runtime event payload",
      });
    }
    if (
      new TextEncoder().encode(JSON.stringify(value)).byteLength >
      MAX_RUNTIME_EVENT_BYTES
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: "runtime event envelope exceeds maximum encoded bytes",
      });
    }
  });

export type RuntimeEventEnvelope = z.infer<typeof RuntimeEventEnvelopeSchema>;

export const RuntimeEventAckSchema = z
  .object({
    streamId: z.string().uuid(),
    throughSequence: z.string().regex(SEQUENCE).refine(
      (value) =>
        SEQUENCE.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n,
      "throughSequence exceeds signed BIGINT",
    ),
  })
  .strict();

export type RuntimeEventAck = z.infer<typeof RuntimeEventAckSchema>;
