import { canonicalCommandJson, CommandJsonError } from "./command-json";
import { COMMAND_KINDS, type CommandKind } from "./command-kinds";

export type ImmutableObjectReference = Readonly<{
  objectId: string;
  generation: number;
  sizeBytes: number;
  sha256: string;
}>;

export type CommandOutputReferenceV2 = ImmutableObjectReference &
  Readonly<{
    commandId: string;
    hostSessionId: string;
    acceptedSequence: string;
    terminalSequence: string;
  }>;

export type CommandFailure = Readonly<{
  code: string;
  message: string;
  details?: Record<string, unknown>;
}>;

export type CommandTerminalEvidenceV2 = Readonly<{
  outcomeVersion: 2;
  status: "succeeded" | "failed" | "fenced";
  eventId: string;
  streamId: string;
  sequence: string;
  result: Record<string, unknown> | null;
  error: CommandFailure | null;
}>;

export type CommandReceiptV2 = Readonly<{
  receiptVersion: 2;
  commandId: string;
  kind: CommandKind;
  hostKey: string;
  runId: string;
  assignmentId: string;
  assignmentEpoch: number;
  hostSessionId: string | null;
  requestSchema: "maister.command.request.v2";
  requestSha256: string;
  phase: "accepted" | "completed" | "rejected";
  httpStatus: number;
  receivedAt: string;
  terminal: CommandTerminalEvidenceV2 | null;
}>;

/** The immutable manifest addresses original command-attributed events in the
 * durable stream and a separately sealed ACP response. Readers must verify
 * the whole span is ingested and retained before exposing semantic output.
 */
export type CommandOutputManifestV2 = Readonly<{
  schema: "maister.command-output.v2";
  commandId: string;
  hostKey: string;
  runId: string;
  assignmentId: string;
  assignmentEpoch: number;
  hostSessionId: string;
  requestSha256: string;
  streamId: string;
  acceptedSequence: string;
  terminalSequence: string;
  response: ImmutableObjectReference;
}>;

