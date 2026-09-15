import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { objectDigest, objectEtag } from "../../../../runtime/object-integrity";

import {
  assertRuntimeObjectContentHeaders,
  deterministicRuntimeObjectId,
  readRuntimeObjectContent,
} from "@/lib/execution-host/runtime-objects";
import { MaisterError } from "@/lib/errors";

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

describe("openRuntimeObjectContent range clamping", () => {
  const OBJECT_ID = "d0b23d15-a3de-49e8-a73f-5e9e96c847cb";
  const RUN_ID = "b7e5e032-6049-48b2-806f-e5db714a93cb";

  // A bounded reader asks for its whole budget, which routinely exceeds the
  // object: the injection seam reads `MAISTER_NODE_OUTPUT_MAX_BYTES + 1`.
  const BUDGET_END = 262_144;

  function fixture(bytes: Uint8Array) {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const row = {
      object: {
        id: OBJECT_ID,
        runId: RUN_ID,
        state: "available",
        sha256,
        sizeBytes: BigInt(bytes.byteLength),
        generation: 1,
        logicalName: "plan-review.json",
      },
      projectId: null,
      localPackageId: null,
      createdByUserId: null,
      executionHost: { id: "host-1", kind: "local_direct" },
    };
    const db = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            innerJoin: () => ({ where: () => ({ limit: () => [row] }) }),
          }),
        }),
      }),
    };
    const seen: Array<{ start: number; end?: number } | undefined> = [];

    // Mirrors the real host contract (supervisor `objectByteRange`): a
    // last-byte-pos at or past the representation length is REFUSED with 416,
    // never silently truncated. The shared `parseObjectContentRange` and
    // `assertRuntimeObjectContentHeaders` encode the same `end < total` rule,
    // so a lenient host could not satisfy this reader either.
    const transport = {
      async openRuntimeObjectContent(
        _objectId: string,
        opts: { range?: { start: number; end?: number } },
      ) {
        seen.push(opts.range);
        const start = opts.range?.start ?? 0;
        const end = opts.range?.end ?? bytes.byteLength - 1;

        if (
          opts.range &&
          (start >= bytes.byteLength || end >= bytes.byteLength)
        )
          throw new MaisterError(
            "PRECONDITION",
            "runtime object range is invalid",
            {
              details: { reason: "runtime_object_range_invalid" },
            },
          );
        const slice = bytes.subarray(start, end + 1);

        return {
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(slice);
              controller.close();
            },
          }),
          contentLength: slice.byteLength,
          contentRange: opts.range
            ? `bytes ${start}-${end}/${bytes.byteLength}`
            : null,
          contentDigest: objectDigest(
            createHash("sha256").update(slice).digest("hex"),
          ),
          reprDigest: objectDigest(sha256),
          etag: objectEtag(1, sha256),
        };
      },
    };

    return { db, transport, seen };
  }

  function read(
    f: ReturnType<typeof fixture>,
    range?: { start: number; end?: number },
  ) {
    return readRuntimeObjectContent({
      db: f.db as never,
      runId: RUN_ID,
      objectId: OBJECT_ID,
      ...(range ? { range } : {}),
      transportForHost: async () => f.transport as never,
    });
  }

  it("reads a whole object smaller than the caller's byte budget", async () => {
    const bytes = new Uint8Array(17_049).fill(7);
    const f = fixture(bytes);

    const { content } = await read(f, { start: 0, end: BUDGET_END });

    expect(content.bytes).toEqual(bytes);
    expect(f.seen[0]?.end ?? bytes.byteLength - 1).toBeLessThan(
      bytes.byteLength,
    );
  });

  it("reads a zero-byte object under a byte budget", async () => {
    const f = fixture(new Uint8Array(0));

    const { content } = await read(f, { start: 0, end: BUDGET_END });

    expect(content.bytes).toEqual(new Uint8Array(0));
  });

  it("keeps an interior range partial", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const f = fixture(bytes);

    const { content } = await read(f, { start: 2, end: 4 });

    expect(content.bytes).toEqual(bytes.subarray(2, 5));
    expect(content.contentRange).toBe("bytes 2-4/8");
  });

  it("still refuses a start past the end of the object", async () => {
    const bytes = new Uint8Array(8).fill(1);
    const f = fixture(bytes);

    await expect(read(f, { start: 8, end: BUDGET_END })).rejects.toMatchObject({
      code: "PRECONDITION",
      details: { reason: "runtime_object_range_invalid" },
    });
  });
});
