// S4.3 / D9: the supervisor's own durable import state — generations, per-item
// byte progress and committed chunks. It survives a restart so a stopped
// invocation resumes at a byte offset instead of re-sending history, and it is
// the authority that turns a re-sent chunk into a replay or a typed conflict.

import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  openImportProgressLedger,
  type ImportProgressLedger,
} from "../import-progress";

const MANIFEST = "a".repeat(64);
const ITEM = {
  itemId: "1".repeat(64),
  lane: "runtime_objects" as const,
  runId: "run-1",
  sizeBytes: 12,
  sha256: "b".repeat(64),
};

let directory: string;
let ledger: ImportProgressLedger;

function open(): ImportProgressLedger {
  return openImportProgressLedger({
    file: join(directory, "import-progress-inv-1.sqlite"),
    importId: "inv-1",
    manifestDigest: MANIFEST,
  });
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "import-progress-"));
  ledger = open();
});

afterEach(async () => {
  ledger.close();
  await rm(directory, { recursive: true, force: true });
});

describe("openImportProgressLedger", () => {
  it("creates its database private to the operator", async () => {
    const mode = (await stat(join(directory, "import-progress-inv-1.sqlite")))
      .mode;

    expect(mode & 0o777).toBe(0o600);
  });

  it("refuses a manifest digest that changed under the same import id", () => {
    ledger.enableGeneration();
    ledger.close();

    expect(() =>
      openImportProgressLedger({
        file: join(directory, "import-progress-inv-1.sqlite"),
        importId: "inv-1",
        manifestDigest: "c".repeat(64),
      }),
    ).toThrow(/import_manifest_mismatch/);
    ledger = open();
  });
});

describe("generations", () => {
  it("starts at one and advances on every re-enablement", () => {
    expect(ledger.enableGeneration()).toEqual({ generation: 1 });
    expect(ledger.enableGeneration()).toEqual({ generation: 2 });
  });

  it("survives a restart so a resumed import never reuses a generation", () => {
    ledger.enableGeneration();
    ledger.enableGeneration();
    ledger.close();
    ledger = open();

    expect(ledger.enableGeneration()).toEqual({ generation: 3 });
  });

  it("records a revoked generation durably", () => {
    const { generation } = ledger.enableGeneration();

    ledger.revokeGeneration(generation);
    ledger.close();
    ledger = open();

    expect(ledger.revokedGenerations()).toEqual([generation]);
  });
});

