import type { Logger } from "pino";
import type { HostState } from "./host-state";
import type { ImportAdmissionRegistry } from "./import-admin";
import type { ImportProgressLedger } from "./import-progress";

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, open, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import Fastify, { type FastifyInstance } from "fastify";

import { sealObjectFile } from "./runtime-object-files";
import {
  errorBody,
  httpStatusForCode,
  isSupervisorError,
  SupervisorError,
} from "./types";

// S4.3 / D9: the maintenance import protocol. A second Fastify instance bound to
// a Unix socket inside the operator-owned directory — never the TCP listener the
// web process reaches. Every route is manifest-bound: the caller names an item
// identity the operator already inventoried, and the host compares the
// generation, manifest digest, offset and checksum against its own ledger before
// a byte lands. No route takes a path, and no import ever claims a live
// assignment: imported history is written at assignment epoch 0, which no real
// fence can ever equal.

export const MAX_IMPORT_CHUNK_BYTES = 8 * 1024 * 1024;
const IMPORT_ASSIGNMENT_EPOCH = 0;
const ITEM_ID = /^[0-9a-f]{64}$/;

export type ImportListener = {
  socketPath: string;
  close(): Promise<void>;
};

export type ImportSealReceipt = {
  objectId: string;
  sizeBytes: number;
  sha256: string;
};

type ImportListenerReason =
  | "import_item_unknown"
  | "import_item_incomplete"
  | "import_chunk_conflict"
  | "import_chunk_too_large"
  | "import_offset_mismatch"
  | "runtime_object_missing";

function refuse(reason: ImportListenerReason, message?: string): never {
  throw new SupervisorError("PRECONDITION", message ?? reason, {
    details: { reason },
  });
}

function requireHeader(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    refuse("import_chunk_conflict", `${name} is required`);
  }

  return value;
}

function requireItemId(value: unknown): string {
  if (typeof value !== "string" || !ITEM_ID.test(value)) {
    refuse("import_item_unknown");
  }

  return value;
}

function requireInteger(value: unknown, name: string): number {
  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    refuse("import_chunk_conflict", `${name} is not a bounded integer`);
  }

  return parsed;
}

