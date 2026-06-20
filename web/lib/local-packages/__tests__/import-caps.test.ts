import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import AdmZip from "adm-zip";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectImportEntries } from "../import";

// (M36 Phase 3) Zip/tar BOMB defense: the UNCOMPRESSED caps must be enforced
// DURING archive parsing. The pre-parse cap only bounds the COMPRESSED blob, so
// a tiny archive can expand past the per-file/total caps in memory. The fix
// rejects inside collectImportEntries (readZip/readTarGz), not later in
// planImport after the whole thing is materialized — these tests pin that.
describe("collectImportEntries uncompressed caps", () => {
  const prevFileCap = process.env.MAISTER_IMPORT_MAX_FILE_BYTES;
  let tmp: string;

  beforeEach(async () => {
    // A tiny per-file cap; the default 50 MiB COMPRESSED pre-cap still passes,
    // so a rejection here proves the UNCOMPRESSED enforcement fired during parse.
    process.env.MAISTER_IMPORT_MAX_FILE_BYTES = "64";
    tmp = await mkdtemp(path.join(os.tmpdir(), "lp-bomb-"));
  });

  afterEach(async () => {
    if (prevFileCap === undefined) {
      delete process.env.MAISTER_IMPORT_MAX_FILE_BYTES;
    } else {
      process.env.MAISTER_IMPORT_MAX_FILE_BYTES = prevFileCap;
    }
    await rm(tmp, { recursive: true, force: true });
  });

  it("rejects a zip whose entry expands past the per-file cap (pre-write)", async () => {
    const zip = new AdmZip();

    // 5 KiB of compressible bytes: tiny compressed, 5000 uncompressed >> 64.
    zip.addFile("big.txt", Buffer.alloc(5000, 0x61));
    const bytes = new Uint8Array(zip.toBuffer());

    await expect(
      collectImportEntries({ kind: "archive", fileName: "bomb.zip", bytes }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  it("rejects a tar.gz whose entry expands past the per-file cap (pre-write)", async () => {
    await writeFile(path.join(tmp, "big.txt"), "a".repeat(5000));
    const tarPath = path.join(tmp, "bomb.tar.gz");

    await tar.create({ gzip: true, cwd: tmp, file: tarPath }, ["big.txt"]);
    const bytes = new Uint8Array(await readFile(tarPath));

    await expect(
      collectImportEntries({
        kind: "archive",
        fileName: "bomb.tar.gz",
        bytes,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  it("accepts a zip whose entries fit under the caps", async () => {
    const zip = new AdmZip();

    zip.addFile("small.txt", Buffer.from("ok"));
    const bytes = new Uint8Array(zip.toBuffer());

    const result = await collectImportEntries({
      kind: "archive",
      fileName: "fine.zip",
      bytes,
    });

    expect(result.source).toBe("zip");
    expect(result.entries.map((e) => e.path)).toContain("small.txt");
  });

  it("accepts a tar.gz whose entries fit under the caps", async () => {
    await writeFile(path.join(tmp, "small.txt"), "ok");
    const tarPath = path.join(tmp, "fine.tar.gz");

    await tar.create({ gzip: true, cwd: tmp, file: tarPath }, ["small.txt"]);
    const bytes = new Uint8Array(await readFile(tarPath));

    const result = await collectImportEntries({
      kind: "archive",
      fileName: "fine.tar.gz",
      bytes,
    });

    expect(result.source).toBe("tar.gz");
    expect(result.entries.map((e) => e.path)).toContain("small.txt");
  });
});
