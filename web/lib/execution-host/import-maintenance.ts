import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { MaisterError } from "@/lib/errors";
import { supervisorErrorToMaister } from "@/lib/supervisor-client";

// S4.3 / D9: the operator's half of the maintenance import protocol.
//
// This is NOT part of `createExecutionHosts()` and never will be. A driver
// reaches the host through `BoundClient`/`HostAdminClient` over loopback TCP,
// where none of these routes exist; this client speaks only to the Unix socket
// the operator hands it, inside a directory only the operator can enter. Domain
// code cannot obtain one, and the ESLint boundary refuses the import outright.
//
// The manifest file is opened READ-ONLY and only the operator side ever learns
// a relative path from it — the wire carries item digests, byte offsets and
// checksums, never a name.

export const IMPORT_CHUNK_BYTES = 8 * 1024 * 1024;

export type OperatorImportItem = {
  itemId: string;
  runId: string;
  lane: string;
  // Operator-local: the source this item was inventoried from. It is read to
  // open the file and never travels on the wire.
  relativePath: string;
  sizeBytes: number;
  sha256: string;
  // `source`, `event_rows`, or `artifact:<id>` / `attachment:<id>` — the row
  // this item's bytes belong to. S4.4 rewrites exactly those rows, and only
  // against the fingerprint the inventory froze for each.
  associationKey: string;
  // S4.8: what the inventory classified the source as; the manager catalogue
  // kind is derived from it, never from a file name.
  sourceClass: string;
  rowFingerprint: string | null;
};

export type OperatorImportManifest = {
  importId: string;
  digest: string;
  items: OperatorImportItem[];
};

export type ImportItemState = "pending" | "receiving" | "sealed";

export type ImportItemProgress = {
  itemId: string;
  sizeBytes: number;
  receivedBytes: number;
  state: ImportItemState;
  sealedObjectId: string | null;
};

export type ImportProgress = {
  totals: {
    items: number;
    sealed: number;
    receivedBytes: number;
    expectedBytes: number;
  };
  items: ImportItemProgress[];
  // S4.8: the identity the manager binds every catalogued object to.
  host: { hostKey: string };
};

export type ImportChunkAck = {
  outcome: "committed" | "duplicate";
  receivedBytes: number;
};

export type ImportSealReceipt = {
  objectId: string;
  sizeBytes: number;
  sha256: string;
};

export type ImportReadback = { sizeBytes: number; sha256: string };

export type ImportMaintenanceClient = {
  progress(): Promise<ImportProgress>;
  // S4.5: streams the sealed object back and folds it into a digest as it
  // arrives. The whole point of the import protocol is that no history is ever
  // held whole, and proving it must not be the one step that does.
  readbackDigest(itemId: string): Promise<ImportReadback>;
  putChunk(input: {
    itemId: string;
    chunkIndex: number;
    offset: number;
    bytes: Uint8Array;
  }): Promise<ImportChunkAck>;
  seal(itemId: string): Promise<ImportSealReceipt>;
  revokeAdmission(): Promise<void>;
};

function integer(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : Number(value);
}

// Mirrors `loadOperatorManifest` in the supervisor package: the same file, the
// same lane ordering, the same digest. The two cannot be one function across the
// package boundary, so a shared vector is asserted verbatim in both suites —
// see `derives the digest the supervisor derives (shared vector)`.
export function readOperatorImportManifest(input: {
  directory: string;
  importId: string;
}): OperatorImportManifest {
  const file = join(input.directory, `import-${input.importId}.sqlite`);

  if (!existsSync(file)) {
    throw new MaisterError(
      "PRECONDITION",
      `operator import manifest is missing for ${input.importId}`,
      { details: { reason: "import_manifest_mismatch" } },
    );
  }

  const db = new DatabaseSync(file, { readOnly: true });

  try {
    const lanes = db
      .prepare(
        `SELECT run_id AS runId, lane, manifest_digest AS manifestDigest
         FROM import_lanes WHERE import_id = ?`,
      )
      .all(input.importId)
      .map(
        (row) =>
          `${String(row.runId)}|${String(row.lane)}|${String(row.manifestDigest)}`,
      )
      .sort();

    if (lanes.length === 0) {
      throw new MaisterError(
        "PRECONDITION",
        `operator import manifest for ${input.importId} covers no lane`,
        { details: { reason: "import_manifest_mismatch" } },
      );
    }

    const digest = createHash("sha256")
      .update([input.importId, ...lanes].join("\n"), "utf8")
      .digest("hex");
    const items = db
      .prepare(
        `SELECT item_id AS itemId, run_id AS runId, lane,
            relative_path AS relativePath, size_bytes AS sizeBytes, sha256,
            association_key AS associationKey, row_fingerprint AS rowFingerprint,
            source_class AS sourceClass
         FROM import_items
         WHERE import_id = ? AND disposition = 'copy'
         ORDER BY item_id`,
      )
      .all(input.importId)
      .map((row) => ({
        itemId: String(row.itemId),
        runId: String(row.runId),
        lane: String(row.lane),
        relativePath: String(row.relativePath),
        sizeBytes: integer(row.sizeBytes),
        sha256: String(row.sha256),
        associationKey: String(row.associationKey),
        rowFingerprint:
          row.rowFingerprint === null ? null : String(row.rowFingerprint),
        sourceClass: String(row.sourceClass),
      }));

    return { importId: input.importId, digest, items };
  } finally {
    db.close();
  }
}

