// S4.3 / D9: the maintenance import protocol over a local Unix socket inside an
// operator-owned directory. There is no path-bearing endpoint, no active
// assignment, and no way to turn admission back on over the wire. Bytes arrive
// in bounded chunks against a registered manifest item and are sealed through
// the ordinary runtime-object lifecycle.

import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pino from "pino";
import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ImportAdmissionRegistry } from "../import-admin";
import {
  openImportProgressLedger,
  type ImportProgressLedger,
} from "../import-progress";
import { openHostState, type HostState } from "../host-state";
import { startImportListener, type ImportListener } from "../import-listener";

import { bootHost } from "./_fixtures/boot-host";

const logger = pino({ level: "silent" });
const MANIFEST_DIGEST = "a".repeat(64);
const IMPORT_ID = "inv-7f3a";

let directory: string;
let runtimeRoot: string;
let hostState: HostState;
let ledger: ImportProgressLedger;
let admission: ImportAdmissionRegistry;
let listener: ImportListener;
let generation: number;

type Bytes = Uint8Array;

type ProgressBody = {
  totals: {
    items: number;
    sealed: number;
    receivedBytes: number;
    expectedBytes: number;
  };
  items: Array<{ itemId: string; receivedBytes: number; state: string }>;
};

function sha256(bytes: Bytes): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type Response = { status: number; reason: string | null; body: string };

function call(input: {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: Bytes;
}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: listener.socketPath,
        method: input.method,
        path: input.path,
        headers: input.headers,
      },
      (res) => {
        const chunks: Bytes[] = [];

        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          let reason: string | null = null;

          try {
            reason =
              (JSON.parse(body) as { details?: { reason?: string } }).details
                ?.reason ?? null;
          } catch {
            reason = null;
          }
          resolve({ status: res.statusCode ?? 0, reason, body });
        });
      },
    );

    req.on("error", reject);
    if (input.body) req.write(input.body);
    req.end();
  });
}

function chunkHeaders(input: {
  offset: number;
  bytes: Bytes;
  generation?: number;
  manifestDigest?: string;
}): Record<string, string> {
  return {
    "content-type": "application/octet-stream",
    "content-length": String(input.bytes.byteLength),
    "x-maister-import-generation": String(input.generation ?? generation),
    "x-maister-import-manifest": input.manifestDigest ?? MANIFEST_DIGEST,
    "x-maister-import-offset": String(input.offset),
    "x-maister-sha256": sha256(input.bytes),
  };
}

function controlHeaders(): Record<string, string> {
  return {
    "x-maister-import-generation": String(generation),
    "x-maister-import-manifest": MANIFEST_DIGEST,
  };
}

async function registerItem(bytes: Bytes): Promise<string> {
  const itemId = createHash("sha256").update(randomUUID()).digest("hex");

  ledger.registerItem({
    itemId,
    lane: "runtime_objects",
    runId: "run-1",
    sizeBytes: bytes.byteLength,
    sha256: sha256(bytes),
  });

  return itemId;
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "import-admission-"));
  runtimeRoot = await mkdtemp(join(tmpdir(), "import-runtime-"));
  hostState = openHostState({
    stateDir: join(runtimeRoot, ".maister", "execution-host"),
    logger,
  });
  ledger = openImportProgressLedger({
    file: join(directory, `import-progress-${IMPORT_ID}.sqlite`),
    importId: IMPORT_ID,
    manifestDigest: MANIFEST_DIGEST,
  });
  generation = ledger.enableGeneration().generation;
  admission = new ImportAdmissionRegistry();
  admission.enable({
    importId: IMPORT_ID,
    generation,
    manifestDigest: MANIFEST_DIGEST,
  });
  listener = await startImportListener({
    directory,
    importId: IMPORT_ID,
    manifestDigest: MANIFEST_DIGEST,
    admission,
    ledger,
    hostState,
    runtimeRoot,
    logger,
  });
});

afterEach(async () => {
  await listener?.close();
  ledger?.close();
  hostState?.close();
  await rm(directory, { recursive: true, force: true });
  await rm(runtimeRoot, { recursive: true, force: true });
});

