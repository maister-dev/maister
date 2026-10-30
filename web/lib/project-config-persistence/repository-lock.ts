import "server-only";

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import pino from "pino";
import { z } from "zod";

import { git } from "./git";
import {
  INDEX_RESERVATION_MARKER,
  writeIndexReservationMarker,
  linkIndexReservation,
  verifyIndexReservation,
  retireIndexReservation,
  discardUnlinkedIndexMarker,
} from "./index-reservation";
import { withGitOwnership } from "./git-process";

import { MaisterError } from "@/lib/errors";

const ownerSchema = z
  .object({
    operationId: z.string().uuid(),
    processId: z.number().int().positive(),
    nonce: z.string().uuid(),
    groups: z.array(z.number().int().positive()).default([]),
    indexReservation: z
      .object({
        path: z.string().min(1),
        digest: z.string().regex(/^[0-9a-f]{64}$/u),
      })
      .strict()
      .optional(),
  })
  .strict();

type FenceOwner = z.infer<typeof ownerSchema>;
const processOwnership = globalThis as typeof globalThis & {
  __maisterProjectConfigOwners?: Set<string>;
};
// HMR must preserve an in-flight owner between its Git subprocesses.
const liveOwners = (processOwnership.__maisterProjectConfigOwners ??=
  new Set<string>());
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
  let stdout: string;

  try {
    ({ stdout } = await execute(
      "ps",
      ["-g", String(group), "-o", "pgid=,stat="],
      {
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
      },
    ));
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
    };

    if (
      Number(failure.code) === 1 &&
      !failure.stdout?.trim() &&
      !failure.stderr?.trim()
    )
      return processIsDead(-group);
    throw busy();
  }

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

async function assertOnlyOwnedMetadata(
  directory: string,
  owner: FenceOwner,
): Promise<void> {
  if (
    (await readdir(directory)).some(
      (entry) =>
        entry !== "owner.json" &&
        !(entry === INDEX_RESERVATION_MARKER && owner.indexReservation),
    )
  )
    throw busy();
}

async function assertRetiredOwner(
  directory: string,
  operationId: string,
  indexLockPath: string,
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
  await assertOnlyOwnedMetadata(directory, recorded);
  if (recorded.indexReservation) {
    if (recorded.indexReservation.path !== indexLockPath) throw busy();
    await verifyIndexReservation(
      directory,
      recorded,
      recorded.indexReservation,
    );
  }
}

