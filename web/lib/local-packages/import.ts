import "server-only";

import type { LocalPackage } from "@/lib/db/schema";

import { mkdir } from "node:fs/promises";
import path from "node:path";

import AdmZip from "adm-zip";
import pino from "pino";
import * as tar from "tar";

import { resolveWithinWorkingDir } from "./paths";

import { atomicWriteBuffer } from "@/lib/atomic";
import { MaisterError } from "@/lib/errors";
import {
  importMaxBytes,
  importMaxEntries,
  importMaxFileBytes,
} from "@/lib/instance-config";

const log = pino({
  name: "local-packages/import",
  level: process.env.LOG_LEVEL ?? "info",
});

// A single file an import would write: a working-dir-relative POSIX path plus
// its exact bytes. Directories are not carried — `mkdir -p` reconstructs them.
export type ImportEntry = { path: string; bytes: Uint8Array };

// What a preview/commit reports per resolved file (bytes are never serialized).
export type ImportPlanFile = { path: string; size: number };
export type ImportPlan = { files: ImportPlanFile[]; totalBytes: number };

export type ImportSource = "folder" | "zip" | "tar.gz";

const TAR_GZ_MAGIC = [0x1f, 0x8b];
const ZIP_MAGIC = [0x50, 0x4b]; // "PK"

