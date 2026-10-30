import "server-only";

import type { ConfigPersistSnapshot } from "./types";
import type { ConfigPreview } from "./contracts";
import type {
  ConfigOperation,
  ConfigOperationIdentity,
  PersistenceDb,
} from "./store";

import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

import { eq, sql } from "drizzle-orm";
import pino from "pino";

import {
  findConfigOperation,
  insertConfigReview,
  transitionConfigOperation,
} from "./store";
import { assertExportablePackages, readExportSnapshot } from "./projection";
import {
  exportProjectionDigest,
  manifestMatches,
  patchProjectManifest,
} from "./manifest";
import {
  assertRepositoryReady,
  currentConfigStatus,
  inspectRepository,
} from "./status";
import { writeConfigReviewFiles, configReviewRoot } from "./review-files";
import { acquireRepositoryFence } from "./repository-lock";
import {
  prepareConfigCommit,
  publishConfigCommit,
  verifyConfigCommit,
} from "./git-publication";
import { gitResult } from "./git";
import {
  inspectPartialPublication,
  assertPublicationSeam,
  assertPartialPublicationSeam,
  unpublishedOperationCanClose,
} from "./publication-state";

import { parseProjectConfig } from "@/lib/config";
import { projects } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { contentDigest, sha256 } from "@/lib/evaluations/digest";

const log = pino({
  name: "project-config-persistence/service",
  level: process.env.LOG_LEVEL ?? "info",
});

export const CONFIG_COMMIT_MESSAGE = "chore(maister): persist project config";
const terminal = new Set(["committed", "noop", "stale", "failed"]);

type Authority = () => Promise<void>;

function stale(): MaisterError {
  return new MaisterError(
    "CONFLICT",
    "Configuration or repository evidence changed. Create a fresh preview and review its complete diff.",
    { details: { reason: "stale_preview" } },
  );
}

export async function configOperation(
  db: PersistenceDb,
  identity: ConfigOperationIdentity,
): Promise<ConfigOperation> {
  const operation = await findConfigOperation(db, identity);

  if (!operation)
    throw new MaisterError(
      "PRECONDITION",
      "Configuration operation was not found.",
      { details: { httpStatus: 404 } },
    );
  if (contentDigest(operation.snapshot) !== operation.snapshotDigest)
    throw new MaisterError(
      "CONFLICT",
      "The immutable review does not match its recorded digest. Preserve the operation for manual recovery.",
      { details: { reason: "recovery_required" } },
    );

  return operation;
}

async function assertReviewedConfiguration(
  db: PersistenceDb,
  snapshot: ConfigPersistSnapshot,
): Promise<void> {
  const current = await readExportSnapshot(db, snapshot.projectId);

  if (
    current.project.repoPath !== snapshot.registeredRepoPath ||
    current.exportRevision !== snapshot.exportRevision ||
    exportProjectionDigest(current.projection) !==
      exportProjectionDigest(snapshot.projection)
  )
    throw stale();
}

async function verifyPrivateBytes(operation: ConfigOperation): Promise<void> {
  const snapshot = operation.snapshot;
  const expected = join(
    await configReviewRoot(snapshot.repository.repoPath),
    operation.id,
  );

  if (
    snapshot.contentDirectory !== expected ||
    (await realpath(expected)) !== expected
  )
    throw stale();
  for (const name of [
    "operation.json",
    "after",
    ...(snapshot.repository.manifestDigest === null ? [] : ["before"]),
  ]) {
    const info = await lstat(join(expected, name));

    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid!() ||
      (info.mode & 0o077) !== 0
    )
      throw stale();
  }
  const marker: unknown = JSON.parse(
    await readFile(join(expected, "operation.json"), "utf8"),
  );

  if (
    contentDigest(marker) !==
    contentDigest({
      version: 1,
      operationId: operation.id,
      repoPath: snapshot.repository.repoPath,
    })
  )
    throw stale();
  if (
    sha256(await readFile(join(expected, "after"), "utf8")) !==
    snapshot.proposedDigest
  )
    throw stale();
  if (
    snapshot.repository.manifestDigest !== null &&
    sha256(await readFile(join(expected, "before"), "utf8")) !==
      snapshot.repository.manifestDigest
  )
    throw stale();
}