export async function startImportListener(input: {
  directory: string;
  importId: string;
  manifestDigest: string;
  admission: ImportAdmissionRegistry;
  ledger: ImportProgressLedger;
  hostState: HostState;
  runtimeRoot: string;
  logger: Logger;
  now?: () => Date;
}): Promise<ImportListener> {
  const now = input.now ?? (() => new Date());
  const admissionDirectory = join(input.directory, "admission");
  const spoolDirectory = join(admissionDirectory, "spool");
  const socketPath = join(admissionDirectory, "import.sock");

  // Derived, never supplied: an imported object that landed outside the host's
  // own object root would be invisible to storage accounting and to the
  // retention sweep. This is the same expression the TCP app uses.
  const objectRoot = join(
    input.hostState.stateDirReal ?? input.runtimeRoot,
    "runtime-objects",
  );

  await mkdir(spoolDirectory, { recursive: true, mode: 0o700 });
  await chmod(admissionDirectory, 0o700);
  await mkdir(objectRoot, { recursive: true, mode: 0o700 });
  await rm(socketPath, { force: true });

  const app = Fastify({
    logger: false,
    bodyLimit: MAX_IMPORT_CHUNK_BYTES + 1024,
  });

  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );

  app.setErrorHandler((error, _req, reply) => {
    if (isSupervisorError(error)) {
      input.logger.warn(
        {
          event: "import_request_refused",
          importId: input.importId,
          reason: error.details?.reason ?? null,
        },
        "import request refused",
      );
      reply.status(httpStatusForCode(error.code)).send(errorBody(error));

      return;
    }
    input.logger.error(
      { event: "import_request_failed", importId: input.importId },
      "import request failed",
    );
    reply.status(500).send({ code: "CRASH", message: "import request failed" });
  });

  const admit = (
    params: { importId?: string },
    headers: Record<string, unknown>,
  ): void => {
    input.admission.require({
      importId: String(params.importId ?? ""),
      generation: Number(headers["x-maister-import-generation"]),
      manifestDigest: String(headers["x-maister-import-manifest"] ?? ""),
    });
  };

  const spoolPath = (itemId: string): string => {
    const path = resolve(spoolDirectory, itemId);

    if (!path.startsWith(`${resolve(spoolDirectory)}/`))
      refuse("import_item_unknown");

    return path;
  };

  app.get("/imports/:importId", async (req, reply) => {
    admit(req.params as { importId?: string }, req.headers);
    const totals = input.ledger.snapshot();
    const items = input.ledger
      .items()
      .map(({ itemId, sizeBytes, receivedBytes, state, sealedObjectId }) => ({
        itemId,
        sizeBytes,
        receivedBytes,
        state,
        sealedObjectId,
      }));

    // `totals` stays a sibling of `items`: the snapshot's own item COUNT and
    // the per-item list are different answers and cannot share a key. `host`
    // is the identity the manager binds each catalogued object to (S4.8): the
    // key of the host that actually holds the bytes, stated by that host.
    reply
      .status(200)
      .send({ totals, items, host: { hostKey: input.hostState.hostKey } });
  });

  app.put(
    "/imports/:importId/items/:itemId/chunks/:chunkIndex",
    async (req, reply) => {
      const params = req.params as {
        importId?: string;
        itemId?: string;
        chunkIndex?: string;
      };

      admit(params, req.headers);

      const itemId = requireItemId(params.itemId);
      const chunkIndex = requireInteger(params.chunkIndex, "chunk index");
      const offset = requireInteger(
        req.headers["x-maister-import-offset"],
        "offset",
      );
      const declared = requireHeader(
        req.headers["x-maister-sha256"],
        "x-maister-sha256",
      );
      const body = req.body;

      if (!Buffer.isBuffer(body))
        refuse("import_chunk_conflict", "chunk must be binary");
      if (body.byteLength > MAX_IMPORT_CHUNK_BYTES)
        refuse("import_chunk_too_large");
      if (body.byteLength === 0)
        refuse("import_chunk_conflict", "chunk is empty");

      const actual = createHash("sha256")
        .update(new Uint8Array(body))
        .digest("hex");

      if (actual !== declared) refuse("import_chunk_conflict");

      const registered = input.ledger.itemProgress(itemId);

      if (!registered) refuse("import_item_unknown");
      // Bounded BEFORE the write, not only in the ledger: a refused chunk that
      // still extended the spool would leave bytes the seal then measures
      // against the manifest, making the item permanently unsealable.
      if (offset + body.byteLength > registered.sizeBytes)
        refuse("import_offset_mismatch");

      // Positional writes make a replayed chunk harmless: the same bytes land at
      // the same offset, so the ledger — not the file — decides whether this was a
      // duplicate or a conflict.
      const handle = await open(spoolPath(itemId), "a+", 0o600);

      try {
        await handle.write(new Uint8Array(body), 0, body.byteLength, offset);
        await handle.sync();
      } finally {
        await handle.close();
      }

      const outcome = input.ledger.commitChunk({
        itemId,
        chunkIndex,
        offset,
        length: body.byteLength,
        sha256: actual,
      });
      const progress = input.ledger.itemProgress(itemId);

      input.logger.info(
        {
          event: "import_chunk_committed",
          importId: input.importId,
          itemId,
          chunkIndex,
          offset,
          bytes: body.byteLength,
          outcome,
          receivedBytes: progress?.receivedBytes ?? 0,
        },
        "import chunk committed",
      );
      reply
        .status(200)
        .send({ outcome, receivedBytes: progress?.receivedBytes ?? 0 });
    },
  );

  app.post("/imports/:importId/items/:itemId/seal", async (req, reply) => {
    const params = req.params as { importId?: string; itemId?: string };

    admit(params, req.headers);

    const itemId = requireItemId(params.itemId);
    const item = input.ledger.itemProgress(itemId);

    if (!item) refuse("import_item_unknown");
    if (item.state === "sealed" && item.sealedObjectId) {
      reply.status(200).send({
        objectId: item.sealedObjectId,
        sizeBytes: item.sizeBytes,
        sha256: item.sha256,
      } satisfies ImportSealReceipt);

      return;
    }
    if (item.receivedBytes !== item.sizeBytes) {
      throw new SupervisorError("PRECONDITION", "import_item_incomplete", {
        details: { reason: "import_item_incomplete" },
      });
    }

    const objectId = randomUUID();
    const destinationPath = resolve(objectRoot, `${objectId}.1`);

    // A source the manifest declared empty carries no chunk, so nothing ever
    // created its spool file. An empty legacy log is ordinary history and must
    // seal into a real zero-byte object, not fail on a missing spool.
    if (item.sizeBytes === 0)
      await (await open(spoolPath(itemId), "a", 0o600)).close();

    const sealed = await sealObjectFile({
      path: spoolPath(itemId),
      destinationPath,
      temporaryPath: `${destinationPath}.part`,
      // D9: historical logs are not bound by the ordinary whole-upload limit;
      // the manifest's own declared size is the bound.
      maxBytes: item.sizeBytes,
      expected: { sizeBytes: item.sizeBytes, sha256: item.sha256 },
    });
    const timestamp = now().toISOString();

    input.hostState.insertRuntimeObject({
      id: objectId,
      runId: item.runId,
      assignmentId: `import:${input.importId}`,
      assignmentEpoch: IMPORT_ASSIGNMENT_EPOCH,
      hostSessionId: null,
      kind: "historical_import",
      logicalName: itemId,
      mimeType: "application/octet-stream",
      sizeBytes: sealed.sizeBytes,
      sha256: sealed.sha256,
      generation: 1,
      retentionClass: "run",
      state: "available",
      privatePath: destinationPath,
      producerPath: null,
      sealedDevice: sealed.sealedDevice,
      sealedInode: sealed.sealedInode,
      createdAt: timestamp,
      sealedAt: timestamp,
      expiresAt: null,
      deletedAt: null,
      lastError: null,
    });
    // The object row is written before the ledger's seal, so a crash between
    // them leaves a sealed object the ledger has not claimed. That is the
    // sealed-orphan case D9 step 11 reconciles against the frozen manifest; it
    // is preferable to the inverse, where the ledger would claim bytes the host
    // never actually holds.
    input.ledger.sealItem({ itemId, objectId });
    await rm(spoolPath(itemId), { force: true });
    input.logger.info(
      {
        event: "import_item_sealed",
        importId: input.importId,
        itemId,
        objectId,
        bytes: sealed.sizeBytes,
      },
      "import item sealed",
    );
    reply.status(200).send({
      objectId,
      sizeBytes: sealed.sizeBytes,
      sha256: sealed.sha256,
    } satisfies ImportSealReceipt);
  });

  // S4.5 / D9 step 9: a lane is proved against the SEALED object — never the
  // spool, and never the ledger's own record of it. This streams exactly the
  // file the ordinary content route would serve, so the operator's hash is a
  // statement about what the host can still hand back, not about what it once
  // received.
  app.get("/imports/:importId/items/:itemId/content", async (req, reply) => {
    const params = req.params as { importId?: string; itemId?: string };

    admit(params, req.headers);

    const itemId = requireItemId(params.itemId);
    const item = input.ledger.itemProgress(itemId);

    if (!item) refuse("import_item_unknown");
    if (item.state !== "sealed" || !item.sealedObjectId)
      refuse("import_item_incomplete");

    const objectPath = resolve(objectRoot, `${item.sealedObjectId}.1`);

    if (!(await stat(objectPath).catch(() => null)))
      refuse("runtime_object_missing");

    return reply
      .header("content-type", "application/octet-stream")
      .header("x-maister-object-id", item.sealedObjectId)
      .send(createReadStream(objectPath));
  });

  app.delete("/imports/:importId/admission", async (req, reply) => {
    const params = req.params as { importId?: string };

    admit(params, req.headers);

    const snapshot = input.admission.snapshot();

    if (snapshot.enabled) input.ledger.revokeGeneration(snapshot.generation);
    input.admission.revoke(String(params.importId ?? ""));
    input.logger.info(
      {
        event: "import_admission_revoked",
        importId: input.importId,
        generation: snapshot.enabled ? snapshot.generation : null,
      },
      "import admission revoked",
    );
    reply.status(200).send({ revoked: true });
  });

  await app.listen({ path: socketPath });
  await chmod(socketPath, 0o600);

  return {
    socketPath,
    async close() {
      await app.close();
      await rm(socketPath, { force: true });
    },
  };
}

export type { FastifyInstance };
