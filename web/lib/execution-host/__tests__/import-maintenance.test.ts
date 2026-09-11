// S4.3 / D9: the operator's half of the maintenance import protocol. It reads
// the frozen manifest this host's supervisor was enabled for, derives the same
// digest that supervisor derives, and speaks the protocol over the operator's
// Unix socket. It is deliberately outside `createExecutionHosts()`: no domain
// code can obtain one, and it can address nothing but the socket it was handed.

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createImportMaintenanceClient,
  IMPORT_CHUNK_BYTES,
  readOperatorImportManifest,
  type ImportMaintenanceClient,
} from "../import-maintenance";

const IMPORT_ID = "inv-1";
const LANES = [
  { runId: "run-1", lane: "runtime_objects", digest: "1".repeat(64) },
  { runId: "run-1", lane: "transcript", digest: "2".repeat(64) },
];

let directory: string;
let socketPath: string;
let server: Server | null = null;
let seen: Array<{
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  body: Uint8Array;
}>;

function writeManifest(
  items: Array<{
    itemId: string;
    lane?: string;
    relativePath: string;
    size: number;
    sha256: string;
    disposition?: string;
  }>,
): void {
  const db = new DatabaseSync(join(directory, `import-${IMPORT_ID}.sqlite`));

  db.exec(`
    CREATE TABLE IF NOT EXISTS import_lanes (
      import_id TEXT, run_id TEXT, lane TEXT, manifest_digest TEXT,
      inspected_scope TEXT, expected_items INTEGER, total_bytes INTEGER
    );
    CREATE TABLE IF NOT EXISTS import_items (
      import_id TEXT, item_id TEXT, run_id TEXT, lane TEXT, source_class TEXT,
      disposition TEXT, association_key TEXT, row_fingerprint TEXT,
      association_locator TEXT, relative_path TEXT, relative_path_digest TEXT,
      size_bytes INTEGER, sha256 TEXT
    );
  `);
  for (const lane of LANES) {
    db.prepare(
      `INSERT INTO import_lanes
        (import_id, run_id, lane, manifest_digest, inspected_scope,
         expected_items, total_bytes)
       VALUES (?, ?, ?, ?, 'scope', 0, 0)`,
    ).run(IMPORT_ID, lane.runId, lane.lane, lane.digest);
  }
  for (const item of items) {
    db.prepare(
      `INSERT INTO import_items
        (import_id, item_id, run_id, lane, source_class, disposition,
         association_key, row_fingerprint, association_locator, relative_path,
         relative_path_digest, size_bytes, sha256)
       VALUES (?, ?, 'run-1', ?, 'step_log', ?, 'source', NULL, NULL, ?, 'pd', ?, ?)`,
    ).run(
      IMPORT_ID,
      item.itemId,
      item.lane ?? "runtime_objects",
      item.disposition ?? "copy",
      item.relativePath,
      item.size,
      item.sha256,
    );
  }
  db.close();
}

function serve(
  handler: (
    request: { method: string; url: string },
    reply: (status: number, body: unknown) => void,
  ) => void,
): Promise<void> {
  server = createServer((req, res) => {
    const chunks: Uint8Array[] = [];

    req.on("data", (chunk: Buffer) => chunks.push(new Uint8Array(chunk)));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers as Record<string, string | undefined>,
        body: new Uint8Array(Buffer.concat(chunks)),
      });
      handler(
        { method: req.method ?? "", url: req.url ?? "" },
        (status, body) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        },
      );
    });
  });

  return new Promise((resolve) => server!.listen(socketPath, () => resolve()));
}

function client(
  overrides: { generation?: number } = {},
): ImportMaintenanceClient {
  return createImportMaintenanceClient({
    socketPath,
    importId: IMPORT_ID,
    generation: overrides.generation ?? 3,
    manifestDigest: "f".repeat(64),
  });
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "import-maintenance-"));
  socketPath = join(directory, "import.sock");
  seen = [];
});

afterEach(async () => {
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  await rm(directory, { recursive: true, force: true });
});

