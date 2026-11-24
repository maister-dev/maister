import "server-only";

import { randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, basename } from "node:path";

import { containsSourceMaterial } from "./content-digest";

import { runtimeFileUrl } from "@/lib/runtime-file-url";
import { MaisterError } from "@/lib/errors";

export function materialConflict(): never {
  throw new MaisterError(
    "CONFLICT",
    "Another material already owns this immutable cache destination",
    { details: { reason: "install_identity_conflict" } },
  );
}

/** Resolve a local revision and its manifest from the same private copy. */
export async function snapshotLocalMaterial(source: string): Promise<string> {
  const stage = await mkdtemp(join(tmpdir(), "maister-local-material-"));

  try {
    await cp(runtimeFileUrl(await realpath(source)), runtimeFileUrl(stage), {
      recursive: true,
      verbatimSymlinks: true,
    });

    return stage;
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
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
  beforePublish?: () => Promise<void> | undefined;
}): Promise<void> {
  const { source, target, digest, hash } = input;
  // The seal lives beside the cache, beyond the copied source's namespace.
  // This witnesses original bytes even when legitimate setup created output
  // before a process died and its project transaction rolled back.
  const seal = target + ".material";
  const expectedSeal = JSON.stringify([input.revision, digest]);
  const freshSeal = JSON.stringify([input.revision, digest, "new-cache-v2"]);
  let recorded: string | null = null;

  try {
    recorded = await readFile(seal, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (recorded !== null && recorded !== expectedSeal && recorded !== freshSeal)
    materialConflict();
  const sealMaterial = async (contents: string) => {
    const temp = seal + "." + randomUUID();

    try {
      await writeFile(temp, contents, { flag: "wx" });
      await rename(temp, seal);
    } finally {
      await rm(temp, { force: true });
    }
  };

  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });

  if (existing) {
    if (
      !existing.isDirectory() ||
      !(await containsSourceMaterial(source, target)) ||
      (recorded === null &&
        (await hash(target)) !== digest &&
        !(await input.hasHistoricalOwner?.()))
    )
      materialConflict();
    await input.beforePublish?.();
    if (recorded === null) await sealMaterial(expectedSeal);

    return;
  }
  // A previous publication may have completed setup and produced runtime files.
  // Recreating a disappeared sealed target would lose those outputs silently.
  if (recorded !== null) materialConflict();
  await mkdir(dirname(target), { recursive: true });
  const stage = await mkdtemp(
    join(dirname(target), "." + basename(target) + "."),
  );

  try {
    await cp(source, stage, { recursive: true, verbatimSymlinks: true });
    if ((await hash(stage)) !== digest) materialConflict();
    const historical = await input.hasHistoricalOwner?.();

    await input.beforePublish?.();
    await rename(stage, target);
    await sealMaterial(historical ? expectedSeal : freshSeal);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
