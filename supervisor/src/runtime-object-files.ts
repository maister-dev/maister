import type { BigIntStats, ReadStream } from "node:fs";
import type { FileHandle } from "node:fs/promises";

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { MAX_OBJECT_RESPONSE_BYTES } from "../../runtime/object-integrity";

import { HostRuntimeEventError } from "./host-runtime-errors";
import { SupervisorError } from "./types";

export { MAX_OBJECT_RESPONSE_BYTES };
// D5 read bounds: two verification scans may hold a response spool at once, so
// retained response bytes never exceed twice the per-response bound.
export const MAX_ACTIVE_OBJECT_READS = 2;
export const MAX_OBJECT_RESPONSE_SPOOL_BYTES =
  MAX_ACTIVE_OBJECT_READS * MAX_OBJECT_RESPONSE_BYTES;
const BUFFER_BYTES = 64 * 1024;

export type SealedFileIdentity = { sealedDevice: string; sealedInode: string };
export type ObjectByteRange = {
  start: number;
  end: number;
  length: number;
  partial: boolean;
};
export type VerifiedObjectResponse = {
  stream: ReadStream;
  range: ObjectByteRange;
  sha256: string;
};

export class RuntimeObjectIntegrityError extends SupervisorError {
  constructor(
    readonly observedBytes: number | null = null,
    readonly hashAgreement: boolean | null = null,
  ) {
    super(
      "PRECONDITION",
      "runtime object content failed integrity verification",
      {
        details: { reason: "runtime_object_integrity_mismatch" },
      },
    );
  }
}

export function objectIntegrityError(): RuntimeObjectIntegrityError {
  return new RuntimeObjectIntegrityError();
}

export function objectByteRange(
  total: number,
  range?: string,
): ObjectByteRange {
  const match = range?.match(/^bytes=(\d+)-(\d*)$/);
  const start = match ? Number(match[1]) : 0;
  const end = match?.[2] ? Number(match[2]) : total - 1;
  const length = end - start + 1;

  if (
    (range !== undefined && !match) ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    (match && start >= total) ||
    length < 0 ||
    (match && length === 0) ||
    end >= total ||
    length > MAX_OBJECT_RESPONSE_BYTES
  ) {
    throw new SupervisorError(
      "PRECONDITION",
      "runtime object range is invalid",
      {
        details: { reason: "runtime_object_range_invalid" },
      },
    );
  }

  return { start, end, length, partial: Boolean(match) };
}

export function sealedFileIdentity(stat: BigIntStats): SealedFileIdentity {
  return {
    sealedDevice: stat.dev.toString(),
    sealedInode: stat.ino.toString(),
  };
}

function unchanged(before: BigIntStats, after: BigIntStats): boolean {
  return (
    after.isFile() &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

/** O_NONBLOCK keeps a substituted FIFO from hanging before the regular-file check. */
async function openObject(path: string): Promise<FileHandle> {
  try {
    return await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === "ENOENT")
      throw new SupervisorError(
        "PRECONDITION",
        "runtime object content is missing",
        {
          details: { reason: "runtime_object_missing" },
        },
      );
    if (code === "ELOOP") throw objectIntegrityError();
    throw new HostRuntimeEventError(
      "runtime_storage_unavailable",
      "runtime object file could not be opened",
      { cause: error },
    );
  }
}

async function writeBytes(handle: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;

  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset);

    if (result.bytesWritten === 0)
      throw new HostRuntimeEventError(
        "runtime_storage_unavailable",
        "runtime object storage made no progress",
      );
    offset += result.bytesWritten;
  }
}