describe("import maintenance socket", () => {
  it("lives in an operator-owned directory the normal web process cannot enter", async () => {
    const socketDirectory = join(directory, "admission");

    expect((await stat(socketDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(listener.socketPath)).mode & 0o777).toBe(0o600);
  });

  it("exposes no path-bearing endpoint", async () => {
    const refused = await call({
      method: "PUT",
      path: `/imports/${IMPORT_ID}/items/${"1".repeat(64)}/chunks/0?path=/etc/passwd`,
      headers: chunkHeaders({ offset: 0, bytes: new Uint8Array([1]) }),
      body: new Uint8Array([1]),
    });

    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.body).not.toContain("/etc/passwd");
  });
});

describe("admission", () => {
  it("refuses a request for an import that is not enabled", async () => {
    const response = await call({
      method: "GET",
      path: "/imports/inv-0000",
      headers: controlHeaders(),
    });

    expect(response.status).toBe(409);
    expect(response.reason).toBe("import_admission_disabled");
  });

  it("refuses a stale generation and a foreign manifest digest", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const itemId = await registerItem(bytes);

    expect(
      (
        await call({
          method: "PUT",
          path: `/imports/${IMPORT_ID}/items/${itemId}/chunks/0`,
          headers: chunkHeaders({
            offset: 0,
            bytes,
            generation: generation + 1,
          }),
          body: bytes,
        })
      ).reason,
    ).toBe("import_generation_stale");
    expect(
      (
        await call({
          method: "PUT",
          path: `/imports/${IMPORT_ID}/items/${itemId}/chunks/0`,
          headers: chunkHeaders({
            offset: 0,
            bytes,
            manifestDigest: "b".repeat(64),
          }),
          body: bytes,
        })
      ).reason,
    ).toBe("import_manifest_mismatch");
  });

  it("cannot be reopened over the wire once revoked", async () => {
    const revoked = await call({
      method: "DELETE",
      path: `/imports/${IMPORT_ID}/admission`,
      headers: controlHeaders(),
    });

    expect(revoked.status).toBe(200);

    const afterwards = await call({
      method: "GET",
      path: `/imports/${IMPORT_ID}`,
      headers: controlHeaders(),
    });

    expect(afterwards.reason).toBe("import_admission_revoked");
    expect(ledger.revokedGenerations()).toEqual([generation]);
  });

  it("keeps the sealed proof readable after admission is revoked", async () => {
    const bytes = Buffer.from("preserved history\n", "utf8");
    const itemId = await registerItem(bytes);

    await call({
      method: "PUT",
      path: `/imports/${IMPORT_ID}/items/${itemId}/chunks/0`,
      headers: chunkHeaders({ offset: 0, bytes }),
      body: bytes,
    });
    const sealed = await call({
      method: "POST",
      path: `/imports/${IMPORT_ID}/items/${itemId}/seal`,
      headers: controlHeaders(),
    });
    const objectId = (JSON.parse(sealed.body) as { objectId: string }).objectId;

    await call({
      method: "DELETE",
      path: `/imports/${IMPORT_ID}/admission`,
      headers: controlHeaders(),
    });

    expect(hostState.getRuntimeObject(objectId)?.state).toBe("available");
  });
});

