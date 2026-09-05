import { describe, expect, it } from "vitest";

import {
  assertRuntimeObjectContentHeaders,
  deterministicRuntimeObjectId,
} from "@/lib/execution-host/runtime-objects";

describe("deterministicRuntimeObjectId", () => {
  it("derives a stable opaque UUID from the run, source operation, and bytes", () => {
    const input = {
      runId: "b7e5e032-6049-48b2-806f-e5db714a93cb",
      sourceKey: "scratch-upload:message-1:notes.txt",
      sha256:
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    };

    const first = deterministicRuntimeObjectId(input);

    expect(deterministicRuntimeObjectId(input)).toBe(first);
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(
      deterministicRuntimeObjectId({
        ...input,
        sha256:
          "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
      }),
    ).not.toBe(first);
  });
});

describe("assertRuntimeObjectContentHeaders", () => {
  it("accepts exact full and range metadata and rejects a mismatched catalogue size", () => {
    expect(() =>
      assertRuntimeObjectContentHeaders({
        runId: "run-1",
        sizeBytes: 8n,
        contentLength: 8,
        contentRange: null,
      }),
    ).not.toThrow();
    expect(() =>
      assertRuntimeObjectContentHeaders({
        runId: "run-1",
        sizeBytes: 8n,
        range: { start: 1, end: 5 },
        contentLength: 5,
        contentRange: "bytes 1-5/8",
      }),
    ).not.toThrow();
    expect(() =>
      assertRuntimeObjectContentHeaders({
        runId: "run-1",
        sizeBytes: 9n,
        range: { start: 1, end: 5 },
        contentLength: 5,
        contentRange: "bytes 1-5/8",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "CONFLICT",
        details: expect.objectContaining({
          reason: "runtime_object_integrity_mismatch",
        }),
      }),
    );
  });
});