export class CommandEvidenceError extends Error {
  constructor(readonly reason: string) {
    super(`command evidence failed validation: ${reason}`);
    this.name = "CommandEvidenceError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_SEQUENCE = 9_223_372_036_854_775_807n;
const OBJECT_KEYS = ["objectId", "generation", "sizeBytes", "sha256"] as const;
const OUTPUT_KEYS = [
  ...OBJECT_KEYS,
  "commandId",
  "hostSessionId",
  "acceptedSequence",
  "terminalSequence",
] as const;

function requireValue(condition: boolean, reason: string): asserts condition {
  if (!condition) throw new CommandEvidenceError(reason);
}

function object(value: unknown, reason: string): Record<string, unknown> {
  requireValue(
    value !== null && typeof value === "object" && !Array.isArray(value),
    reason,
  );

  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  reason: string,
): void {
  requireValue(
    Object.keys(value).length === keys.length &&
      keys.every((key) => Object.hasOwn(value, key)),
    reason,
  );
}

function text(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maximum
  );
}

function integer(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function sequence(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(0|[1-9][0-9]{0,18})$/.test(value) &&
    BigInt(value) <= MAX_SEQUENCE
  );
}

function digest(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function validateObjectReference(value: Record<string, unknown>): void {
  requireValue(
    uuid(value.objectId) &&
      integer(value.generation, 1, 2_147_483_647) &&
      integer(value.sizeBytes, 0, Number.MAX_SAFE_INTEGER) &&
      digest(value.sha256),
    "object_reference",
  );
}

function validatePromptObjects(value: unknown): void {
  requireValue(Array.isArray(value) && value.length <= 32, "prompt_objects");
  for (const entry of value as unknown[]) {
    const metadata = object(entry, "prompt_object");

    exactKeys(
      metadata,
      [
        ...OBJECT_KEYS,
        "kind",
        "logicalName",
        "mimeType",
        "retentionClass",
        "state",
        "createdAt",
        "sealedAt",
        "expiresAt",
        "deletedAt",
      ],
      "prompt_object_keys",
    );
    validateObjectReference(metadata);
    requireValue(
      text(metadata.kind, 128) &&
        text(metadata.logicalName, 255) &&
        text(metadata.mimeType, 255) &&
        text(metadata.retentionClass, 128) &&
        metadata.state === "available" &&
        metadata.deletedAt === null &&
        text(metadata.createdAt, 64) &&
        Number.isFinite(Date.parse(metadata.createdAt)) &&
        text(metadata.sealedAt, 64) &&
        Number.isFinite(Date.parse(metadata.sealedAt)) &&
        (metadata.expiresAt === null ||
          (text(metadata.expiresAt, 64) &&
            Number.isFinite(Date.parse(metadata.expiresAt)))),
      "prompt_object_metadata",
    );
  }
}

/** Reject non-JSON values before inspecting a wire value. */
function validateJson(value: unknown): void {
  try {
    const encoded = canonicalCommandJson(value);

    requireValue(
      encoded.length <= 2_097_152 &&
        new TextEncoder().encode(encoded).byteLength <= 2_097_152,
      "evidence_size",
    );
  } catch (error) {
    if (error instanceof CommandJsonError)
      throw new CommandEvidenceError("evidence_json");
    throw error;
  }
}

export function parseCommandOutputReferenceV2(
  value: unknown,
): CommandOutputReferenceV2 {
  validateJson(value);
  const reference = object(value, "output_reference");

  exactKeys(reference, OUTPUT_KEYS, "output_reference_keys");
  validateObjectReference(reference);
  requireValue(
    uuid(reference.commandId) && text(reference.hostSessionId, 128),
    "output_binding",
  );
  requireValue(
    sequence(reference.acceptedSequence) &&
      sequence(reference.terminalSequence) &&
      BigInt(reference.acceptedSequence) < BigInt(reference.terminalSequence),
    "output_sequence",
  );

  return reference as CommandOutputReferenceV2;
}

export function parseCommandOutputManifestV2(
  value: unknown,
): CommandOutputManifestV2 {
  validateJson(value);
  const manifest = object(value, "output_manifest");

  exactKeys(
    manifest,
    [
      "schema",
      "commandId",
      "hostKey",
      "runId",
      "assignmentId",
      "assignmentEpoch",
      "hostSessionId",
      "requestSha256",
      "streamId",
      "acceptedSequence",
      "terminalSequence",
      "response",
    ],
    "manifest_keys",
  );
  requireValue(
    manifest.schema === "maister.command-output.v2" &&
      uuid(manifest.commandId) &&
      uuid(manifest.assignmentId) &&
      uuid(manifest.streamId),
    "manifest_identity",
  );
  requireValue(
    text(manifest.hostKey, 64) &&
      /^[A-Za-z0-9_-]{8,64}$/.test(manifest.hostKey) &&
      text(manifest.runId, 128) &&
      text(manifest.hostSessionId, 128) &&
      integer(manifest.assignmentEpoch, 1, 2_147_483_647) &&
      digest(manifest.requestSha256),
    "manifest_fence",
  );
  requireValue(
    sequence(manifest.acceptedSequence) &&
      sequence(manifest.terminalSequence) &&
      BigInt(manifest.acceptedSequence) < BigInt(manifest.terminalSequence),
    "manifest_sequence",
  );
  const response = object(manifest.response, "manifest_response");

  exactKeys(response, OBJECT_KEYS, "manifest_response_keys");
  validateObjectReference(response);

  return manifest as CommandOutputManifestV2;
}

export function parseCommandReceiptV2(value: unknown): CommandReceiptV2 {
  validateJson(value);
  const receipt = object(value, "receipt");

  exactKeys(
    receipt,
    [
      "receiptVersion",
      "commandId",
      "kind",
      "hostKey",
      "runId",
      "assignmentId",
      "assignmentEpoch",
      "hostSessionId",
      "requestSchema",
      "requestSha256",
      "phase",
      "httpStatus",
      "receivedAt",
      "terminal",
    ],
    "receipt_keys",
  );
  requireValue(
    receipt.receiptVersion === 2 &&
      receipt.requestSchema === "maister.command.request.v2",
    "receipt_version",
  );
  requireValue(
    uuid(receipt.commandId) &&
      uuid(receipt.assignmentId) &&
      text(receipt.kind, 64) &&
      text(receipt.runId, 128) &&
      integer(receipt.assignmentEpoch, 1, 2_147_483_647),
    "receipt_identity",
  );
  requireValue(
    COMMAND_KINDS.includes(receipt.kind as CommandKind),
    "receipt_kind",
  );
  requireValue(
    text(receipt.hostKey, 64) &&
      /^[A-Za-z0-9_-]{8,64}$/.test(receipt.hostKey) &&
      digest(receipt.requestSha256) &&
      (receipt.hostSessionId === null || text(receipt.hostSessionId, 128)),
    "receipt_fence",
  );
  requireValue(
    text(receipt.receivedAt, 64) &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        receipt.receivedAt,
      ) &&
      Number.isFinite(Date.parse(receipt.receivedAt)) &&
      integer(receipt.httpStatus, 100, 599),
    "receipt_transport",
  );
  requireValue(
    receipt.kind !== "session.prompt" || receipt.hostSessionId !== null,
    "prompt_target",
  );
  requireValue(
    receipt.phase === "accepted"
      ? receipt.httpStatus === 202
      : receipt.phase === "completed"
        ? receipt.httpStatus >= 200 && receipt.httpStatus < 300
        : receipt.httpStatus >= 400,
    "receipt_phase_status",
  );
  validateTerminal(receipt);

  return receipt as CommandReceiptV2;
}

function validateTerminal(receipt: Record<string, unknown>): void {
  if (receipt.phase === "accepted") {
    requireValue(receipt.terminal === null, "accepted_receipt");

    return;
  }
  requireValue(
    receipt.phase === "completed" || receipt.phase === "rejected",
    "receipt_phase",
  );
  const terminal = object(receipt.terminal, "terminal");

  exactKeys(
    terminal,
    [
      "outcomeVersion",
      "status",
      "eventId",
      "streamId",
      "sequence",
      "result",
      "error",
    ],
    "terminal_keys",
  );
  requireValue(
    terminal.outcomeVersion === 2 &&
      uuid(terminal.eventId) &&
      uuid(terminal.streamId) &&
      sequence(terminal.sequence),
    "terminal_identity",
  );
  if (receipt.phase === "completed") {
    requireValue(
      terminal.status === "succeeded" && terminal.error === null,
      "terminal_success",
    );
    const result = object(terminal.result, "terminal_result");

    if (receipt.kind === "session.prompt") {
      requireValue(
        typeof result.stopReason === "string" &&
          [
            "end_turn",
            "max_tokens",
            "max_turn_requests",
            "refusal",
            "cancelled",
          ].includes(result.stopReason),
        "prompt_stop_reason",
      );
      requireValue(
        Object.keys(result).every((key) =>
          ["stopReason", "output", "runtimeObjects"].includes(key),
        ),
        "prompt_result_keys",
      );
      if (Object.hasOwn(result, "runtimeObjects"))
        validatePromptObjects(result.runtimeObjects);
      const reference = parseCommandOutputReferenceV2(result.output);

      requireValue(
        reference.commandId === receipt.commandId &&
          reference.hostSessionId === receipt.hostSessionId &&
          reference.terminalSequence === terminal.sequence,
        "prompt_output_binding",
      );
    }
  } else {
    requireValue(
      (terminal.status === "failed" || terminal.status === "fenced") &&
        terminal.result === null,
      "terminal_failure",
    );
    const failure = object(terminal.error, "terminal_error");

    requireValue(
      Object.keys(failure).every((key) =>
        ["code", "message", "details"].includes(key),
      ) &&
        text(failure.code, 128) &&
        text(failure.message, 2_097_152),
      "terminal_error_shape",
    );
    if (Object.hasOwn(failure, "details"))
      object(failure.details, "terminal_error_details");
    requireValue(
      (terminal.status === "fenced") === (failure.code === "FENCED"),
      "terminal_error_status",
    );
  }
}

export type CommandEventPayloadV2 = Readonly<{
  commandId: string;
  kind: "session.prompt";
  phase: "accepted" | "completed" | "rejected";
  sourceCommandId: string;
  requestSchema: "maister.command.request.v2";
  requestSha256: string;
  terminal: CommandTerminalEvidenceV2 | null;
  sourceMonotonicId?: number;
  sessionName?: string;
  nodeAttemptId?: string;
}>;

export type CommandEventPosition = Readonly<{
  eventId: string;
  streamId: string;
  sequence: string;
  hostSessionId: string | null;
}>;

/** The canonical payload repeats its native position so it cannot be moved
 * between stream slots while preserving apparently agreeing terminal bytes.
 */
export function parseCommandEventPayloadV2(
  value: unknown,
  position: CommandEventPosition,
): CommandEventPayloadV2 {
  validateJson(value);
  const payload = object(value, "command_event");
  const required = [
    "commandId",
    "kind",
    "phase",
    "sourceCommandId",
    "requestSchema",
    "requestSha256",
    "terminal",
  ];
  const optional = ["sourceMonotonicId", "sessionName", "nodeAttemptId"];

  requireValue(
    required.every((key) => Object.hasOwn(payload, key)) &&
      Object.keys(payload).every(
        (key) => required.includes(key) || optional.includes(key),
      ),
    "command_event_keys",
  );
  requireValue(
    uuid(payload.commandId) &&
      payload.sourceCommandId === payload.commandId &&
      payload.kind === "session.prompt" &&
      payload.requestSchema === "maister.command.request.v2" &&
      digest(payload.requestSha256) &&
      text(position.hostSessionId, 128),
    "command_event_identity",
  );
  if (Object.hasOwn(payload, "sourceMonotonicId"))
    requireValue(
      integer(payload.sourceMonotonicId, 0, Number.MAX_SAFE_INTEGER),
      "command_event_frame",
    );
  if (Object.hasOwn(payload, "sessionName"))
    requireValue(text(payload.sessionName, 128), "command_event_session");
  if (Object.hasOwn(payload, "nodeAttemptId"))
    requireValue(uuid(payload.nodeAttemptId), "command_event_attempt");
  validateTerminal({ ...payload, hostSessionId: position.hostSessionId });
  if (payload.terminal !== null) {
    const terminal = payload.terminal as CommandTerminalEvidenceV2;

    requireValue(
      terminal.eventId === position.eventId &&
        terminal.streamId === position.streamId &&
        terminal.sequence === position.sequence,
      "command_event_position",
    );
  }

  return payload as CommandEventPayloadV2;
}