describe("items and chunks", () => {
  beforeEach(() => {
    ledger.enableGeneration();
    ledger.registerItem(ITEM);
  });

  it("registers an item with no bytes received", () => {
    expect(ledger.itemProgress(ITEM.itemId)).toEqual({
      itemId: ITEM.itemId,
      runId: ITEM.runId,
      sizeBytes: 12,
      sha256: ITEM.sha256,
      receivedBytes: 0,
      state: "pending",
      sealedObjectId: null,
    });
  });

  it("reports nothing for an item the manifest never registered", () => {
    expect(ledger.itemProgress("0".repeat(64))).toBeNull();
  });

  it("advances the received offset as chunks commit", () => {
    expect(
      ledger.commitChunk({
        itemId: ITEM.itemId,
        chunkIndex: 0,
        offset: 0,
        length: 5,
        sha256: "d".repeat(64),
      }),
    ).toBe("committed");
    expect(ledger.itemProgress(ITEM.itemId)).toMatchObject({
      receivedBytes: 5,
      state: "receiving",
    });
  });

  it("replays an identical chunk instead of double-counting it", () => {
    const chunk = {
      itemId: ITEM.itemId,
      chunkIndex: 0,
      offset: 0,
      length: 5,
      sha256: "d".repeat(64),
    };

    ledger.commitChunk(chunk);
    expect(ledger.commitChunk(chunk)).toBe("duplicate");
    expect(ledger.itemProgress(ITEM.itemId)?.receivedBytes).toBe(5);
  });

  it("refuses the same chunk index carrying different bytes", () => {
    const chunk = {
      itemId: ITEM.itemId,
      chunkIndex: 0,
      offset: 0,
      length: 5,
      sha256: "d".repeat(64),
    };

    ledger.commitChunk(chunk);
    expect(() =>
      ledger.commitChunk({ ...chunk, sha256: "e".repeat(64) }),
    ).toThrow(/import_chunk_conflict/);
    expect(() => ledger.commitChunk({ ...chunk, length: 6 })).toThrow(
      /import_chunk_conflict/,
    );
  });

  it("refuses a chunk that does not continue from the received offset", () => {
    expect(() =>
      ledger.commitChunk({
        itemId: ITEM.itemId,
        chunkIndex: 0,
        offset: 3,
        length: 5,
        sha256: "d".repeat(64),
      }),
    ).toThrow(/import_offset_mismatch/);
  });

  it("refuses bytes past the size the manifest declared", () => {
    expect(() =>
      ledger.commitChunk({
        itemId: ITEM.itemId,
        chunkIndex: 0,
        offset: 0,
        length: 13,
        sha256: "d".repeat(64),
      }),
    ).toThrow(/import_offset_mismatch/);
  });

  it("resumes at the committed offset after a restart", () => {
    ledger.commitChunk({
      itemId: ITEM.itemId,
      chunkIndex: 0,
      offset: 0,
      length: 7,
      sha256: "d".repeat(64),
    });
    ledger.close();
    ledger = open();

    expect(ledger.itemProgress(ITEM.itemId)).toMatchObject({
      receivedBytes: 7,
      state: "receiving",
    });
  });

  it("seals only once every declared byte arrived", () => {
    ledger.commitChunk({
      itemId: ITEM.itemId,
      chunkIndex: 0,
      offset: 0,
      length: 7,
      sha256: "d".repeat(64),
    });
    expect(() =>
      ledger.sealItem({ itemId: ITEM.itemId, objectId: "obj-1" }),
    ).toThrow(/import_item_incomplete/);

    ledger.commitChunk({
      itemId: ITEM.itemId,
      chunkIndex: 1,
      offset: 7,
      length: 5,
      sha256: "f".repeat(64),
    });
    ledger.sealItem({ itemId: ITEM.itemId, objectId: "obj-1" });
    expect(ledger.itemProgress(ITEM.itemId)).toMatchObject({
      state: "sealed",
      sealedObjectId: "obj-1",
    });
  });

  it("replays a seal for the same object and refuses a different one", () => {
    ledger.commitChunk({
      itemId: ITEM.itemId,
      chunkIndex: 0,
      offset: 0,
      length: 12,
      sha256: "d".repeat(64),
    });
    ledger.sealItem({ itemId: ITEM.itemId, objectId: "obj-1" });
    ledger.sealItem({ itemId: ITEM.itemId, objectId: "obj-1" });
    expect(() =>
      ledger.sealItem({ itemId: ITEM.itemId, objectId: "obj-2" }),
    ).toThrow(/import_seal_conflict/);
  });

  it("refuses a chunk for a sealed item rather than mutating preserved bytes", () => {
    ledger.commitChunk({
      itemId: ITEM.itemId,
      chunkIndex: 0,
      offset: 0,
      length: 12,
      sha256: "d".repeat(64),
    });
    ledger.sealItem({ itemId: ITEM.itemId, objectId: "obj-1" });

    expect(() =>
      ledger.commitChunk({
        itemId: ITEM.itemId,
        chunkIndex: 1,
        offset: 12,
        length: 1,
        sha256: "d".repeat(64),
      }),
    ).toThrow(/import_item_sealed/);
  });

  it("reports a bounded progress snapshot", () => {
    ledger.registerItem({ ...ITEM, itemId: "2".repeat(64), sizeBytes: 4 });
    ledger.commitChunk({
      itemId: ITEM.itemId,
      chunkIndex: 0,
      offset: 0,
      length: 12,
      sha256: "d".repeat(64),
    });
    ledger.sealItem({ itemId: ITEM.itemId, objectId: "obj-1" });

    expect(ledger.snapshot()).toEqual({
      items: 2,
      sealed: 1,
      receivedBytes: 12,
      expectedBytes: 16,
    });
  });
});
