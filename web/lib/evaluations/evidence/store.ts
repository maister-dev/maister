import "server-only";

import { open } from "node:fs/promises";
import path from "node:path";

import { atomicWriteBuffer } from "@/lib/atomic";
import { sha256Bytes } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";
import { evaluationEvidenceRoot } from "@/lib/instance-config";

// Storage generation marker — a root-rotation namespace for GC. Blob keys embed
// it so a future generation can prune an old one without touching live blobs.
export const EVIDENCE_STORAGE_GENERATION = "g1";

// Server hard cap on a single bounded evidence read (D10). A judge may request a
// window with offset/length but never more than this per call.
export const EVIDENCE_READ_MAX_BYTES = 65_536;

// blobKey is a logical, root-relative content address:
//   <generation>/blobs/<digest[0:2]>/<digest>
// It NEVER contains a host absolute path — public DTOs expose the opaque item id
// and logical label only, not this key.
export function evidenceBlobKey(
  digest: string,
  generation: string = EVIDENCE_STORAGE_GENERATION,
): string {
  return `${generation}/blobs/${digest.slice(0, 2)}/${digest}`;
}

// Resolve a root-relative blobKey to an absolute path, refusing any key that
// escapes the evidence root (defense in depth — keys are server-minted from
// digests, but bounded retrieval reads the key from a DB row).
function resolveWithinRoot(root: string, blobKey: string): string {
  if (blobKey.split(/[\\/]/).includes("..")) {
    throw new MaisterError(
      "PRECONDITION",
      "evidence blob key contains a '..' segment",
    );
  }
  const normRoot = path.resolve(root);
  const full = path.resolve(normRoot, blobKey);

  if (full !== normRoot && !full.startsWith(normRoot + path.sep)) {
    throw new MaisterError(
      "PRECONDITION",
      "evidence blob key escapes the evidence root",
    );
  }

  return full;
}

export interface WrittenBlob {
  digest: string;
  blobKey: string;
  bytes: number;
}

// Write bytes to the content-addressed store (tmp + fsync + rename, atomic). The
// digest IS the address, so an identical payload is idempotent — a re-write
// lands the same key. Returns the digest, key, and byte length for the DB item.
export async function writeEvidenceBlob(
  bytes: Uint8Array,
  root: string = evaluationEvidenceRoot(),
): Promise<WrittenBlob> {
  const digest = sha256Bytes(bytes);
  const blobKey = evidenceBlobKey(digest);

  await atomicWriteBuffer(resolveWithinRoot(root, blobKey), bytes);

  return { digest, blobKey, bytes: bytes.byteLength };
}

export interface BoundedReadResult {
  bytes: Buffer;
  truncated: boolean;
}

// Read a server-capped window of an evidence blob. `offset`/`length` are clamped
// to non-negative and to EVIDENCE_READ_MAX_BYTES; a read that hits the cap is
// flagged `truncated` (structured flag, never an in-band marker).
export async function readEvidenceBlob(
  blobKey: string,
  opts: { offset?: number; length?: number; root?: string } = {},
): Promise<BoundedReadResult> {
  const root = opts.root ?? evaluationEvidenceRoot();
  const full = resolveWithinRoot(root, blobKey);
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const cap = Math.min(
    Math.max(1, Math.floor(opts.length ?? EVIDENCE_READ_MAX_BYTES)),
    EVIDENCE_READ_MAX_BYTES,
  );

  const handle = await open(full, "r");

  try {
    // Read cap + 1 so a full window signals possible truncation.
    const buffer = new Uint8Array(cap + 1);
    const { bytesRead } = await handle.read(buffer, 0, cap + 1, offset);
    const truncated = bytesRead > cap;

    return {
      bytes: Buffer.from(buffer.subarray(0, Math.min(bytesRead, cap))),
      truncated,
    };
  } finally {
    await handle.close();
  }
}
