import "server-only";

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import pino from "pino";
import { z } from "zod";

import { git } from "./git";
import { withGitOwnership } from "./git-process";

import { MaisterError } from "@/lib/errors";

const ownerSchema = z
  .object({
    operationId: z.string().uuid(),
    processId: z.number().int().positive(),
    nonce: z.string().uuid(),
    groups: z.array(z.number().int().positive()).default([]),
  })
  .strict();

type FenceOwner = z.infer<typeof ownerSchema>;
const liveOwners = new Set<string>();
const log = pino({
  name: "project-config-persistence/fence",
  level: process.env.LOG_LEVEL ?? "info",
});
const execute = promisify(execFile);

export async function commonGitDirectory(repo: string): Promise<string> {
  return realpath(
    resolve(repo, (await git(repo, ["rev-parse", "--git-common-dir"])).trim()),
  );
}

function busy(): MaisterError {
  return new MaisterError(
    "CONFLICT",
    "A repository mutation is active or needs recovery. Complete configuration recovery before retrying; do not remove unknown Git locks.",
    {
      details: { reason: "operation_busy" },
    },
  );
}

function processIsDead(processId: number): boolean {
  try {
    process.kill(processId, 0);

    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw busy();
  }
}

async function groupIsDead(group: number): Promise<boolean> {
  if (processIsDead(-group)) return true;
  // Orphaned exited children can remain zombies until the host reaps them.
  // Zombies cannot issue effects; a live member or unreadable process table refuses adoption.
  const { stdout } = await execute("ps", ["-axo", "pgid=,stat="], {
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  });

  const members: string[] = [];

  for (const line of stdout.split("\n").filter((entry) => entry.trim())) {
    const match = /^\s*(\d+)\s+(\S+)/u.exec(line);

    if (!match) throw busy();
    if (Number(match[1]) === group) members.push(match[2]!);
  }
  if (members.length === 0) return processIsDead(-group);
  const active = members.filter((state) => !state.startsWith("Z"));

  if (active.length)
    log.warn(
      { group, states: active },
      "repository Git process group is still active",
    );

  return active.length === 0;
}

async function readOwner(directory: string): Promise<FenceOwner> {
  try {
    if (!(await lstat(directory)).isDirectory()) throw busy();
    const parsed = ownerSchema.safeParse(
      JSON.parse(
        await readFile(join(directory, "owner.json"), "utf8"),
      ) as unknown,
    );

    if (!parsed.success) throw busy();

    return parsed.data;
  } catch (error) {
    if (error instanceof MaisterError) throw error;
    throw busy();
  }
}

async function assertOnlyOwnedMetadata(directory: string): Promise<void> {
  if ((await readdir(directory)).some((entry) => entry !== "owner.json"))
    throw busy();
}

async function assertRetiredOwner(
  directory: string,
  operationId: string,
): Promise<void> {
  const recorded = await readOwner(directory);

  if (
    liveOwners.has(directory) ||
    recorded.operationId !== operationId ||
    (recorded.processId !== process.pid && !processIsDead(recorded.processId))
  )
    throw busy();
  for (const group of recorded.groups)
    if (!(await groupIsDead(group))) throw busy();
  await assertOnlyOwnedMetadata(directory);
}

async function writeOwner(directory: string, owner: FenceOwner): Promise<void> {
  const temporary = join(directory, `${owner.nonce}.json`);

  await writeFile(temporary, JSON.stringify(owner), {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, join(directory, "owner.json"));
}

export type RepositoryFence = {
  commonDirectory: string;
  release: () => Promise<void>;
  retain: () => void;
  run: <T>(action: () => Promise<T>) => Promise<T>;
};

/** A retained fence has no lease. Only recovery of its exact operation may adopt it. */
export async function acquireRepositoryFence(
  repo: string,
  operationId: string,
): Promise<RepositoryFence> {
  const commonDirectory = await commonGitDirectory(repo);
  const directory = join(commonDirectory, "maister-config-mutation.lock");
  let owner: FenceOwner = {
    operationId,
    processId: process.pid,
    nonce: randomUUID(),
    groups: [],
  };
  let recoveryClaim: string | null = null;

  if (liveOwners.has(directory)) throw busy();

  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await assertRetiredOwner(directory, operationId);
    const claim = join(
      commonDirectory,
      "maister-config-mutation.recovery.lock",
    );

    try {
      await mkdir(claim, { mode: 0o700 });
      recoveryClaim = claim;
    } catch {
      throw busy();
    }
    try {
      await assertRetiredOwner(directory, operationId);
    } catch (error) {
      await rm(claim, { recursive: true });
      throw error;
    }
  }

  liveOwners.add(directory);
  try {
    await writeOwner(directory, owner);
  } catch (error) {
    liveOwners.delete(directory);
    throw error;
  } finally {
    if (recoveryClaim !== null) await rm(recoveryClaim, { recursive: true });
  }

  log.debug({ operationId }, "repository mutation fence acquired");
  let recording: Promise<void> = Promise.resolve();
  let finished = false;
  const register = (group: number): Promise<void> => {
    recording = recording.then(async () => {
      if (finished || (await readOwner(directory)).nonce !== owner.nonce)
        throw busy();
      const nextOwner = { ...owner, groups: [...owner.groups, group] };

      await writeOwner(directory, nextOwner);
      owner = nextOwner;
    });

    return recording;
  };

  return {
    commonDirectory,
    run: (action) => {
      if (finished) throw busy();

      return withGitOwnership(register, action);
    },
    retain: () => {
      finished = true;
      liveOwners.delete(directory);
    },
    release: async () => {
      if (finished) throw busy();
      await recording;
      const actual = await readOwner(directory);

      if (actual.nonce !== owner.nonce) throw busy();
      for (const group of actual.groups)
        if (!(await groupIsDead(group))) throw busy();
      await assertOnlyOwnedMetadata(directory);
      await rm(directory, { recursive: true });
      finished = true;
      liveOwners.delete(directory);
      log.debug({ operationId }, "repository mutation fence released");
    },
  };
}

export async function withRepositoryMutationFence<T>(
  repo: string,
  action: () => Promise<T>,
): Promise<T> {
  const fence = await acquireRepositoryFence(repo, randomUUID());

  try {
    return await fence.run(action);
  } finally {
    try {
      await fence.release();
    } catch (error) {
      fence.retain();
      throw error;
    }
  }
}