async function writeOwner(directory: string, owner: FenceOwner): Promise<void> {
  const temporary = join(directory, `${owner.nonce}.json`);

  await writeFile(temporary, JSON.stringify(owner), {
    mode: 0o600,
    flag: "wx",
  });
  const file = await open(temporary, "r");

  try {
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, join(directory, "owner.json"));
  for (const path of [directory]) {
    const handle = await open(path, "r");

    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

export type RepositoryFence = {
  commonDirectory: string;
  release: () => Promise<void>;
  assertQuiescent: () => Promise<void>;
  reserveIndex: () => Promise<void>;
  assertIndexReservation: () => Promise<void>;
  releaseIndex: () => Promise<void>;
  retain: () => void;
  run: <T>(action: () => Promise<T>) => Promise<T>;
};

/** A retained fence has no lease. Only recovery of its exact operation may adopt it. */
export async function acquireRepositoryFence(
  repo: string,
  operationId: string,
): Promise<RepositoryFence> {
  const canonicalRepo = await realpath(repo);
  const commonDirectory = await commonGitDirectory(canonicalRepo);
  const indexPath = resolve(
    canonicalRepo,
    (await git(canonicalRepo, ["rev-parse", "--git-path", "index"])).trim(),
  );
  const indexLockPath = join(
    await realpath(dirname(indexPath)),
    `${basename(indexPath)}.lock`,
  );
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
    await assertRetiredOwner(directory, operationId, indexLockPath);
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
      await assertRetiredOwner(directory, operationId, indexLockPath);
      const prior = await readOwner(directory);

      if (prior.indexReservation)
        await retireIndexReservation(directory, prior, prior.indexReservation);
      log.debug(
        {
          operationId,
          retiredIndexReservation: Boolean(prior.indexReservation),
        },
        "retired repository owner recovered",
      );
    } catch (error) {
      await rm(claim, { recursive: true });
      throw error;
    }
  }

  liveOwners.add(directory);
  try {
    await writeOwner(directory, owner);
    const parent = await open(commonDirectory, "r");

    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
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

  const assertQuiescent = async (): Promise<void> => {
    if (finished) throw busy();
    await recording;
    const actual = await readOwner(directory);

    if (actual.nonce !== owner.nonce) throw busy();
    for (const group of actual.groups)
      if (!(await groupIsDead(group))) throw busy();
    await assertOnlyOwnedMetadata(directory, actual);
    if (actual.indexReservation) {
      if (actual.indexReservation.path !== indexLockPath) throw busy();
      await verifyIndexReservation(directory, actual, actual.indexReservation);
    }
  };

  const reserveIndex = async (): Promise<void> => {
    let collision: MaisterError | null = null;

    recording = recording.then(async () => {
      if (
        finished ||
        (await readOwner(directory)).nonce !== owner.nonce ||
        owner.indexReservation
      )
        throw busy();
      const reservation = await writeIndexReservationMarker(
        directory,
        owner,
        indexLockPath,
      );
      const next = { ...owner, indexReservation: reservation };

      await writeOwner(directory, next);
      owner = next;
      try {
        await linkIndexReservation(directory, reservation);
        log.debug(
          { operationId },
          "caller index reserved for reviewed publication",
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;

        if (code !== "EEXIST" && code !== "EXDEV") throw error;
        await discardUnlinkedIndexMarker(directory, owner, reservation);
        const { indexReservation: _reservation, ...withoutReservation } = owner;

        await writeOwner(directory, withoutReservation);
        owner = withoutReservation;
        collision = new MaisterError(
          code === "EEXIST" ? "CONFLICT" : "PRECONDITION",
          code === "EEXIST"
            ? "Another Git index update is active. Preserve its lock and recover this operation after it finishes."
            : "The Git metadata filesystem cannot provide the required atomic index reservation. Move repository metadata to a supported local filesystem before creating a fresh preview.",
          {
            details: {
              reason:
                code === "EEXIST"
                  ? "recovery_required"
                  : "unsupported_checkout",
            },
          },
        );
      }
    });
    await recording;
    if (collision) throw collision;
  };
  const assertIndexReservation = async (): Promise<void> => {
    await recording;
    const actual = await readOwner(directory);

    if (
      finished ||
      actual.nonce !== owner.nonce ||
      !actual.indexReservation ||
      actual.indexReservation.path !== indexLockPath ||
      (await verifyIndexReservation(
        directory,
        actual,
        actual.indexReservation,
      )) !== "linked"
    )
      throw busy();
  };
  const releaseIndex = async (): Promise<void> => {
    await assertQuiescent();
    if (!owner.indexReservation) return;
    await retireIndexReservation(directory, owner, owner.indexReservation);
    const { indexReservation: _reservation, ...withoutReservation } = owner;

    await writeOwner(directory, withoutReservation);
    owner = withoutReservation;
    log.debug({ operationId }, "caller index reservation retired");
  };

  return {
    commonDirectory,
    reserveIndex,
    assertIndexReservation,
    releaseIndex,
    assertQuiescent,
    run: (action) => {
      if (finished) throw busy();

      return withGitOwnership(register, action);
    },
    retain: () => {
      finished = true;
      liveOwners.delete(directory);
    },
    release: async () => {
      await releaseIndex();
      await assertQuiescent();
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

/** A recorded PID is evidence for refusal, never authority to signal another process. */
export async function assertConfigGitOwnerRetired(
  ownerProcessId: number | null,
  processGroup: number | null,
): Promise<void> {
  if (
    ownerProcessId === null ||
    (ownerProcessId !== process.pid && !processIsDead(ownerProcessId))
  )
    throw busy();
  if (processGroup !== null && !(await groupIsDead(processGroup))) throw busy();
}
