import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  MAX_RUNTIME_EVENT_BYTES,
  RuntimeEventEnvelopeSchema,
  deterministicRuntimeEventId,
  redactRuntimeEventPayload,
} from "../runtime-events";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(
        `../../../contracts/fixtures/runtime-events/${name}`,
        import.meta.url,
      ),
      "utf8",
    ),
  ) as unknown;
}

const envelope = {
  envelopeVersion: 1,
  eventId: "6f63db3b-1843-5475-b293-b4b995a38a5d",
  hostKey: "eh_0f1e2d3c4b5a69788796a5b4c3d2e1f0",
  hostBootId: "e2f7c57a-bb0d-4e78-99f9-70f34f3928ab",
  streamId: "76103277-0889-49d7-87f1-f0fd2f5f5922",
  sequence: "9007199254740993",
  runId: "run-abc",
  assignmentId: "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d",
  assignmentEpoch: 3,
  hostSessionId: "5f3a8a2b-7e34-4f6d-9d2c-1d4e5f6a7b8c",
  eventType: "session.command",
  occurredAt: "2026-09-04T12:00:00.000Z",
  payloadSchema: "maister.session.command.v1",
  payload: { commandId: "3d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a" },
};

describe("Stage B runtime event envelope", () => {
  it("preserves a decimal sequence above MAX_SAFE_INTEGER without number coercion", () => {
    const parsed = RuntimeEventEnvelopeSchema.parse(envelope);

    expect(parsed.sequence).toBe("9007199254740993");
    expect(typeof parsed.sequence).toBe("string");
    expect(
      RuntimeEventEnvelopeSchema.safeParse({ ...envelope, sequence: 1 })
        .success,
    ).toBe(false);
    expect(
      RuntimeEventEnvelopeSchema.safeParse({ ...envelope, sequence: "01" })
        .success,
    ).toBe(false);
  });

  it("uses a deterministic UUIDv5 event identity", () => {
    expect(
      deterministicRuntimeEventId({
        hostKey: envelope.hostKey,
        streamId: envelope.streamId,
        sequence: envelope.sequence,
      }),
    ).toBe(
      deterministicRuntimeEventId({
        hostKey: envelope.hostKey,
        streamId: envelope.streamId,
        sequence: envelope.sequence,
      }),
    );
  });

  it("redacts paths and secret-bearing values before payload persistence", () => {
    const payload = redactRuntimeEventPayload({
      token: "never-store",
      nested: { authorization: "Bearer secret", path: "/private/host/file" },
      uri: "file:///private/host/file",
      inputTokens: 12,
      safe: "retained",
    });

    expect(payload).toEqual({
      nested: { path: "[REDACTED_HOST_PATH]" },
      uri: "[REDACTED_HOST_PATH]",
      inputTokens: 12,
      safe: "retained",
    });
    expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThan(
      MAX_RUNTIME_EVENT_BYTES,
    );
  });

  it("shares strict wire conformance fixtures with the web boundary", () => {
    expect(
      RuntimeEventEnvelopeSchema.safeParse(fixture("envelope.valid.json"))
        .success,
    ).toBe(true);
    expect(
      RuntimeEventEnvelopeSchema.safeParse(
        fixture("envelope.invalid-number-sequence.json"),
      ).success,
    ).toBe(false);
    expect(
      RuntimeEventEnvelopeSchema.safeParse(
        fixture("envelope.invalid-unsafe-payload.json"),
      ).success,
    ).toBe(false);
  });
});