describe("chunked transfer", () => {
  it("refuses a chunk larger than the transfer bound", async () => {
    const bytes = Buffer.alloc(8 * 1024 * 1024 + 1, 7);
    const itemId = await registerItem(bytes);
    const response = await call({
      method: "PUT",
      path: `/imports/${IMPORT_ID}/items/${itemId}/chunks/0`,
      headers: chunkHeaders({ offset: 0, bytes }),
      body: bytes,
    });

    expect(response.reason).toBe("import_chunk_too_large");
  });

  it("refuses an item the manifest never registered", async () => {
    const bytes = new Uint8Array([1]);
    const response = await call({
      method: "PUT",
      path: `/imports/${IMPORT_ID}/items/${"9".repeat(64)}/chunks/0`,
      headers: chunkHeaders({ offset: 0, bytes }),
      body: bytes,
    });

    expect(response.reason).toBe("import_item_unknown");
  });

  it("refuses bytes whose checksum does not match the declared chunk", async () => {
    const bytes = Buffer.from("hello", "utf8");
    const itemId = await registerItem(bytes);
    const headers = chunkHeaders({ offset: 0, bytes });
    const response = await call({
      method: "PUT",
      path: `/imports/${IMPORT_ID}/items/${itemId}/chunks/0`,
      headers,
      body: Buffer.from("world", "utf8"),
    });

    expect(response.reason).toBe("import_chunk_conflict");
  });

  it("replays an identical chunk and refuses a conflicting one", async () => {
    const bytes = Buffer.from("abcdefghij", "utf8");
    const itemId = await registerItem(bytes);
    const first = Buffer.from("abcde", "utf8");

    expect(
      (
        await call({
          method: "PUT",
          path: `/imports/${IMPORT_ID}/items/${itemId}/chunks/0`,
          headers: chunkHeaders({ offset: 0, bytes: first }),
          body: first,
        })
      ).status,
    ).toBe(200);
    expect(
      JSON.parse(
        (
          await call({
            method: "PUT",
            path: `/imports/${IMPORT_ID}/items/${itemId}/chunks/0`,
            headers: chunkHeaders({ offset: 0, bytes: first }),
            body: first,
          })
        ).body,
      ),
    ).toMatchObject({ outcome: "duplicate", receivedBytes: 5 });

    const conflicting = Buffer.from("zzzzz", "utf8");

    expect(
      (
        await call({
          method: "PUT",
          path: `/imports/${IMPORT_ID}/items/${itemId}/chunks/0`,
          headers: chunkHeaders({ offset: 0, bytes: conflicting }),
          body: conflicting,
        })
      ).reason,
    ).toBe("import_chunk_conflict");
  });

  // The operator needs both halves to resume: aggregate totals to bound its own
  // progress reporting, and the per-item offsets to decide what to re-send. A
  // body that spends one key on both loses the totals silently.
  it("reports aggregate totals alongside the per-item offsets", async () => {
    const bytes = Buffer.from("abcdefghij", "utf8");
    const itemId = await registerItem(bytes);
    const head = bytes.subarray(0, 4);

    await registerItem(Buffer.from("xy", "utf8"));
    await call({
      method: "PUT",
      path: `/imports/${IMPORT_ID}/items/${itemId}/chunks/0`,
      headers: chunkHeaders({ offset: 0, bytes: head }),
      body: head,
    });

    const progress = JSON.parse(
      (
        await call({
          method: "GET",
          path: `/imports/${IMPORT_ID}`,
          headers: controlHeaders(),
        })
      ).body,
    ) as ProgressBody;

    expect(progress.totals).toEqual({
      items: 2,
      sealed: 0,
      receivedBytes: 4,
      expectedBytes: 12,
    });
    expect(progress.items).toHaveLength(2);
  });

  it("resumes at the committed offset after an acknowledgement is lost", async () => {
    const bytes = Buffer.from("abcdefghij", "utf8");
    const itemId = await registerItem(bytes);
    const first = bytes.subarray(0, 5);

    await call({
      method: "PUT",
      path: `/imports/${IMPORT_ID}/items/${itemId}/chunks/0`,
      headers: chunkHeaders({ offset: 0, bytes: first }),
      body: first,
    });

    const progress = JSON.parse(
      (
        await call({
          method: "GET",
          path: `/imports/${IMPORT_ID}`,
          headers: controlHeaders(),
        })
      ).body,
    ) as ProgressBody;

    expect(
      progress.items.find((item) => item.itemId === itemId)?.receivedBytes,
    ).toBe(5);

    const second = bytes.subarray(5);

    expect(
      (
        await call({
          method: "PUT",
          path: `/imports/${IMPORT_ID}/items/${itemId}/chunks/1`,
          headers: chunkHeaders({ offset: 5, bytes: second }),
          body: second,
        })
      ).status,
    ).toBe(200);
  });

  // A refused chunk must not leave bytes behind: the spool is the material the
  // seal verifies, so an out-of-bounds write that survives its own refusal
  // would make the item permanently unsealable.
  it("leaves the spool untouched when it refuses an out-of-bounds chunk", async () => {
    const bytes = Buffer.from("abcdefghij", "utf8");
    const itemId = await registerItem(bytes);
    const overrun = Buffer.concat([bytes, Buffer.from("XXXX", "utf8")]);

    expect(
      (
        await call({
          method: "PUT",
          path: `/imports/${IMPORT_ID}/items/${itemId}/chunks/0`,
          headers: chunkHeaders({ offset: 0, bytes: overrun }),
          body: overrun,
        })
      ).reason,
    ).toBe("import_offset_mismatch");

    await call({
      method: "PUT",
      path: `/imports/${IMPORT_ID}/items/${itemId}/chunks/0`,
      headers: chunkHeaders({ offset: 0, bytes }),
      body: bytes,
    });

    const sealed = await call({
      method: "POST",
      path: `/imports/${IMPORT_ID}/items/${itemId}/seal`,
      headers: controlHeaders(),
    });

    expect(sealed.status).toBe(200);
    expect((JSON.parse(sealed.body) as { sha256: string }).sha256).toBe(
      sha256(bytes),
    );
  });

  it("refuses a chunk that does not continue from the committed offset", async () => {
    const bytes = Buffer.from("abcdefghij", "utf8");
    const itemId = await registerItem(bytes);
    const stray = bytes.subarray(5);

    expect(
      (
        await call({
          method: "PUT",
          path: `/imports/${IMPORT_ID}/items/${itemId}/chunks/1`,
          headers: chunkHeaders({ offset: 5, bytes: stray }),
          body: stray,
        })
      ).reason,
    ).toBe("import_offset_mismatch");
  });
});

