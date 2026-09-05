import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { RuntimeEventEnvelopeSchema } from "../runtime-events";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(
        `../../../../contracts/fixtures/runtime-events/${name}`,
        import.meta.url,
      ),
      "utf8",
    ),
  ) as unknown;
}

describe("execution-host runtime event wire boundary", () => {
  it("accepts bounded stdout segment metadata only on its matching available object", () => {
    const segment = RuntimeEventEnvelopeSchema.parse(
      fixture("envelope.stdout-segment.valid.json"),
    );

    expect(
      RuntimeEventEnvelopeSchema.safeParse({ ...segment, hostSessionId: null })
        .success,
    ).toBe(false);
    expect(
      RuntimeEventEnvelopeSchema.safeParse({
        ...segment,
        payload: { ...segment.payload, sizeBytes: 7 },
      }).success,
    ).toBe(false);
    expect(
      RuntimeEventEnvelopeSchema.safeParse({
        ...segment,
        payload: {
          ...segment.payload,
          stdoutSegment: {
            ...(segment.payload.stdoutSegment as Record<string, unknown>),
            capturedBytes: 2_097_153,
          },
        },
      }).success,
    ).toBe(false);
  });

  it("requires the version and exact binding of a referenced session payload", () => {
    const content = RuntimeEventEnvelopeSchema.parse(
      fixture("envelope.content-v2.valid.json"),
    );

    expect(
      RuntimeEventEnvelopeSchema.safeParse({
        ...content,
        payloadSchema: "maister.session.update.v1",
      }).success,
    ).toBe(false);
    expect(
      RuntimeEventEnvelopeSchema.safeParse({
        ...content,
        hostSessionId: "another-session",
      }).success,
    ).toBe(false);
    expect(
      RuntimeEventEnvelopeSchema.safeParse({
        ...content,
        payload: { ...content.payload, sourceMonotonicId: 43 },
      }).success,
    ).toBe(false);
    expect(
      RuntimeEventEnvelopeSchema.safeParse({ ...content, payload: {} }).success,
    ).toBe(false);
  });

  it("accepts the shared open-payload positive fixture", () => {
    expect(
      RuntimeEventEnvelopeSchema.safeParse(fixture("envelope.valid.json"))
        .success,
    ).toBe(true);
  });

  it("rejects unsafe or precision-losing shared fixtures", () => {
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
