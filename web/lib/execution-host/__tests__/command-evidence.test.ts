import { describe, expect, it } from "vitest";

import {
  CommandEvidenceError,
  parseCommandOutputManifestV2,
  parseCommandEventPayloadV2,
  parseCommandReceiptV2,
  type CommandOutputManifestV2,
  type CommandReceiptV2,
  type CommandTerminalEvidenceV2,
} from "../../../../runtime/command-evidence";

const commandId = "10000000-0000-4000-8000-000000000001";
const objectId = "10000000-0000-4000-8000-000000000002";
const hostSessionId = "original-session";
const terminal = {
  outcomeVersion: 2,
  status: "succeeded",
  eventId: "10000000-0000-4000-8000-000000000003",
  streamId: "10000000-0000-4000-8000-000000000004",
  sequence: "42",
  result: {
    stopReason: "end_turn",
    output: {
      objectId,
      generation: 1,
      sizeBytes: 123,
      sha256: "a".repeat(64),
      commandId,
      hostSessionId,
      acceptedSequence: "10",
      terminalSequence: "42",
    },
  },
  error: null,
} satisfies CommandTerminalEvidenceV2;
const receipt = {
  receiptVersion: 2,
  commandId,
  kind: "session.prompt",
  hostKey: "host_original_01",
  runId: "original-run",
  assignmentId: "10000000-0000-4000-8000-000000000005",
  assignmentEpoch: 3,
  hostSessionId,
  requestSchema: "maister.command.request.v2",
  requestSha256: "b".repeat(64),
  phase: "completed",
  httpStatus: 200,
  receivedAt: "2026-09-06T01:00:00.000Z",
  terminal,
} satisfies CommandReceiptV2;

describe("receipt v2 stable wire data", () => {
  it("preserves accepted, successful and nested rejected evidence exactly", () => {
    expect(parseCommandReceiptV2(JSON.parse(JSON.stringify(receipt)))).toEqual(
      receipt,
    );
    const accepted = {
      ...receipt,
      phase: "accepted",
      httpStatus: 202,
      terminal: null,
    };

    expect(parseCommandReceiptV2(accepted)).toEqual(accepted);
    const rejected = {
      ...receipt,
      phase: "rejected",
      httpStatus: 409,
      terminal: {
        ...terminal,
        status: "failed",
        result: null,
        error: {
          code: "PRECONDITION",
          message: "original refusal",
          details: {
            reason: "turn_lost",
            context: { generation: 3, unicode: "е\u0308" },
          },
        },
      },
    };

    expect(parseCommandReceiptV2(rejected)).toEqual(rejected);
  });

  it("refuses substitution, incomplete outcomes and unsafe sequences without exposing private values", () => {
    const invalid: unknown[] = [
      { ...receipt, token: "PRIVATE_SENTINEL" },
      { ...receipt, kind: "invented.command" },
      { ...receipt, assignmentEpoch: 0 },
      {
        ...receipt,
        terminal: { ...terminal, sequence: "9223372036854775808" },
      },
      {
        ...receipt,
        terminal: { ...terminal, result: { stopReason: "end_turn" } },
      },
      {
        ...receipt,
        terminal: {
          ...terminal,
          result: {
            ...terminal.result,
            output: { ...terminal.result.output, hostSessionId: "successor" },
          },
        },
      },
      {
        ...receipt,
        terminal: {
          ...terminal,
          result: {
            ...terminal.result,
            output: { ...terminal.result.output, terminalSequence: "43" },
          },
        },
      },
      { ...receipt, phase: "accepted" },
      { ...receipt, phase: "rejected", httpStatus: 409 },
    ];

    for (const value of invalid) {
      expect(() => parseCommandReceiptV2(value)).toThrow(CommandEvidenceError);
      try {
        parseCommandReceiptV2(value);
      } catch (error) {
        expect(String(error)).not.toContain("PRIVATE_SENTINEL");
      }
    }
  });

  it("binds canonical command evidence to its source, version and exact outer stream position", () => {
    const payload = {
      commandId,
      kind: "session.prompt",
      phase: "completed",
      sourceCommandId: commandId,
      requestSchema: receipt.requestSchema,
      requestSha256: receipt.requestSha256,
      terminal,
    };
    const position = {
      eventId: terminal.eventId,
      streamId: terminal.streamId,
      sequence: terminal.sequence,
      hostSessionId,
    };

    expect(parseCommandEventPayloadV2(payload, position)).toEqual(payload);
    expect(
      parseCommandEventPayloadV2(
        { ...payload, phase: "accepted", terminal: null },
        position,
      ).terminal,
    ).toBeNull();
    for (const value of [
      { ...payload, sourceCommandId: objectId },
      { ...payload, requestSha256: "invalid" },
      { ...payload, status: "succeeded" },
      { ...payload, terminal: { ...terminal, eventId: objectId } },
      { ...payload, terminal: { ...terminal, streamId: objectId } },
    ]) {
      expect(() => parseCommandEventPayloadV2(value, position)).toThrow(
        CommandEvidenceError,
      );
    }
    expect(() =>
      parseCommandEventPayloadV2(payload, { ...position, sequence: "43" }),
    ).toThrow(CommandEvidenceError);
  });

  it("round-trips the immutable stream manifest and rejects changed reference shapes", () => {
    const manifest = {
      schema: "maister.command-output.v2",
      commandId,
      hostKey: receipt.hostKey,
      runId: receipt.runId,
      assignmentId: receipt.assignmentId,
      assignmentEpoch: receipt.assignmentEpoch,
      hostSessionId,
      requestSha256: receipt.requestSha256,
      streamId: terminal.streamId,
      acceptedSequence: "10",
      terminalSequence: "42",
      response: {
        objectId,
        generation: 1,
        sizeBytes: 123,
        sha256: "c".repeat(64),
      },
    } satisfies CommandOutputManifestV2;

    expect(
      parseCommandOutputManifestV2(JSON.parse(JSON.stringify(manifest))),
    ).toEqual(manifest);
    expect(() =>
      parseCommandOutputManifestV2({ ...manifest, terminalSequence: "10" }),
    ).toThrow(CommandEvidenceError);
    expect(() =>
      parseCommandOutputManifestV2({
        ...manifest,
        response: { ...manifest.response, path: "/private/source" },
      }),
    ).toThrow(CommandEvidenceError);
  });
});