// A plain Uint8Array view over a Buffer's exact bytes — sidesteps the
// Buffer<ArrayBufferLike> vs Uint8Array structural friction in @types/node
// without copying (Buffer IS a Uint8Array at runtime).
function toUint8(buf: Buffer): Uint8Array {
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

// Detect the archive flavor of an uploaded blob by magic bytes, falling back to
// the file name. Returns null when it is neither (treated as a single asset is
// NOT supported here — the route decides folder-vs-archive before calling).
export function detectArchiveKind(
  fileName: string,
  bytes: Uint8Array,
): "zip" | "tar.gz" | null {
  if (
    bytes.length >= 2 &&
    bytes[0] === ZIP_MAGIC[0] &&
    bytes[1] === ZIP_MAGIC[1]
  ) {
    return "zip";
  }
  if (
    bytes.length >= 2 &&
    bytes[0] === TAR_GZ_MAGIC[0] &&
    bytes[1] === TAR_GZ_MAGIC[1]
  ) {
    return "tar.gz";
  }

  const lower = fileName.toLowerCase();

  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar.gz";

  return null;
}

// Reject `..` (POSIX `../` AND Windows `..\`) on the ORIGINAL raw segments,
// BEFORE any normalization — `schemas/../setup.sh` must never be accepted just
// because a later normalize would collapse it. Returns a cleaned, `.`-stripped
// POSIX relpath for the confinement gate to re-validate; throws PRECONDITION on
// an escape so the WHOLE import is rejected pre-write.
export function cleanArchiveMemberPath(rawName: string): string {
  if (rawName.includes("\0")) {
    throw new MaisterError(
      "PRECONDITION",
      `archive entry has a NUL byte: ${JSON.stringify(rawName)}`,
    );
  }

  // Reject an ABSOLUTE entry on the RAW name — a leading `/` or `\`, or a
  // Windows drive-letter root (`C:\`). Splitting on the separator would
  // otherwise drop the leading empty segment and silently relativize it.
  if (
    rawName.startsWith("/") ||
    rawName.startsWith("\\") ||
    /^[a-zA-Z]:[\\/]/.test(rawName)
  ) {
    throw new MaisterError(
      "PRECONDITION",
      `archive entry is an absolute path: ${JSON.stringify(rawName)}`,
    );
  }

  const rawSegments = rawName.split(/[\\/]+/);

  if (rawSegments.some((s) => s === "..")) {
    throw new MaisterError(
      "PRECONDITION",
      `archive entry escapes the working dir: ${rawName}`,
    );
  }

  // Drop empty + `.` segments (a leading `./` is common in tar archives); keep
  // everything else verbatim. `..` is already rejected above.
  const cleaned = rawSegments
    .filter((s) => s.length > 0 && s !== ".")
    .join("/");

  if (cleaned.length === 0) {
    throw new MaisterError(
      "PRECONDITION",
      `archive entry has an empty path: ${JSON.stringify(rawName)}`,
    );
  }

  return cleaned;
}

// The UNCOMPRESSED import caps, resolved once per collection and enforced DURING
// archive parsing — not only afterward in planImport — so a zip/tar bomb (tiny
// compressed, huge uncompressed) is rejected before its bytes are materialized.
type ImportCaps = {
  maxBytes: number;
  maxEntries: number;
  maxFileBytes: number;
};

// Parse a zip blob into file entries WITHOUT trusting adm-zip's own extraction.
// adm-zip loads the whole archive into memory but inflates an entry only on
// getData(), so the UNCOMPRESSED caps are enforced BEFORE/AS each entry is
// inflated — a zip bomb never materializes gigabytes. Directory entries skipped.
function readZipEntries(bytes: Uint8Array, caps: ImportCaps): ImportEntry[] {
  let zip: AdmZip;

  try {
    zip = new AdmZip(Buffer.from(bytes));
  } catch (err) {
    throw new MaisterError(
      "PRECONDITION",
      `could not read the zip archive: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const fileEntries = zip.getEntries().filter((entry) => !entry.isDirectory);

  if (fileEntries.length > caps.maxEntries) {
    throw new MaisterError(
      "PRECONDITION",
      `zip has ${fileEntries.length} entries (max ${caps.maxEntries})`,
    );
  }

  // Pass 1: reject on the DECLARED uncompressed size (central-directory
  // `header.size`) — a standard zip bomb advertises its expansion here, so no
  // entry is inflated when the declared totals already breach the caps.
  let declaredTotal = 0;

  for (const entry of fileEntries) {
    const declared = entry.header.size;

    if (declared > caps.maxFileBytes) {
      throw new MaisterError(
        "PRECONDITION",
        `entry ${JSON.stringify(entry.entryName)} declares ${declared} uncompressed bytes (max ${caps.maxFileBytes})`,
      );
    }
    declaredTotal += declared;
    if (declaredTotal > caps.maxBytes) {
      throw new MaisterError(
        "PRECONDITION",
        `zip declares ${declaredTotal}+ uncompressed bytes (max ${caps.maxBytes})`,
      );
    }
  }

  // Pass 2: inflate with a running ACTUAL-bytes counter — a lying header is
  // caught at the first entry whose real size breaches a cap, bounding peak
  // memory to ~maxBytes + one entry rather than the full decompressed archive.
  const entries: ImportEntry[] = [];
  let actualTotal = 0;

  for (const entry of fileEntries) {
    const data = entry.getData();

    if (data.length > caps.maxFileBytes) {
      throw new MaisterError(
        "PRECONDITION",
        `entry ${JSON.stringify(entry.entryName)} is ${data.length} bytes (max ${caps.maxFileBytes})`,
      );
    }
    actualTotal += data.length;
    if (actualTotal > caps.maxBytes) {
      throw new MaisterError(
        "PRECONDITION",
        `zip expands past the cap (max ${caps.maxBytes} uncompressed bytes)`,
      );
    }
    entries.push({ path: entry.entryName, bytes: toUint8(data) });
  }

  return entries;
}

// Parse a gzipped-tar blob into file entries. Uses the streaming Parser and
// collects each File entry's bytes; non-file types (dirs, symlinks, hardlinks,
// devices) are skipped — only regular files are ever written, which also closes
// the tar-symlink escape vector at the source.
async function readTarGzEntries(
  bytes: Uint8Array,
  caps: ImportCaps,
): Promise<ImportEntry[]> {
  const entries: ImportEntry[] = [];
  const parser = new tar.Parser({ gzip: true });
  let total = 0;
  let count = 0;
  let aborted = false;

  await new Promise<void>((resolve, reject) => {
    // Reject AND stop accumulating immediately on the first cap breach: the
    // running counters + `aborted` flag bound peak memory to ~maxBytes no matter
    // how much more the gunzip stream would inflate (a tar bomb can declare
    // nothing — only a per-chunk running count is trustworthy here).
    const fail = (message: string) => {
      if (aborted) return;
      aborted = true;
      try {
        (parser as unknown as { abort?: (e: Error) => void }).abort?.(
          new Error(message),
        );
      } catch {
        // older tar Parser lacks abort(); the `aborted` flag still bounds memory
      }
      reject(new MaisterError("PRECONDITION", message));
    };

    parser.on("entry", (entry) => {
      if (aborted || entry.type !== "File") {
        entry.resume();

        return;
      }

      count += 1;
      if (count > caps.maxEntries) {
        fail(`tar.gz has more than ${caps.maxEntries} entries`);
        entry.resume();

        return;
      }

      const chunks: Uint8Array[] = [];
      let entryBytes = 0;

      entry.on("data", (chunk: Uint8Array) => {
        if (aborted) return;
        entryBytes += chunk.length;
        total += chunk.length;
        if (entryBytes > caps.maxFileBytes) {
          fail(
            `tar.gz entry ${JSON.stringify(entry.path)} exceeds ${caps.maxFileBytes} uncompressed bytes`,
          );

          return;
        }
        if (total > caps.maxBytes) {
          fail(
            `tar.gz expands past the cap (max ${caps.maxBytes} uncompressed bytes)`,
          );

          return;
        }
        chunks.push(chunk);
      });
      entry.on("end", () => {
        if (aborted) return;
        entries.push({
          path: entry.path,
          bytes: toUint8(Buffer.concat(chunks)),
        });
      });
    });
    parser.on("end", () => {
      if (!aborted) resolve();
    });
    parser.on("error", (err) => {
      if (aborted) return;
      reject(
        new MaisterError(
          "PRECONDITION",
          `could not read the tar.gz archive: ${err.message}`,
        ),
      );
    });
    parser.end(Buffer.from(bytes));
  });

  return entries;
}

// PURE planner: confine + cap a set of raw (name, size) entries. Throws
// PRECONDITION on the FIRST violation (zip-slip / oversize) — the route
// validates ALL entries here before writing anything, so a single bad entry
// leaves the working dir UNCHANGED. Logs WARN per rejection. Returns the
// resolved plan (cleaned paths + sizes) on success.
//
// Confinement is two-layered: `cleanArchiveMemberPath` rejects `..` on the
// ORIGINAL segments, then `resolveWithinWorkingDir` is the fs-level gate
// (abs/dash/NUL/`.git`/symlink-escape). Caps default to env-tunable limits.
export async function planImport(
  workingDir: string,
  rawEntries: { name: string; size: number }[],
): Promise<ImportPlan> {
  const maxBytes = importMaxBytes();
  const maxEntries = importMaxEntries();
  const maxFileBytes = importMaxFileBytes();

  if (rawEntries.length > maxEntries) {
    log.warn(
      { count: rawEntries.length, maxEntries },
      "import rejected: too many entries",
    );
    throw new MaisterError(
      "PRECONDITION",
      `import has ${rawEntries.length} entries (max ${maxEntries})`,
    );
  }

  let totalBytes = 0;
  const files: ImportPlanFile[] = [];
  const seen = new Set<string>();

  for (const raw of rawEntries) {
    if (raw.size > maxFileBytes) {
      log.warn(
        { name: raw.name, size: raw.size, maxFileBytes },
        "import rejected: file over per-file cap",
      );
      throw new MaisterError(
        "PRECONDITION",
        `file ${JSON.stringify(raw.name)} is ${raw.size} bytes (max ${maxFileBytes})`,
      );
    }

    totalBytes += raw.size;
    if (totalBytes > maxBytes) {
      log.warn(
        { totalBytes, maxBytes },
        "import rejected: total size over cap",
      );
      throw new MaisterError(
        "PRECONDITION",
        `import total ${totalBytes} bytes exceeds the cap (max ${maxBytes})`,
      );
    }

    // Layer 1: reject `..` on the ORIGINAL segments, clean `.`/leading-`./`.
    const cleaned = cleanArchiveMemberPath(raw.name);

    // Layer 2: the fs-confinement gate (abs/dash/NUL/`.git`/symlink-escape).
    // Throws PRECONDITION on escape — nothing has been written yet.
    await resolveWithinWorkingDir(workingDir, cleaned);

    if (seen.has(cleaned)) {
      log.warn({ name: raw.name, cleaned }, "import rejected: duplicate path");
      throw new MaisterError(
        "PRECONDITION",
        `duplicate import path: ${cleaned}`,
      );
    }
    seen.add(cleaned);
    files.push({ path: cleaned, size: raw.size });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));

  return { files, totalBytes };
}

// Collect import entries from either a folder upload (relative paths already
// carried per file) or one archive blob. Caps the archive's UPLOADED bytes
// BEFORE parsing (adm-zip materializes the whole archive). The folder path is
// already a list of in-memory blobs from multipart parts.
export async function collectImportEntries(input: {
  kind: "folder";
  files: { relativePath: string; bytes: Uint8Array }[];
}): Promise<{ source: ImportSource; entries: ImportEntry[] }>;
export async function collectImportEntries(input: {
  kind: "archive";
  fileName: string;
  bytes: Uint8Array;
}): Promise<{ source: ImportSource; entries: ImportEntry[] }>;
export async function collectImportEntries(
  input:
    | { kind: "folder"; files: { relativePath: string; bytes: Uint8Array }[] }
    | { kind: "archive"; fileName: string; bytes: Uint8Array },
): Promise<{ source: ImportSource; entries: ImportEntry[] }> {
  if (input.kind === "folder") {
    return {
      source: "folder",
      entries: input.files.map((f) => ({
        path: f.relativePath,
        bytes: f.bytes,
      })),
    };
  }

  // Cap the uploaded (compressed) archive bytes BEFORE handing them to a parser
  // that loads the whole thing into memory; the SAME caps are then enforced on
  // the UNCOMPRESSED stream inside the readers (zip/tar bomb defense).
  const caps: ImportCaps = {
    maxBytes: importMaxBytes(),
    maxEntries: importMaxEntries(),
    maxFileBytes: importMaxFileBytes(),
  };

  if (input.bytes.length > caps.maxBytes) {
    log.warn(
      { byteLength: input.bytes.length, maxBytes: caps.maxBytes },
      "import rejected: archive blob over cap (pre-parse)",
    );
    throw new MaisterError(
      "PRECONDITION",
      `archive is ${input.bytes.length} bytes (max ${caps.maxBytes})`,
    );
  }

  const kind = detectArchiveKind(input.fileName, input.bytes);

  if (kind === "zip") {
    return { source: "zip", entries: readZipEntries(input.bytes, caps) };
  }
  if (kind === "tar.gz") {
    return {
      source: "tar.gz",
      entries: await readTarGzEntries(input.bytes, caps),
    };
  }

  throw new MaisterError(
    "PRECONDITION",
    `unsupported archive: ${JSON.stringify(input.fileName)} (expected .zip or .tar.gz)`,
  );
}

// Preview: resolve the tree (confine + cap) WITHOUT writing. No lock needed.
export async function previewImport(
  pkg: LocalPackage,
  entries: ImportEntry[],
): Promise<ImportPlan> {
  return planImport(
    pkg.workingDir,
    entries.map((e) => ({ name: e.path, size: e.bytes.byteLength })),
  );
}

// Commit: validate EVERY entry (confinement + caps) FIRST, then write the
// confined files. A single failing entry throws before any write, so the
// working dir is left UNCHANGED on reject (validate-all-then-write). The caller
// MUST have asserted the session edit-lock. Binary bytes are preserved exactly.
export async function commitImport(
  pkg: LocalPackage,
  entries: ImportEntry[],
): Promise<ImportPlan> {
  // Phase 1: validate ALL entries — throws pre-write on the first violation.
  const plan = await planImport(
    pkg.workingDir,
    entries.map((e) => ({ name: e.path, size: e.bytes.byteLength })),
  );

  // Phase 2: every entry passed → write. Re-confine each path (cheap; the gate
  // also returns the resolved absolute path) so the write target is the guarded
  // one, never a raw member name.
  const byCleanPath = new Map<string, Uint8Array>();

  for (const entry of entries) {
    byCleanPath.set(cleanArchiveMemberPath(entry.path), entry.bytes);
  }

  for (const file of plan.files) {
    const bytes = byCleanPath.get(file.path);

    if (!bytes) continue;
    const abs = await resolveWithinWorkingDir(pkg.workingDir, file.path);

    await mkdir(path.dirname(abs), { recursive: true });
    await atomicWriteBuffer(abs, bytes);
  }

  log.info(
    { id: pkg.id, fileCount: plan.files.length, totalBytes: plan.totalBytes },
    "local package import committed",
  );

  return plan;
}
