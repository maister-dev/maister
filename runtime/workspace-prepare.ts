import { createHash } from "node:crypto";

import { canonicalCommandJson } from "./command-json";
import { EXECUTION_HOST_KEY_PATTERN } from "./execution-host-address";

export type WorkspacePrepareInput =
  | Readonly<{
      mode: "ownWorktree" | "readOnlyCheckout";
      repositoryId: string;
      commit: string;
      inputDigest: string;
    }>
  | Readonly<{
      mode: "sharedWorktree";
      parentHandle: string;
      parentGeneration: number;
      inputDigest: string;
    }>
  | Readonly<{
      mode: "directory";
      directoryProfileId: string;
      inputDigest: string;
    }>
  | Readonly<{ mode: "emptyDirectory"; inputDigest: string }>;

export type WorkspaceAssignmentOwner = Readonly<{
  kind: "assignment";
  hostKey: string;
  runId: string;
  assignmentId: string;
  assignmentEpoch: number;
}>;

export type WorkspacePrepareRequest = Readonly<{
  workspaceProtocol: 1;
  command: Readonly<{
    id: string;
    kind: "workspace.prepare";
    issuedAt: string;
  }>;
  owner: WorkspaceAssignmentOwner;
  payload: WorkspacePrepareInput;
}>;

export type PreparedWorkspace = Readonly<{
  workspace: Readonly<{
    handle: string;
    generation: number;
    mode: WorkspacePrepareInput["mode"];
    observedCommit: string | null;
  }>;
  inputDigest: string;
}>;

export const WORKSPACE_PREPARE_OPERATION = "stageCPrepare";
export const WORKSPACE_PREPARE_TARGET = { kind: "prepare" } as const;
export const WORKSPACE_TERMINAL_EVENT = "workspace.command.terminal";
export const WORKSPACE_TERMINAL_SCHEMA =
  "maister.workspace.command.terminal.v1";

export type WorkspaceTerminalPayload = Readonly<{
  commandId: string;
  requestSha256: string;
  operationId: typeof WORKSPACE_PREPARE_OPERATION;
  owner: WorkspaceAssignmentOwner;
  target: typeof WORKSPACE_PREPARE_TARGET;
  phase: "completed" | "rejected" | "indeterminate";
  outcomeSha256: string;
}>;

export type WorkspaceTerminalEnvelope = Readonly<{
  envelopeVersion: 2;
  eventId: string;
  hostKey: string;
  hostBootId: string;
  streamId: string;
  sequence: string;
  eventType: typeof WORKSPACE_TERMINAL_EVENT;
  occurredAt: string;
  payloadSchema: typeof WORKSPACE_TERMINAL_SCHEMA;
  payload: WorkspaceTerminalPayload;
}>;

type ReceiptIdentity = Pick<
  WorkspaceTerminalPayload,
  "commandId" | "requestSha256" | "operationId" | "owner" | "target"
>;

export type WorkspacePrepareReceipt = Readonly<
  ReceiptIdentity &
    (
      | {
          phase: "accepted";
          status: 202;
          acceptance: { commandId: string; state: "accepted" };
        }
      | ({ streamId: string; eventId: string; outcomeSha256: string } & (
          | { phase: "completed"; result: PreparedWorkspace }
          | {
              phase: "rejected";
              refusal: {
                code: string;
                message: string;
                details: { reason: string };
              };
            }
          | {
              phase: "indeterminate";
              condition: "effect_unconfirmed" | "quiescence_unconfirmed";
            }
        ))
    )
>;

export function workspaceTerminalOutcome(
  receipt: Extract<WorkspacePrepareReceipt, { streamId: string }>,
): Record<string, unknown> {
  if (receipt.phase === "completed") return { result: receipt.result };
  if (receipt.phase === "rejected") return { refusal: receipt.refusal };

  return { condition: receipt.condition };
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const SEQUENCE = /^(0|[1-9][0-9]{0,18})$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const UTC_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function exactRecord(
  input: unknown,
  keys: readonly string[],
): input is Record<string, unknown> {
  return Boolean(
    input &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    Object.keys(input).length === keys.length &&
    keys.every((key) => Object.hasOwn(input as object, key)),
  );
}

function matches(input: unknown, pattern: RegExp): input is string {
  return typeof input === "string" && pattern.test(input);
}

export function isWorkspaceAssignmentOwner(
  value: unknown,
): value is WorkspaceAssignmentOwner {
  return (
    exactRecord(value, [
      "kind",
      "hostKey",
      "runId",
      "assignmentId",
      "assignmentEpoch",
    ]) &&
    value.kind === "assignment" &&
    matches(value.hostKey, EXECUTION_HOST_KEY_PATTERN) &&
    matches(value.runId, RUN_ID) &&
    matches(value.assignmentId, UUID) &&
    typeof value.assignmentEpoch === "number" &&
    Number.isSafeInteger(value.assignmentEpoch) &&
    value.assignmentEpoch > 0 &&
    value.assignmentEpoch <= 2_147_483_647
  );
}

export function isWorkspaceTerminalPayload(
  value: unknown,
): value is WorkspaceTerminalPayload {
  return (
    exactRecord(value, [
      "commandId",
      "requestSha256",
      "operationId",
      "owner",
      "target",
      "phase",
      "outcomeSha256",
    ]) &&
    matches(value.commandId, UUID) &&
    matches(value.requestSha256, DIGEST) &&
    value.operationId === WORKSPACE_PREPARE_OPERATION &&
    isWorkspaceAssignmentOwner(value.owner) &&
    exactRecord(value.target, ["kind"]) &&
    value.target.kind === "prepare" &&
    (value.phase === "completed" ||
      value.phase === "rejected" ||
      value.phase === "indeterminate") &&
    matches(value.outcomeSha256, DIGEST)
  );
}

export function isWorkspaceTerminalEnvelope(
  value: unknown,
): value is WorkspaceTerminalEnvelope {
  return (
    exactRecord(value, [
      "envelopeVersion",
      "eventId",
      "hostKey",
      "hostBootId",
      "streamId",
      "sequence",
      "eventType",
      "occurredAt",
      "payloadSchema",
      "payload",
    ]) &&
    value.envelopeVersion === 2 &&
    matches(value.eventId, UUID) &&
    matches(value.hostKey, EXECUTION_HOST_KEY_PATTERN) &&
    matches(value.hostBootId, UUID) &&
    matches(value.streamId, UUID) &&
    matches(value.sequence, SEQUENCE) &&
    BigInt(value.sequence) <= 9_223_372_036_854_775_807n &&
    value.eventType === WORKSPACE_TERMINAL_EVENT &&
    matches(value.occurredAt, UTC_INSTANT) &&
    Number.isFinite(Date.parse(value.occurredAt)) &&
    value.payloadSchema === WORKSPACE_TERMINAL_SCHEMA &&
    isWorkspaceTerminalPayload(value.payload) &&
    value.payload.owner.hostKey === value.hostKey
  );
}

export function workspaceEvidenceDigest(value: unknown): string {
  return createHash("sha256")
    .update(canonicalCommandJson(value), "utf8")
    .digest("hex");
}

export function workspacePrepareRequestDigest(
  request: WorkspacePrepareRequest,
): string {
  return workspaceEvidenceDigest({
    operationId: WORKSPACE_PREPARE_OPERATION,
    hostKey: request.owner.hostKey,
    target: WORKSPACE_PREPARE_TARGET,
    ...request,
  });
}