describe("seal and readback", () => {
  it("seals an ordinary object whose bytes read back exactly", async () => {
    const bytes = Buffer.from("preserved step log\n".repeat(40), "utf8");
    const itemId = await registerItem(bytes);

    for (let offset = 0; offset < bytes.byteLength; offset += 100) {
      const slice = bytes.subarray(
        offset,
        Math.min(offset + 100, bytes.byteLength),
      );

      await call({
        method: "PUT",
        path: `/imports/${IMPORT_ID}/items/${itemId}/chunks/${offset / 100}`,
        headers: chunkHeaders({ offset, bytes: slice }),
        body: slice,
      });
    }

    const sealed = await call({
      method: "POST",
      path: `/imports/${IMPORT_ID}/items/${itemId}/seal`,
      headers: controlHeaders(),
    });
    const receipt = JSON.parse(sealed.body) as {
      objectId: string;
      sizeBytes: number;
      sha256: string;
    };

    expect(receipt.sizeBytes).toBe(bytes.byteLength);
    expect(receipt.sha256).toBe(sha256(bytes));

    const object = hostState.getRuntimeObject(receipt.objectId);

    expect(object?.state).toBe("available");
    expect(await readFile(object!.privatePath)).toEqual(bytes);
  });

  // The acceptance is "ordinary object readback": an imported object must come
  // back through the SAME TCP content route every live object uses, with no
  // import-aware branch — while that listener still carries no import route at
  // all, so the web process cannot reach this protocol even by guessing a path.
  it("reads back over the ordinary TCP route that carries no import surface", async () => {
    const bytes = Buffer.from("preserved nested evidence\n".repeat(12), "utf8");
    const itemId = await registerItem(bytes);
    const host = await bootHost({ hostState, runtimeRoot });

    try {
      await call({
        method: "PUT",
        path: `/imports/${IMPORT_ID}/items/${itemId}/chunks/0`,
        headers: chunkHeaders({ offset: 0, bytes }),
        body: bytes,
      });

      const { objectId } = JSON.parse(
        (
          await call({
            method: "POST",
            path: `/imports/${IMPORT_ID}/items/${itemId}/seal`,
            headers: controlHeaders(),
          })
        ).body,
      ) as { objectId: string };
      const readback = await fetch(
        `${host.url}/runtime-objects/${objectId}/content`,
        { headers: { connection: "close" } },
      );

      expect(readback.status).toBe(200);
      expect(new Uint8Array(await readback.arrayBuffer())).toEqual(
        new Uint8Array(bytes),
      );

      for (const [method, path] of [
        ["GET", `/imports/${IMPORT_ID}`],
        ["POST", `/imports/${IMPORT_ID}/items/${itemId}/seal`],
        ["DELETE", `/imports/${IMPORT_ID}/admission`],
      ] as const) {
        const denied = await fetch(`${host.url}${path}`, {
          method,
          headers: { ...controlHeaders(), connection: "close" },
        });

        expect(denied.status, `${method} ${path}`).toBe(404);
      }
    } finally {
      await host.stop();
    }
  });

  // An empty `<step>.log` is ordinary Stage A history, and the cut-over
  // contract calls it valid. It carries no chunk at all, so the seal must
  // still produce a real zero-byte object rather than fail on a spool file
  // nothing ever created.
  it("seals a source the manifest declared empty", async () => {
    const itemId = await registerItem(new Uint8Array(0));
    const sealed = await call({
      method: "POST",
      path: `/imports/${IMPORT_ID}/items/${itemId}/seal`,
      headers: controlHeaders(),
    });

    expect(sealed.status).toBe(200);

    const receipt = JSON.parse(sealed.body) as { objectId: string };
    const object = hostState.getRuntimeObject(receipt.objectId);

    expect(object?.state).toBe("available");
    expect(object?.sizeBytes).toBe(0);
    expect(await readFile(object!.privatePath)).toEqual(Buffer.alloc(0));
  });

  it("never claims an active assignment for imported history", async () => {
    const bytes = Buffer.from("history\n", "utf8");
    const itemId = await registerItem(bytes);

    await call({
      method: "PUT",
      path: `/imports/${IMPORT_ID}/items/${itemId}/chunks/0`,
      headers: chunkHeaders({ offset: 0, bytes }),
      body: bytes,
    });
    const sealed = await call({
      method: "POST",
      path: `/imports/${IMPORT_ID}/items/${itemId}/seal`,
      headers: controlHeaders(),
    });
    const object = hostState.getRuntimeObject(
      (JSON.parse(sealed.body) as { objectId: string }).objectId,
    );

    expect(object?.assignmentEpoch).toBe(0);
    expect(object?.hostSessionId).toBeNull();
  });

  it("replays a seal and refuses one before every byte arrived", async () => {
    const bytes = Buffer.from("abcdefghij", "utf8");
    const itemId = await registerItem(bytes);
    const first = bytes.subarray(0, 5);

    await call({
      method: "PUT",
      path: `/imports/${IMPORT_ID}/items/${itemId}/chunks/0`,
      headers: chunkHeaders({ offset: 0, bytes: first }),
      body: first,
    });
    expect(
      (
        await call({
          method: "POST",
          path: `/imports/${IMPORT_ID}/items/${itemId}/seal`,
          headers: controlHeaders(),
        })
      ).reason,
    ).toBe("import_item_incomplete");

    const second = bytes.subarray(5);

    await call({
      method: "PUT",
      path: `/imports/${IMPORT_ID}/items/${itemId}/chunks/1`,
      headers: chunkHeaders({ offset: 5, bytes: second }),
      body: second,
    });
    const sealed = await call({
      method: "POST",
      path: `/imports/${IMPORT_ID}/items/${itemId}/seal`,
      headers: controlHeaders(),
    });
    const replay = await call({
      method: "POST",
      path: `/imports/${IMPORT_ID}/items/${itemId}/seal`,
      headers: controlHeaders(),
    });

    expect(replay.status).toBe(200);
    expect(JSON.parse(replay.body)).toEqual(JSON.parse(sealed.body));
  });

  it("preserves a source past the ordinary whole-upload limit", async () => {
    const bytes = Buffer.alloc(26 * 1024 * 1024 + 1024, 3);
    const itemId = await registerItem(bytes);
    const chunkBytes = 8 * 1024 * 1024;

    for (
      let offset = 0, index = 0;
      offset < bytes.byteLength;
      offset += chunkBytes, index += 1
    ) {
      const slice = bytes.subarray(
        offset,
        Math.min(offset + chunkBytes, bytes.byteLength),
      );
      const response = await call({
        method: "PUT",
        path: `/imports/${IMPORT_ID}/items/${itemId}/chunks/${index}`,
        headers: chunkHeaders({ offset, bytes: slice }),
        body: slice,
      });

      expect(response.status).toBe(200);
    }

    const sealed = await call({
      method: "POST",
      path: `/imports/${IMPORT_ID}/items/${itemId}/seal`,
      headers: controlHeaders(),
    });

    expect(sealed.status).toBe(200);
    expect(JSON.parse(sealed.body)).toMatchObject({
      sizeBytes: bytes.byteLength,
      sha256: sha256(bytes),
    });
  }, 60_000);

  it("never mutates or removes the operator source", async () => {
    const sourcePath = join(directory, "source.log");
    const bytes = Buffer.from("untouched\n", "utf8");

    await writeFile(sourcePath, bytes);
    const before = await stat(sourcePath);
    const itemId = await registerItem(bytes);

    await call({
      method: "PUT",
      path: `/imports/${IMPORT_ID}/items/${itemId}/chunks/0`,
      headers: chunkHeaders({ offset: 0, bytes }),
      body: bytes,
    });
    await call({
      method: "POST",
      path: `/imports/${IMPORT_ID}/items/${itemId}/seal`,
      headers: controlHeaders(),
    });
    const after = await stat(sourcePath);

    expect(after.size).toBe(before.size);
    expect(await readFile(sourcePath)).toEqual(bytes);
  });
});