type SocketResponse = { status: number; body: unknown };

function send(input: {
  socketPath: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}): Promise<SocketResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: input.socketPath,
        method: input.method,
        path: input.path,
        headers: input.headers,
      },
      (res) => {
        const chunks: Uint8Array[] = [];

        res.on("data", (chunk: Uint8Array) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: unknown = null;

          try {
            body = text.length > 0 ? JSON.parse(text) : null;
          } catch {
            body = null;
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );

    req.on("error", reject);
    if (input.body) req.write(input.body);
    req.end();
  });
}

export function createImportMaintenanceClient(input: {
  socketPath: string;
  importId: string;
  generation: number;
  manifestDigest: string;
}): ImportMaintenanceClient {
  const control = (): Record<string, string> => ({
    "x-maister-import-generation": String(input.generation),
    "x-maister-import-manifest": input.manifestDigest,
  });

  async function call(
    method: string,
    path: string,
    extra: { headers?: Record<string, string>; body?: Uint8Array } = {},
  ): Promise<unknown> {
    let response: SocketResponse;

    try {
      response = await send({
        socketPath: input.socketPath,
        method,
        path,
        headers: { ...control(), ...extra.headers },
        body: extra.body,
      });
    } catch (error) {
      // The authority is unreachable — the supervisor is down, or admission was
      // never enabled and the socket does not exist. Neither is a refusal, and
      // neither proves anything about what the host already committed.
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        `import maintenance socket is unreachable for ${input.importId}`,
        { cause: error },
      );
    }

    if (response.status >= 400) {
      throw supervisorErrorToMaister(
        response.status,
        response.body,
        "ACP_PROTOCOL",
      );
    }

    return response.body;
  }

  return {
    async progress() {
      return (await call(
        "GET",
        `/imports/${input.importId}`,
      )) as ImportProgress;
    },

    async readbackDigest(itemId) {
      return await new Promise<ImportReadback>((settle, fail) => {
        const req = request(
          {
            socketPath: input.socketPath,
            method: "GET",
            path: `/imports/${input.importId}/items/${itemId}/content`,
            headers: control(),
          },
          (res) => {
            const status = res.statusCode ?? 0;

            if (status >= 400) {
              const chunks: Uint8Array[] = [];

              res.on("data", (chunk: Uint8Array) => chunks.push(chunk));
              res.on("end", () => {
                let body: unknown = null;

                try {
                  body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                } catch {
                  body = null;
                }
                fail(supervisorErrorToMaister(status, body, "ACP_PROTOCOL"));
              });

              return;
            }

            const hash = createHash("sha256");
            let sizeBytes = 0;

            res.on("data", (chunk: Uint8Array) => {
              hash.update(chunk);
              sizeBytes += chunk.byteLength;
            });
            res.on("error", fail);
            res.on("end", () =>
              settle({ sizeBytes, sha256: hash.digest("hex") }),
            );
          },
        );

        req.on("error", (error) =>
          fail(
            new MaisterError(
              "EXECUTOR_UNAVAILABLE",
              `import maintenance socket is unreachable for ${input.importId}`,
              { cause: error },
            ),
          ),
        );
        req.end();
      });
    },

    async putChunk(chunk) {
      // Refused locally: a body the host would reject costs a round trip and,
      // worse, a partial write the ledger then has to reconcile.
      if (chunk.bytes.byteLength > IMPORT_CHUNK_BYTES) {
        throw new MaisterError(
          "PRECONDITION",
          `chunk exceeds ${IMPORT_CHUNK_BYTES} bytes`,
          { details: { reason: "import_chunk_too_large" } },
        );
      }

      return (await call(
        "PUT",
        `/imports/${input.importId}/items/${chunk.itemId}/chunks/${chunk.chunkIndex}`,
        {
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(chunk.bytes.byteLength),
            "x-maister-import-offset": String(chunk.offset),
            "x-maister-sha256": createHash("sha256")
              .update(chunk.bytes)
              .digest("hex"),
          },
          body: chunk.bytes,
        },
      )) as ImportChunkAck;
    },

    async seal(itemId) {
      return (await call(
        "POST",
        `/imports/${input.importId}/items/${itemId}/seal`,
      )) as ImportSealReceipt;
    },

    async revokeAdmission() {
      await call("DELETE", `/imports/${input.importId}/admission`);
    },
  };
}
