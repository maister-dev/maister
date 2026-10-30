import "server-only";

import {
  link,
  lstat,
  open,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { MaisterError } from "@/lib/errors";
import { sha256 } from "@/lib/evaluations/digest";

export const INDEX_RESERVATION_MARKER = "index-reservation.json";
export type IndexReservation = { path: string; digest: string };
export type IndexReservationOwner = { operationId: string; nonce: string };

function reservationConflict(): MaisterError {
  return new MaisterError(
    "CONFLICT",
    "The caller index reservation is not an exact owned state. Preserve the index and lock files, inspect the recorded operation and recover after resolving the conflict.",
    { details: { reason: "recovery_required" } },
  );
}

async function syncPath(path: string): Promise<void> {
  const handle = await open(path, "r");

  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function markerText(owner: IndexReservationOwner, path: string): string {
  return JSON.stringify(
    {
      version: 1,
      operationId: owner.operationId,
      nonce: owner.nonce,
      indexLockPath: path,
    },
    null,
    2,
  );
}

/** Persist the private ownership proof before creating any standard Git lock. */
export async function writeIndexReservationMarker(
  directory: string,
  owner: IndexReservationOwner,
  path: string,
): Promise<IndexReservation> {
  const text = markerText(owner, path);
  const marker = join(directory, INDEX_RESERVATION_MARKER);

  await writeFile(marker, text, { mode: 0o600, flag: "wx" });
  await syncPath(marker);
  await syncPath(directory);

  return { path, digest: sha256(text) };
}

async function ownedMarker(
  directory: string,
  owner: IndexReservationOwner,
  reservation: IndexReservation,
): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  const marker = join(directory, INDEX_RESERVATION_MARKER);
  let info: Awaited<ReturnType<typeof lstat>>;

  try {
    info = await lstat(marker);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid!() ||
    (info.mode & 0o077) !== 0 ||
    info.size > 16 * 1024
  )
    throw reservationConflict();
  const text = await readFile(marker, "utf8");

  if (
    sha256(text) !== reservation.digest ||
    text !== markerText(owner, reservation.path)
  )
    throw reservationConflict();

  return info;
}

/** The hard link proves that the target is the exact marker, not another process's Git lock. */
export async function verifyIndexReservation(
  directory: string,
  owner: IndexReservationOwner,
  reservation: IndexReservation,
): Promise<"linked" | "absent"> {
  const marker = await ownedMarker(directory, owner, reservation);
  let target: Awaited<ReturnType<typeof lstat>>;

  try {
    target = await lstat(reservation.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
  if (
    !marker ||
    !target.isFile() ||
    target.isSymbolicLink() ||
    target.dev !== marker.dev ||
    target.ino !== marker.ino ||
    target.uid !== marker.uid ||
    target.mode !== marker.mode ||
    target.size !== marker.size
  )
    throw reservationConflict();
  if (sha256(await readFile(reservation.path, "utf8")) !== reservation.digest)
    throw reservationConflict();

  return "linked";
}

export async function linkIndexReservation(
  directory: string,
  reservation: IndexReservation,
): Promise<void> {
  await link(join(directory, INDEX_RESERVATION_MARKER), reservation.path);
  await syncPath(dirname(reservation.path));
}

/** Only a failed no-clobber link may discard its unlinked, verified private marker. */
export async function discardUnlinkedIndexMarker(
  directory: string,
  owner: IndexReservationOwner,
  reservation: IndexReservation,
): Promise<void> {
  if (await ownedMarker(directory, owner, reservation))
    await unlink(join(directory, INDEX_RESERVATION_MARKER));
  await syncPath(directory);
}

/** Call only after the exact owner's Git process groups have retired. */
export async function retireIndexReservation(
  directory: string,
  owner: IndexReservationOwner,
  reservation: IndexReservation,
): Promise<void> {
  if (
    (await verifyIndexReservation(directory, owner, reservation)) === "linked"
  ) {
    await unlink(reservation.path);
    await syncPath(dirname(reservation.path));
  }
  if (await ownedMarker(directory, owner, reservation))
    await unlink(join(directory, INDEX_RESERVATION_MARKER));
  await syncPath(directory);
}
