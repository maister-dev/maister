import "server-only";

import { randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, basename } from "node:path";

import { containsSourceMaterial } from "./content-digest";

import { MaisterError } from "@/lib/errors";

export function materialConflict(): never {
  throw new MaisterError(
    "CONFLICT",
    "Another material already owns this immutable cache destination",
    { details: { reason: "install_identity_conflict" } },
  );
}

/** Caller holds the physical cache lock. Staging beside the destination permits
 * atomic publication and cleanup even when /tmp is a different filesystem. */
export async function publishMaterial(input: {
  source: string;
  target: string;
  digest: string;
  revision: string;
  hash: (dir: string) => Promise<string>;
  hasHistoricalOwner?: () => Promise<boolean>;
}): Promise<void> {
  const { source, target, digest, hash } = input;
  // The seal lives beside the cache, beyond the copied source's namespace.
  // This witnesses original bytes even when legitimate setup created output
  // before a process died and its project transaction rolled back.
  const seal = target + ".material";
  const expectedSeal = JSON.stringify([input.revision, digest]);
  let recorded: string | null = null;

  try {
    recorded = await readFile(seal, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (recorded !== null && recorded !== expectedSeal) materialConflict();
  const sealMaterial = async () => {
    const temp = seal + "." + randomUUID();

    try {
      await writeFile(temp, expectedSeal, { flag: "wx" });
      await rename(temp, seal);
    } finally {
      await rm(temp, { force: true });
    }
  };

  try {
    const existing = await lstat(target);

    if (
      !existing.isDirectory() ||
      (recorded === null &&
        (await hash(target)) !== digest &&
        !(
          (await input.hasHistoricalOwner?.()) &&
          (await containsSourceMaterial(source, target))
        ))
    )
      materialConflict();
    if (recorded === null) await sealMaterial();

    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(target), { recursive: true });
  const stage = await mkdtemp(
    join(dirname(target), "." + basename(target) + "."),
  );

  try {
    await cp(source, stage, { recursive: true, verbatimSymlinks: true });
    if ((await hash(stage)) !== digest) materialConflict();
    await rename(stage, target);
    await sealMaterial();
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