async function assertRegisteredRepository(
  snapshot: ConfigPersistSnapshot,
): Promise<void> {
  if (!snapshot.registeredRepoPath) throw stale();
  try {
    if (
      (await realpath(snapshot.registeredRepoPath)) !==
      snapshot.repository.repoPath
    )
      throw stale();
  } catch (error) {
    if (
      ["ENOENT", "ENOTDIR"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      throw stale();
    throw error;
  }
}

async function assertFreshRepository(
  snapshot: ConfigPersistSnapshot,
): Promise<void> {
  await assertRegisteredRepository(snapshot);
  const current = await inspectRepository({
    repoPath: snapshot.repository.repoPath,
    mainBranch: snapshot.repository.branch,
  });

  assertRepositoryReady(current);
  if (contentDigest(current.repository) !== contentDigest(snapshot.repository))
    throw stale();
}

export async function previewProjectConfiguration(
  db: PersistenceDb,
  projectId: string,
  actorUserId: string,
): Promise<ConfigPreview> {
  const current = await readExportSnapshot(db, projectId);
  const observed = await inspectRepository(current.project);
  const status = await currentConfigStatus(db, projectId);

  if (observed.blocker || status.reason)
    return {
      kind: "blocked" as const,
      status,
      reason: observed.blocker ?? status.reason!,
      paths: observed.repository.status
        .split("\0")
        .filter(Boolean)
        .map((entry) => entry.slice(3)),
    };
  await assertExportablePackages(current.projection);
  const proposed = patchProjectManifest(observed.source, current.projection);

  try {
    parseProjectConfig(proposed, "maister.yaml");
  } catch (cause) {
    throw new MaisterError(
      "CONFIG",
      "The proposed manifest violates project registration validation. Resolve duplicate source identifiers and preview again.",
      {
        cause: cause instanceof Error ? cause : undefined,
        details: { reason: "manifest_invalid" },
      },
    );
  }
  const id = randomUUID();
  const identity = { id, projectId, actorUserId };
  const unchanged =
    observed.source !== null &&
    manifestMatches(observed.source, current.projection);
  const files = unchanged
    ? { contentDirectory: "", diff: "" }
    : await writeConfigReviewFiles({
        operationId: id,
        repoPath: current.project.repoPath,
        source: observed.source,
        proposed,
        manifestMode: observed.repository.manifestMode,
      });
  const snapshot: ConfigPersistSnapshot = {
    version: 1,
    projectId,
    actorUserId,
    exportRevision: current.exportRevision,
    registeredRepoPath: current.project.repoPath,
    projection: current.projection,
    repository: observed.repository,
    proposedDigest: sha256(proposed),
    diffDigest: sha256(files.diff),
    contentDirectory: files.contentDirectory,
    message: CONFIG_COMMIT_MESSAGE,
  };
  let operation = await insertConfigReview(db, identity, snapshot);

  if (unchanged) {
    await assertRegisteredRepository(snapshot);
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`,
      );
      await assertReviewedConfiguration(tx, snapshot);
      await tx
        .update(projects)
        .set({
          maisterYamlPath: join(snapshot.repository.repoPath, "maister.yaml"),
        })
        .where(eq(projects.id, projectId));
      operation = await transitionConfigOperation(
        tx,
        identity,
        { state: "previewed", ownerToken: null },
        {
          state: "noop",
          completedAt: new Date(),
          cleanupState: "complete",
          cleanupCheckedAt: new Date(),
        },
      );
    });

    return {
      kind: "noop" as const,
      operationId: operation.id,
      status: { ...status, operationId: operation.id },
    };
  }

  return {
    kind: "ready" as const,
    previewId: id,
    digest: operation.snapshotDigest,
    expiresAt: operation.expiresAt.toISOString(),
    targetBranch: snapshot.repository.branch,
    filename: "maister.yaml" as const,
    message: CONFIG_COMMIT_MESSAGE,
    diff: files.diff,
    baseSha: snapshot.repository.head,
    exportRevision: snapshot.exportRevision,
    usedDefaultAuthor: snapshot.repository.usedDefaultAuthor,
  };
}

async function publishedCommit(
  snapshot: ConfigPersistSnapshot,
  sha: string,
): Promise<boolean> {
  await verifyConfigCommit(snapshot, sha);
  const tip = await gitResult(snapshot.repository.repoPath, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${snapshot.repository.branch}`,
  ]);

  if (tip.code === 1) return false;
  if (tip.code !== 0)
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "The publication branch cannot be inspected.",
    );
  const ancestry = await gitResult(snapshot.repository.repoPath, [
    "merge-base",
    "--is-ancestor",
    sha,
    tip.stdout.trim(),
  ]);

  if (ancestry.code !== 0 && ancestry.code !== 1)
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "Publication ancestry cannot be inspected.",
    );

  return ancestry.code === 0;
}

