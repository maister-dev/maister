import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  RuntimeEventEnvelopeSchema,
  assertRuntimeEventPayloadSafe,
  redactRuntimeEventPayload,
} from "../runtime-events";

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

  it("preserves the bounded routing fields on a referenced context update", () => {
    const content = RuntimeEventEnvelopeSchema.parse(
      fixture("envelope.content-v2.valid.json"),
    );

    const result = RuntimeEventEnvelopeSchema.safeParse({
      ...content,
      payload: {
        ...content.payload,
        contextType: "compaction_update",
        contextReplay: true,
      },
    });

    expect(result.success).toBe(true);
    expect(
      RuntimeEventEnvelopeSchema.safeParse({
        ...content,
        payload: { ...content.payload, contextType: "unbound_vendor_kind" },
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

  it("matches supervisor host-path safety parity on inline code vs host paths", () => {
    const allowedInline = [
      "const x = 1; // inline comment",
      "/* block comment */ const y = 2;",
      "<Button />",
      "return <div className='box' />;",
      "const ratio = a / b;",
      "GET /api HTTP/1.1",
      "redirect to /login",
      "see https://example.com/a/b/c for docs",
      "relative/path/to/file.ts",
    ];

    for (const text of allowedInline) {
      expect(() => assertRuntimeEventPayloadSafe({ text })).not.toThrow();
      expect(redactRuntimeEventPayload({ text })).toEqual({ text });
    }

    const rejectedHostPaths = [
      "/Users/dev/project/src/index.ts",
      "opened /home/alice/repo/main.ts",
      'path="/var/log/maister.log"',
      "(/etc/hosts)",
      "/private/tmp/session.sock",
      "/tmp/a",
      "/opt/maister/config",
      "/usr/local/bin/node",
      "/app/server.js",
      "/repos/demo",
      "/maister/state",
      "/.maister/runs",
      "/foo/bar",
      "file:///Users/dev/secret.txt",
    ];

    for (const text of rejectedHostPaths) {
      expect(() => assertRuntimeEventPayloadSafe({ text })).toThrow(
        /host filesystem path/,
      );
      expect(redactRuntimeEventPayload({ text })).toEqual({
        text: "[REDACTED_HOST_PATH]",
      });
    }
  });
});