describe("readOperatorImportManifest", () => {
  // Pinned verbatim against supervisor/src/__tests__/import-manifest.test.ts:
  // the two derivations live in different packages and can only be held
  // together by one shared vector.
  it("derives the digest the supervisor derives (shared vector)", () => {
    writeManifest([
      {
        itemId: "a".repeat(64),
        relativePath: "plan.log",
        size: 10,
        sha256: "b".repeat(64),
      },
    ]);

    expect(
      readOperatorImportManifest({ directory, importId: IMPORT_ID }).digest,
    ).toBe("d8630ca9acbdc0b3c0c23fd310a0811f10e6a98470a191fea6b5a497b3689f53");
  });

  it("returns only the sources the host must actually receive", () => {
    writeManifest([
      {
        itemId: "a".repeat(64),
        relativePath: "plan.log",
        size: 10,
        sha256: "b".repeat(64),
      },
      {
        itemId: "c".repeat(64),
        lane: "events",
        relativePath: "run.json",
        size: 4,
        sha256: "d".repeat(64),
        disposition: "manager_authoritative",
      },
    ]);

    const manifest = readOperatorImportManifest({
      directory,
      importId: IMPORT_ID,
    });

    expect(manifest.items).toEqual([
      {
        itemId: "a".repeat(64),
        runId: "run-1",
        lane: "runtime_objects",
        relativePath: "plan.log",
        sizeBytes: 10,
        sha256: "b".repeat(64),
        associationKey: "source",
        rowFingerprint: null,
      },
    ]);
  });

  it("refuses a manifest that is not there", () => {
    expect(() =>
      readOperatorImportManifest({ directory, importId: "inv-absent" }),
    ).toThrow(/manifest/i);
  });
});

describe("createImportMaintenanceClient", () => {
  it("carries the enabled generation and manifest digest on every request", async () => {
    await serve((_req, reply) =>
      reply(200, {
        totals: { items: 0, sealed: 0, receivedBytes: 0, expectedBytes: 0 },
        items: [],
      }),
    );

    await client().progress();

    expect(seen[0].headers["x-maister-import-generation"]).toBe("3");
    expect(seen[0].headers["x-maister-import-manifest"]).toBe("f".repeat(64));
    expect(seen[0].url).toBe(`/imports/${IMPORT_ID}`);
  });

  it("declares each chunk's offset and checksum and never its source path", async () => {
    const bytes = new Uint8Array(Buffer.from("preserved\n", "utf8"));

    await serve((_req, reply) =>
      reply(200, { outcome: "committed", receivedBytes: 10 }),
    );

    const ack = await client().putChunk({
      itemId: "a".repeat(64),
      chunkIndex: 2,
      offset: 16,
      bytes,
    });

    expect(ack).toEqual({ outcome: "committed", receivedBytes: 10 });
    expect(seen[0].method).toBe("PUT");
    expect(seen[0].url).toBe(
      `/imports/${IMPORT_ID}/items/${"a".repeat(64)}/chunks/2`,
    );
    expect(seen[0].headers["x-maister-import-offset"]).toBe("16");
    expect(seen[0].headers["x-maister-sha256"]).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(seen[0].body).toEqual(bytes);
  });

  it("refuses to send more than the protocol's bounded chunk", async () => {
    await serve((_req, reply) =>
      reply(200, { outcome: "committed", receivedBytes: 0 }),
    );

    await expect(
      client().putChunk({
        itemId: "a".repeat(64),
        chunkIndex: 0,
        offset: 0,
        bytes: new Uint8Array(IMPORT_CHUNK_BYTES + 1),
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION",
      details: { reason: "import_chunk_too_large" },
    });
    expect(seen).toHaveLength(0);
  });

  it("raises the host's typed refusal rather than a status code", async () => {
    await serve((_req, reply) =>
      reply(409, {
        code: "PRECONDITION",
        message: "import_generation_stale",
        details: { reason: "import_generation_stale" },
      }),
    );

    await expect(client({ generation: 1 }).progress()).rejects.toMatchObject({
      code: "PRECONDITION",
      details: { reason: "import_generation_stale" },
    });
  });

  it("seals an item and returns the ordinary object it became", async () => {
    await serve((_req, reply) =>
      reply(200, {
        objectId: "0d1a0a7e-2f6a-4b0f-9a1f-1b2c3d4e5f60",
        sizeBytes: 10,
        sha256: "b".repeat(64),
      }),
    );

    expect(await client().seal("a".repeat(64))).toEqual({
      objectId: "0d1a0a7e-2f6a-4b0f-9a1f-1b2c3d4e5f60",
      sizeBytes: 10,
      sha256: "b".repeat(64),
    });
    expect(seen[0].method).toBe("POST");
    expect(seen[0].url).toBe(
      `/imports/${IMPORT_ID}/items/${"a".repeat(64)}/seal`,
    );
  });

  it("closes admission through the protocol's one-way route", async () => {
    await serve((_req, reply) => reply(200, { revoked: true }));

    await client().revokeAdmission();

    expect(seen[0].method).toBe("DELETE");
    expect(seen[0].url).toBe(`/imports/${IMPORT_ID}/admission`);
  });

  it("reports an unreachable authority as an unavailable host, not a refusal", async () => {
    await expect(client().progress()).rejects.toMatchObject({
      code: "EXECUTOR_UNAVAILABLE",
    });
  });
});