export async function syncObjectDirectory(path: string): Promise<void> {
  const directory = await open(dirname(path), "r");

  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** Copy the closed producer representation to a distinct inode before publishing its seal. */
export async function sealObjectFile(input: {
  path: string;
  destinationPath: string;
  temporaryPath: string;
  maxBytes: number;
  expected?: { sizeBytes: number; sha256: string };
}): Promise<SealedFileIdentity & { sizeBytes: number; sha256: string }> {
  const source = await openObject(input.path);
  const temporary = input.temporaryPath;
  let target: FileHandle | undefined;
  let temporaryExists = false;

  try {
    const initial = await source.stat({ bigint: true });

    if (!initial.isFile()) throw objectIntegrityError();
    if (initial.size > BigInt(input.maxBytes))
      throw new SupervisorError(
        "PRECONDITION",
        "runtime object exceeds the byte limit",
        {
          details: { reason: "runtime_object_too_large" },
        },
      );
    target = await open(temporary, "wx", 0o600);
    temporaryExists = true;
    const buffer = Buffer.allocUnsafe(BUFFER_BYTES);
    const digest = createHash("sha256");
    let sizeBytes = 0;

    for (;;) {
      const { bytesRead } = await source.read(
        buffer,
        0,
        buffer.byteLength,
        null,
      );

      if (bytesRead === 0) break;
      sizeBytes += bytesRead;
      if (sizeBytes > input.maxBytes || BigInt(sizeBytes) > initial.size)
        throw objectIntegrityError();
      const bytes = buffer.subarray(0, bytesRead);

      digest.update(bytes);
      await writeBytes(target, bytes);
    }
    const sha256 = digest.digest("hex");

    if (
      !unchanged(initial, await source.stat({ bigint: true })) ||
      BigInt(sizeBytes) !== initial.size ||
      (input.expected &&
        (sizeBytes !== input.expected.sizeBytes ||
          sha256 !== input.expected.sha256))
    )
      throw objectIntegrityError();
    await target.sync();
    const identity = sealedFileIdentity(await target.stat({ bigint: true }));

    await target.close();
    target = undefined;
    await rename(temporary, input.destinationPath);
    temporaryExists = false;
    await syncObjectDirectory(input.destinationPath);

    return { ...identity, sizeBytes, sha256 };
  } catch (error) {
    if (
      error instanceof SupervisorError ||
      error instanceof HostRuntimeEventError
    )
      throw error;
    throw new HostRuntimeEventError(
      "runtime_storage_unavailable",
      "runtime object seal storage failed",
      { cause: error },
    );
  } finally {
    try {
      await source.close();
    } finally {
      try {
        await target?.close();
      } finally {
        if (temporaryExists) await unlink(temporary);
      }
    }
  }
}

/** Hash the entire source, retain only the requested bytes, then serve that exact unlinked descriptor. */
export async function verifyObjectResponse(input: {
  path: string;
  spoolPath: string;
  identity: SealedFileIdentity;
  sizeBytes: number;
  sha256: string;
  range: ObjectByteRange;
  signal?: AbortSignal;
}): Promise<VerifiedObjectResponse> {
  const source = await openObject(input.path);
  let spool: FileHandle | undefined;
  let spoolExists = false;
  let sourceClosed = false;

  try {
    const initial = await source.stat({ bigint: true });
    const identity = sealedFileIdentity(initial);

    if (
      !initial.isFile() ||
      initial.size !== BigInt(input.sizeBytes) ||
      identity.sealedDevice !== input.identity.sealedDevice ||
      identity.sealedInode !== input.identity.sealedInode
    )
      throw new RuntimeObjectIntegrityError(Number(initial.size));
    spool = await open(input.spoolPath, "wx+", 0o600);
    spoolExists = true;
    await unlink(input.spoolPath);
    spoolExists = false;
    const buffer = Buffer.allocUnsafe(BUFFER_BYTES);
    const representation = createHash("sha256");
    const content = createHash("sha256");
    let sizeBytes = 0;
    let retained = 0;

    for (;;) {
      input.signal?.throwIfAborted();
      const { bytesRead } = await source.read(
        buffer,
        0,
        buffer.byteLength,
        null,
      );

      if (bytesRead === 0) break;
      const offset = sizeBytes;

      sizeBytes += bytesRead;
      if (sizeBytes > input.sizeBytes) throw objectIntegrityError();
      representation.update(buffer.subarray(0, bytesRead));
      const start = Math.max(0, input.range.start - offset);
      const end = Math.min(bytesRead, input.range.end + 1 - offset);

      if (end > start) {
        const bytes = buffer.subarray(start, end);

        retained += bytes.byteLength;
        content.update(bytes);
        await writeBytes(spool, bytes);
      }
    }
    const hashAgreement = representation.digest("hex") === input.sha256;

    if (
      sizeBytes !== input.sizeBytes ||
      !hashAgreement ||
      retained !== input.range.length ||
      !unchanged(initial, await source.stat({ bigint: true }))
    )
      throw new RuntimeObjectIntegrityError(sizeBytes, hashAgreement);
    input.signal?.throwIfAborted();
    await source.close();
    sourceClosed = true;
    const stream = spool.createReadStream({ start: 0, autoClose: true });

    spool = undefined;

    return { stream, range: input.range, sha256: content.digest("hex") };
  } catch (error) {
    if (
      error instanceof SupervisorError ||
      error instanceof HostRuntimeEventError ||
      input.signal?.aborted
    )
      throw error;
    throw new HostRuntimeEventError(
      "runtime_storage_unavailable",
      "runtime object verification storage failed",
      { cause: error },
    );
  } finally {
    try {
      if (!sourceClosed) await source.close();
    } finally {
      try {
        await spool?.close();
      } finally {
        if (spoolExists) await unlink(input.spoolPath);
      }
    }
  }
}
