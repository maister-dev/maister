import "server-only";

import type { ConfigOperation, PersistenceDb } from "./store";

import {
  lstat,
  readFile,
  readdir,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";

import { and, asc, eq, gt, inArray, lt, ne, or } from "drizzle-orm";
import pino from "pino";

import { CONFIG_CLEANUP_REASONS, type ConfigCleanupReason } from "./contracts";
import { configReviewRoot } from "./review-files";
import { git, gitResult } from "./git";
import { acquireRepositoryFence, commonGitDirectory } from "./repository-lock";

import { requireProjectActionForUser } from "@/lib/authz";
import {
  projectConfigPersistOperations as operations,
  projectConfigPushIntents as pushes,
} from "@/lib/db/schema";
import { contentDigest, sha256 } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "project-config-persistence/cleanup",
  level: process.env.LOG_LEVEL ?? "info",
});

function preservePrivateOutput(): MaisterError {
  return new MaisterError(
    "CONFLICT",
    "Private configuration output differs from its ownership record. Preserve it for inspection; cleanup did not discard changes.",
    { details: { reason: "unexpected_private_content" } },
  );
}

async function removeReviewedFiles(operation: ConfigOperation): Promise<void> {
  const snapshot = operation.snapshot;
  const directory = join(
    await configReviewRoot(snapshot.repository.repoPath),
    operation.id,
  );

  if (snapshot.contentDirectory !== directory) throw preservePrivateOutput();
  let names: string[];

  try {
    const info = await lstat(directory);

    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid!() ||
      (info.mode & 0o077) !== 0 ||
      (await realpath(directory)) !== directory
    )
      throw preservePrivateOutput();
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (names.length > 0 && !names.includes("operation.json"))
    throw preservePrivateOutput();
  if (
    names.some(
      (name) =>
        !["operation.json", "before", "after", "worktree"].includes(name),
    )
  )
    throw preservePrivateOutput();
  for (const name of names.filter((name) => name !== "worktree")) {
    const path = join(directory, name);
    const info = await lstat(path);

    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid!() ||
      (info.mode & 0o077) !== 0 ||
      info.size > 1024 * 1024
    )
      throw preservePrivateOutput();
    const source = await readFile(path, "utf8");
    const expected =
      name === "before"
        ? snapshot.repository.manifestDigest
        : name === "after"
          ? snapshot.proposedDigest
          : null;

    if (name === "operation.json") {
      const marker: unknown = JSON.parse(source);

      if (
        contentDigest(marker) !==
        contentDigest({
          version: 1,
          operationId: operation.id,
          repoPath: snapshot.repository.repoPath,
        })
      )
        throw preservePrivateOutput();
    } else if (expected === null || sha256(source) !== expected)
      throw preservePrivateOutput();
  }
  if (names.includes("worktree")) {
    const staging = join(directory, "worktree");
    const info = await lstat(staging);

    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await commonGitDirectory(staging)) !==
        snapshot.repository.commonDirectory ||
      (await gitResult(staging, ["symbolic-ref", "--quiet", "HEAD"])).code !== 1
    )
      throw preservePrivateOutput();
    if (
      !operation.preparedSha ||
      (await git(staging, ["rev-parse", "HEAD"])).trim() !==
        operation.preparedSha ||
      (await git(staging, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]))
    )
      throw preservePrivateOutput();
    await git(snapshot.repository.repoPath, [
      "worktree",
      "remove",
      "--",
      staging,
    ]);
  }
  // Delete the marker last; partial cleanup only removes present, verified names.
  for (const name of ["before", "after", "operation.json"]) {
    if (names.includes(name)) await unlink(join(directory, name));
  }
  await rmdir(directory);
}

/** Cleanup is independent of the commit result; failures retain evidence and a visible outcome. */
export async function cleanupConfigOperation(
  db: PersistenceDb,
  operation: ConfigOperation,
  authorize: () => Promise<void>,
): Promise<void> {
  if (!["committed", "noop", "stale", "failed"].includes(operation.state))
    return;
  if (operation.cleanupState === "complete") return;
  const [unsettled] = await db
    .select({ id: pushes.id })
    .from(pushes)
    .where(
      and(
        eq(pushes.operationId, operation.id),
        inArray(pushes.state, ["pending", "unknown"]),
      ),
    )
    .limit(1);

  if (unsettled) return;
  let reason: ConfigCleanupReason | null = null;

  try {
    if (operation.snapshot.contentDirectory) {
      await authorize();
      const fence = await acquireRepositoryFence(
        operation.snapshot.repository.repoPath,
        operation.id,
      );

      try {
        await fence.run(() => removeReviewedFiles(operation));
      } finally {
        try {
          await fence.release();
        } catch (error) {
          fence.retain();
          throw error;
        }
      }
    }
  } catch (error) {
    const observed =
      error instanceof MaisterError ? error.details?.reason : undefined;

    reason =
      CONFIG_CLEANUP_REASONS.find((candidate) => candidate === observed) ??
      "cleanup_failed";
    log.warn(
      { operationId: operation.id, cleanupReason: reason },
      "configuration private output retained",
    );
  }
  await db
    .update(operations)
    .set({
      cleanupState: reason ? "retained" : "complete",
      cleanupReason: reason,
      cleanupCheckedAt: new Date(),
    })
    .where(eq(operations.id, operation.id));
}

/** Expired reviews grant no publication authority. Prune each proven private directory once at boot. */
export async function pruneConfigReviews(db: PersistenceDb): Promise<void> {
  let cursor = "";

  for (;;) {
    const batch = await db
      .select()
      .from(operations)
      .where(
        and(
          gt(operations.id, cursor),
          or(
            and(
              eq(operations.state, "previewed"),
              lt(operations.expiresAt, new Date()),
            ),
            and(
              inArray(operations.state, [
                "committed",
                "noop",
                "stale",
                "failed",
              ]),
              ne(operations.cleanupState, "complete"),
            ),
          ),
        ),
      )
      .orderBy(asc(operations.id))
      .limit(50);

    if (batch.length === 0) return;
    for (let operation of batch) {
      cursor = operation.id;
      try {
        if (operation.state === "previewed") {
          const [expired] = await db
            .update(operations)
            .set({
              state: "stale",
              errorReason: "preview_expired",
              completedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(operations.id, operation.id),
                eq(operations.state, "previewed"),
              ),
            )
            .returning();

          if (!expired) continue;
          operation = expired;
        }
        if (operation.cleanupState === "complete") continue;
        await cleanupConfigOperation(db, operation, async () => {
          await requireProjectActionForUser(
            operation.actorUserId,
            operation.projectId,
            "editSettings",
          );
          await requireProjectActionForUser(
            operation.actorUserId,
            operation.projectId,
            "readRepoFiles",
          );
        });
      } catch (error) {
        log.warn(
          {
            operationId: operation.id,
            code: error instanceof MaisterError ? error.code : "UNKNOWN",
          },
          "configuration cleanup retained evidence for explicit attention",
        );
      }
    }
  }
}