async function finalizeConfigOperation(
  db: PersistenceDb,
  operation: ConfigOperation,
): Promise<ConfigOperation> {
  const sha = operation.preparedSha!;

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT id FROM projects WHERE id = ${operation.projectId} FOR UPDATE`,
    );
    await tx
      .update(projects)
      .set({
        maisterYamlPath: join(
          operation.snapshot.repository.repoPath,
          "maister.yaml",
        ),
      })
      .where(eq(projects.id, operation.projectId));

    return transitionConfigOperation(
      tx,
      operation,
      { state: operation.state, ownerToken: operation.ownerToken },
      {
        state: "committed",
        committedSha: sha,
        completedAt: new Date(),
        errorReason: null,
      },
    );
  });
}

/** Replays accepted intent; a terminal receipt never starts another commit. */
export async function confirmProjectConfiguration(
  db: PersistenceDb,
  identity: ConfigOperationIdentity,
  authorize: Authority,
): Promise<ConfigOperation> {
  let operation = await configOperation(db, identity);

  if (terminal.has(operation.state)) return operation;
  const snapshot = operation.snapshot;
  const fence = await acquireRepositoryFence(
    snapshot.repository.repoPath,
    operation.id,
  );
  let release = true;

  try {
    return await fence.run(async () => {
      operation = await configOperation(db, identity);
      if (terminal.has(operation.state)) return operation;
      if (
        operation.preparedSha &&
        (await publishedCommit(snapshot, operation.preparedSha))
      ) {
        if (operation.state === "prepared")
          operation = await transitionConfigOperation(
            db,
            identity,
            { state: "prepared", ownerToken: operation.ownerToken },
            { state: "publishing" },
          );

        return finalizeConfigOperation(db, operation);
      }
      await authorize();
      await verifyPrivateBytes(operation);
      await assertReviewedConfiguration(db, snapshot);
      await assertExportablePackages(snapshot.projection);
      if (operation.state === "previewed") {
        if (operation.expiresAt.getTime() <= Date.now()) {
          operation = await transitionConfigOperation(
            db,
            identity,
            { state: "previewed", ownerToken: null },
            {
              state: "stale",
              completedAt: new Date(),
              errorReason: "preview_expired",
            },
          );

          return operation;
        }
        await assertFreshRepository(snapshot);
        operation = await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT id FROM projects WHERE id = ${identity.projectId} FOR UPDATE`,
          );
          await assertReviewedConfiguration(tx, snapshot);

          return transitionConfigOperation(
            tx,
            identity,
            { state: "previewed", ownerToken: null },
            {
              state: "preparing",
              acceptedAt: new Date(),
              ownerToken: randomUUID(),
              ownerProcessId: process.pid,
            },
          );
        });
      } else {
        operation = await transitionConfigOperation(
          db,
          identity,
          { state: operation.state, ownerToken: operation.ownerToken },
          {
            state: operation.state,
            ownerToken: randomUUID(),
            ownerProcessId: process.pid,
          },
        );
      }
      if (
        operation.state === "preparing" ||
        (operation.state === "recovery_required" &&
          operation.preparedSha === null)
      ) {
        const prepared = await prepareConfigCommit(operation.id, snapshot);

        operation = await transitionConfigOperation(
          db,
          identity,
          { state: operation.state, ownerToken: operation.ownerToken },
          { state: "prepared", preparedSha: prepared.sha, errorReason: null },
        );
      }
      const sha = operation.preparedSha;

      if (!sha)
        throw new MaisterError(
          "CONFLICT",
          "Accepted operation has no prepared commit; preserve evidence for recovery.",
          { details: { reason: "recovery_required" } },
        );
      let partial: "old" | "new" = "old";

      if (
        operation.state === "recovery_required" ||
        operation.state === "publishing"
      ) {
        partial = await inspectPartialPublication(operation);
        if (operation.state === "recovery_required")
          operation = await transitionConfigOperation(
            db,
            identity,
            { state: "recovery_required", ownerToken: operation.ownerToken },
            { state: "publishing", errorReason: null },
          );
      }
      await authorize();
      await assertReviewedConfiguration(db, snapshot);
      if (operation.state === "prepared") {
        await assertFreshRepository(snapshot);
        operation = await transitionConfigOperation(
          db,
          identity,
          { state: "prepared", ownerToken: operation.ownerToken },
          { state: "publishing" },
        );
      }
      const assertCurrentAuthority = async (): Promise<void> => {
        await authorize();
        await assertReviewedConfiguration(db, snapshot);
        await assertRegisteredRepository(snapshot);
        await assertExportablePackages(snapshot.projection);
      };

      await publishConfigCommit(
        snapshot,
        sha,
        {
          beforeWrite: async () => {
            await assertCurrentAuthority();
            if (partial === "new")
              await assertPartialPublicationSeam(operation);
            else await assertPublicationSeam(snapshot);

            return partial;
          },
          beforePublish: assertCurrentAuthority,
        },
        fence,
      );
      if (!(await publishedCommit(snapshot, sha)))
        throw new MaisterError(
          "CONFLICT",
          "Publication acknowledgement requires recovery.",
          { details: { reason: "recovery_required" } },
        );
      operation = await finalizeConfigOperation(db, operation);
      log.info(
        { operationId: operation.id, sha },
        "configuration operation committed",
      );

      return operation;
    });
  } catch (error) {
    const reason =
      error instanceof MaisterError ? error.details?.reason : undefined;
    let uncertain =
      operation.state === "publishing" ||
      operation.state === "recovery_required" ||
      (operation.state === "preparing" && reason !== "commit_failed");

    if (!terminal.has(operation.state)) {
      try {
        if (
          uncertain &&
          operation.preparedSha &&
          reason !== "recovery_required" &&
          !(await publishedCommit(snapshot, operation.preparedSha))
        ) {
          await fence.assertQuiescent();
          if (
            (error instanceof MaisterError &&
              error.details?.worktreeUpdateStarted === false) ||
            (await unpublishedOperationCanClose(operation))
          ) {
            if (operation.state === "publishing")
              operation = await transitionConfigOperation(
                db,
                identity,
                { state: "publishing", ownerToken: operation.ownerToken },
                {
                  state: "recovery_required",
                  errorReason: "recovery_required",
                },
              );
            uncertain = false;
          }
        }
        operation = await transitionConfigOperation(
          db,
          identity,
          { state: operation.state, ownerToken: operation.ownerToken },
          uncertain
            ? { state: "recovery_required", errorReason: "recovery_required" }
            : {
                state: reason === "commit_failed" ? "failed" : "stale",
                completedAt: new Date(),
                errorReason:
                  typeof reason === "string" ? reason : "stale_preview",
              },
        );
      } catch (receiptError) {
        release = false;
        log.error(
          { operationId: operation.id, state: operation.state },
          "configuration failure receipt requires recovery",
        );
        throw receiptError;
      }
    }
    if (uncertain) release = false;
    throw error;
  } finally {
    if (release) {
      try {
        await fence.release();
      } catch (error) {
        fence.retain();
        throw error;
      }
    } else fence.retain();
  }
}
