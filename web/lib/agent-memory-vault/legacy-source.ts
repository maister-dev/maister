import "server-only";

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";

import { MAX_NOTE_CHARS } from "./limits";

import { MaisterError } from "@/lib/errors";

const absolutePayloadBytes = 4 * MAX_NOTE_CHARS;

export type LegacyMemoryText = Readonly<{
  text: string;
  digest: string;
  bytes: number;
}>;

function missing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function invalidSource(): MaisterError {
  return new MaisterError(
    "PRECONDITION",
    "Legacy memory source is not a confined regular file",
  );
}

function confined(root: string, relative: string) {
  const components = relative.split(path.sep);

  if (
    path.isAbsolute(relative) ||
    components.some((part) => part === "" || part === "." || part === "..")
  )
    throw invalidSource();

  return path.join(root, relative);
}

async function assertAncestors(root: string, target: string): Promise<void> {
  let parent = path.dirname(target);

  while (parent !== root) {
    const state = await lstat(parent);

    if (!state.isDirectory() || state.isSymbolicLink()) throw invalidSource();
    parent = path.dirname(parent);
  }
}

export async function legacyDirectories(
  root: string,
  relative: string,
): Promise<string[]> {
  const dir = confined(root, relative);

  try {
    await assertAncestors(root, dir);
    if ((await lstat(dir)).isSymbolicLink() || (await realpath(dir)) !== dir)
      throw invalidSource();

    return (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
}

async function readConfinedPayload(
  root: string,
  target: string,
): Promise<LegacyMemoryText> {
  await assertAncestors(root, target);
  if (!(await lstat(target)).isFile()) throw invalidSource();
  const file = await open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );

  try {
    const before = await file.stat();

    if (!before.isFile() || (await realpath(target)) !== target)
      throw invalidSource();
    if (before.size > absolutePayloadBytes)
      throw new MaisterError(
        "CONFIG",
        "Legacy memory file exceeds the maximum note byte limit",
      );
    const bytes = await file.readFile();
    const after = await lstat(target);

    if (
      after.isSymbolicLink() ||
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      bytes.length !== before.size
    )
      throw new MaisterError(
        "CONFLICT",
        "Legacy memory source changed during inventory",
      );
    let text: string;

    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes,
      );
    } catch (error) {
      throw new MaisterError(
        "CONFIG",
        "Legacy memory is not valid UTF-8 text",
        { cause: error },
      );
    }
    if (text.includes("\0"))
      throw new MaisterError(
        "CONFIG",
        "Legacy memory contains a NUL character",
      );

    return {
      text,
      digest: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    };
  } finally {
    await file.close();
  }
}

export async function readLegacyMemoryText(
  root: string,
  relative: string,
): Promise<LegacyMemoryText | null> {
  try {
    return await readConfinedPayload(root, confined(root, relative));
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

export async function cleanupLegacyMemoryText(
  root: string,
  relative: string,
  digest: string,
): Promise<void> {
  const source = await readLegacyMemoryText(root, relative);

  // A prior cleanup transaction may have stopped after the unlink.
  if (!source) return;
  if (source.digest !== digest)
    throw new MaisterError("CONFLICT", "Legacy memory changed before cleanup");
  const target = confined(root, relative);

  await assertAncestors(root, target);
  await unlink(target);
}