// The four maintenance routes carry no Zod schema, so their published bodies
// would otherwise be unverified prose. Every one of these schemas is
// `additionalProperties: false`, so the live body must carry exactly the
// documented keys — a drift in either direction is a lie in the contract.
describe("published response contract", () => {
  const openapi = parse(
    readFileSync(
      resolve(
        fileURLToPath(import.meta.url),
        "../../../../docs/api/supervisor.openapi.yaml",
      ),
      "utf8",
    ),
  ) as {
    components: {
      schemas: Record<string, { required: string[]; properties: object }>;
    };
  };

  function documented(name: string): string[] {
    const schema = openapi.components.schemas[name];

    if (!schema) throw new Error(`OpenAPI schema ${name} missing`);

    return [...schema.required].sort();
  }

  it("answers each route with exactly the keys it publishes", async () => {
    const bytes = Buffer.from("published\n", "utf8");
    const itemId = await registerItem(bytes);
    const progress = JSON.parse(
      (
        await call({
          method: "GET",
          path: `/imports/${IMPORT_ID}`,
          headers: controlHeaders(),
        })
      ).body,
    ) as ProgressBody;

    expect(Object.keys(progress).sort()).toEqual(documented("ImportProgress"));
    expect(Object.keys(progress.totals).sort()).toEqual(
      documented("ImportTotals"),
    );
    expect(Object.keys(progress.items[0]).sort()).toEqual(
      documented("ImportItemProgress"),
    );

    const ack = JSON.parse(
      (
        await call({
          method: "PUT",
          path: `/imports/${IMPORT_ID}/items/${itemId}/chunks/0`,
          headers: chunkHeaders({ offset: 0, bytes }),
          body: bytes,
        })
      ).body,
    ) as object;

    expect(Object.keys(ack).sort()).toEqual(documented("ImportChunkAck"));

    const receipt = JSON.parse(
      (
        await call({
          method: "POST",
          path: `/imports/${IMPORT_ID}/items/${itemId}/seal`,
          headers: controlHeaders(),
        })
      ).body,
    ) as object;

    expect(Object.keys(receipt).sort()).toEqual(
      documented("ImportSealReceipt"),
    );
  });
});
