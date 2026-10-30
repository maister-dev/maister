import "server-only";

import type { ConfigPushResult, ConfigPushReview } from "./contracts";
import type { ConfigOperationIdentity, PersistenceDb } from "./store";
import type { ConfigPushSnapshot } from "./types";

import { randomUUID } from "node:crypto";
import {
  chmod,
  open,
  lstat,
  readFile,
  readdir,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { and, asc, eq, gt, inArray, lt, ne, or } from "drizzle-orm";
import pino from "pino";

import { CONFIG_CLEANUP_REASONS, CONFIG_PERSIST_REASONS } from "./contracts";
import { git, gitResult } from "./git";
import { withGitOwnership } from "./git-process";
import { readRepositoryHook } from "./policy";
import { configOperation } from "./service";
import { configReviewRoot } from "./review-files";
import { writeReviewedPushGate } from "./push-gate";
import { assertConfigGitOwnerRetired } from "./repository-lock";

import { atomicWriteJson } from "@/lib/atomic";
import { requireProjectActionForUser } from "@/lib/authz";
import { projectConfigPushIntents as pushes } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { contentDigest, sha256 } from "@/lib/evaluations/digest";
import { isUniqueViolation } from "@/lib/db/pg-error";
import { redactUrl, validateUrl } from "@/lib/repo-source";

type PushIntent = typeof pushes.$inferSelect;
type Authority = () => Promise<void>;
const processOwnership = globalThis as typeof globalThis & {
  __maisterConfigPushOwners?: Set<string>;
};
const liveOwners = (processOwnership.__maisterConfigPushOwners ??=
  new Set<string>());
const log = pino({
  name: "project-config-persistence/push",
  level: process.env.LOG_LEVEL ?? "info",
});

function refused(
  reason:
    | "push_review_stale"
    | "operation_busy"
    | "not_committed"
    | "recovery_required",
  message: string,
): MaisterError {
  return new MaisterError("CONFLICT", message, { details: { reason } });
}

// Read-only discovery also has an independent child deadline if the web process dies.
function inspectGit<T>(action: () => Promise<T>): Promise<T> {
  return withGitOwnership(async () => {}, action);
}

async function pushPolicy(repo: string): Promise<{
  url: string;
  policyDigest: string;
  originalHook: string | null;
  hookDigest: string | null;
}> {
  const origin = await gitResult(repo, [
    "config",
    "--get-all",
    "remote.origin.url",
  ]);

  if (origin.code === 1)
    throw refused(
      "push_review_stale",
      "Add an origin remote in project Git settings before reviewing a push.",
    );
  if (origin.code !== 0)
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "Origin configuration could not be read. Check repository access before reviewing a push.",
      { details: { reason: "repository_unavailable" } },
    );
  const rewrite = await gitResult(repo, [
    "config",
    "--null",
    "--get-regexp",
    "^url\\..*\\.(insteadof|pushinsteadof)$",
  ]);

  if (![0, 1].includes(rewrite.code))
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "Git URL rewriting policy is unreadable. Repair repository configuration before reviewing a push.",
      { details: { reason: "repository_unavailable" } },
    );
  const urls = (
    await git(repo, ["remote", "get-url", "--push", "--all", "origin"])
  )
    .trim()
    .split("\n");

  if (urls.length !== 1 || !urls[0])
    throw refused(
      "push_review_stale",
      "Origin must have exactly one push URL. Review remote settings and try again.",
    );
  const url = urls[0];

  for (const entry of rewrite.stdout.split("\0").filter(Boolean)) {
    const boundary = entry.indexOf("\n");

    if (boundary < 0)
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        "Git URL rewriting policy could not be interpreted.",
        { details: { reason: "repository_unavailable" } },
      );
    if (url.startsWith(entry.slice(boundary + 1)))
      throw refused(
        "push_review_stale",
        "The effective push URL would be rewritten again when used explicitly. Configure an unambiguous final origin destination and create a fresh review.",
      );
  }
  validateUrl(url);
  if (/^https?:/u.test(url)) {
    const parsed = new URL(url);

    if (parsed.username || parsed.password || parsed.search || parsed.hash)
      throw refused(
        "push_review_stale",
        "Remove credentials, query parameters and fragments from the origin URL. Use the host credential helper and create a fresh review.",
      );
  }
  const hook = await readRepositoryHook(repo, "pre-push");
  const originalHook = hook.executable ? hook.path : null;
  const hookDigest = hook.executable ? hook.digest : null;
  const configuration = await git(repo, [
    "config",
    "--null",
    "--list",
    "--show-origin",
    "--show-scope",
  ]);

  return {
    url,
    originalHook,
    hookDigest,
    policyDigest: contentDigest({ configuration, originalHook, hookDigest }),
  };
}

async function remoteHead(
  repo: string,
  snapshot: Pick<ConfigPushSnapshot, "url" | "destination">,
): Promise<string | null> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const output = await inspectGit(() =>
        git(repo, [
          "ls-remote",
          "--refs",
          "--",
          snapshot.url,
          snapshot.destination,
        ]),
      );

      if (!output) return null;
      const lines = output.trim().split("\n");
      const fields = lines[0]?.split("\t");

      if (
        lines.length !== 1 ||
        !fields ||
        !/^[a-f0-9]{40}$/u.test(fields[0]!) ||
        fields[1] !== snapshot.destination
      )
        throw refused(
          "push_review_stale",
          "Remote discovery returned an unexpected ref. Inspect origin before reviewing a push.",
        );

      return fields[0]!;
    } catch (error) {
      lastError = error;
      log.warn(
        {
          attempt: attempt + 1,
          code: error instanceof MaisterError ? error.code : "UNKNOWN",
        },
        "configuration push remote inspection failed",
      );
      if (
        error instanceof MaisterError &&
        error.code !== "EXECUTOR_UNAVAILABLE"
      )
        throw error;
      if (attempt < 2) await delay(attempt === 0 ? 250 : 1000);
    }
  }
  throw lastError;
}

async function outgoing(
  repo: string,
  sha: string,
  base: string | null,
): Promise<string[]> {
  if (
    base !== null &&
    (await gitResult(repo, ["merge-base", "--is-ancestor", base, sha])).code !==
      0
  )
    throw refused(
      "push_review_stale",
      "The remote baseline is not a known ancestor of this configuration commit. Fetch and inspect the remote manually, then create a fresh push preview.",
    );

  return (
    await git(repo, [
      "rev-list",
      "--reverse",
      base === null ? sha : `${base}..${sha}`,
    ])
  )
    .trim()
    .split("\n")
    .filter(Boolean);
}

export async function previewConfigurationPush(
  db: PersistenceDb,
  identity: ConfigOperationIdentity,
  authorize: Authority,
): Promise<ConfigPushReview> {
  await authorize();
  const operation = await configOperation(db, identity);

  if (operation.state !== "committed" || !operation.committedSha)
    throw refused(
      "not_committed",
      "Complete or recover the local configuration commit before reviewing a push.",
    );
  const repo = operation.snapshot.repository.repoPath;
  const policy = await inspectGit(() => pushPolicy(repo));
  const destination = `refs/heads/${operation.snapshot.repository.branch}`;
  const remoteBase = await remoteHead(repo, { url: policy.url, destination });
  const outgoingShas = await outgoing(repo, operation.committedSha, remoteBase);
  const id = randomUUID();
  const directory = join(await configReviewRoot(repo), `push-${id}`);
  const gate = await writeReviewedPushGate({
    directory,
    commitSha: operation.committedSha,
    destination,
    remoteBase,
    originalHook: policy.originalHook,
    originalHookDigest: policy.hookDigest,
    url: policy.url,
  });
  const snapshot: ConfigPushSnapshot = {
    version: 1,
    operationId: operation.id,
    commitSha: operation.committedSha,
    destination,
    destinationFingerprint: contentDigest({ url: policy.url, destination }),
    remoteBase,
    outgoingShas,
    ...policy,
    contentDirectory: directory,
    gateDigest: gate.digest,
    gateFiles: gate.files,
  };

  await atomicWriteJson(join(directory, "push.json"), {
    version: 1,
    pushIntentId: id,
    snapshotDigest: contentDigest(snapshot),
  });
  await chmod(join(directory, "push.json"), 0o600);
  for (const path of [join(directory, "push.json"), directory]) {
    const handle = await open(path, "r");

    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  await authorize();
  const [intent] = await db
    .insert(pushes)
    .values({
      id,
      operationId: operation.id,
      projectId: identity.projectId,
      actorUserId: identity.actorUserId,
      snapshot,
      snapshotDigest: contentDigest(snapshot),
      expiresAt: new Date(Date.now() + 10 * 60_000),
    })
    .returning();

  if (!intent)
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "The push review could not be stored. Create a fresh review.",
    );

  return {
    pushPreviewId: intent.id,
    digest: intent.snapshotDigest,
    expiresAt: intent.expiresAt.toISOString(),
    remote: "origin",
    destination,
    url: redactUrl(policy.url),
    commitSha: snapshot.commitSha,
    remoteBase,
    outgoingShas,
  };
}

async function privatePushFiles(intent: PushIntent): Promise<string[]> {
  const snapshot = intent.snapshot;
  const root = await realpath(join(snapshot.contentDirectory, ".."));
  const expected = join(root, `push-${intent.id}`);

  if (
    expected !== snapshot.contentDirectory ||
    (await realpath(expected)) !== expected
  )
    throw refused(
      "recovery_required",
      "Private push ownership differs. Preserve the directory for inspection.",
    );
  const info = await lstat(expected);

  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid!() ||
    (info.mode & 0o077) !== 0
  )
    throw refused(
      "recovery_required",
      "Private push storage has unexpected ownership or permissions.",
    );
  const names = await readdir(expected);

  if (names.length > 0 && !names.includes("push.json"))
    throw refused(
      "recovery_required",
      "The private push marker is missing. Preserve the directory.",
    );
  for (const name of names) {
    if (!["push.json", "gate.cjs", "pre-push"].includes(name))
      throw refused(
        "recovery_required",
        "Private push output contains unexpected files. Preserve them for inspection.",
      );
    const path = join(expected, name);
    const entry = await lstat(path);

    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      entry.uid !== process.getuid!() ||
      (entry.mode & 0o077) !== 0 ||
      entry.size > 64 * 1024
    )
      throw refused(
        "recovery_required",
        "Private push output has unexpected ownership, type or size.",
      );
    const source = await readFile(path, "utf8");
    const digest =
      name === "push.json"
        ? contentDigest(JSON.parse(source) as unknown)
        : sha256(source);
    const expectedDigest =
      name === "push.json"
        ? contentDigest({
            version: 1,
            pushIntentId: intent.id,
            snapshotDigest: intent.snapshotDigest,
          })
        : snapshot.gateFiles[name as "gate.cjs" | "pre-push"];

    if (digest !== expectedDigest)
      throw refused(
        "recovery_required",
        "Private push output changed. Preserve it and create a fresh review after inspection.",
      );
  }

  return names;
}

async function cleanupPush(
  db: PersistenceDb,
  intent: PushIntent,
  authorize: Authority,
): Promise<PushIntent> {
  if (!["succeeded", "failed", "stale"].includes(intent.state)) return intent;
  if (intent.cleanupState === "complete") return intent;
  let reason: typeof intent.cleanupReason = null;

  try {
    await authorize();
    let names: string[];

    try {
      names = await privatePushFiles(intent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      names = [];
    }
    for (const name of ["gate.cjs", "pre-push", "push.json"])
      if (names.includes(name))
        await unlink(join(intent.snapshot.contentDirectory, name));
    try {
      await rmdir(intent.snapshot.contentDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } catch (error) {
    reason =
      error instanceof MaisterError &&
      [
        "UNAUTHENTICATED",
        "UNAUTHORIZED",
        "PASSWORD_CHANGE_REQUIRED",
        "ACCOUNT_INACTIVE",
      ].includes(error.code)
        ? "authority_changed"
        : error instanceof MaisterError &&
            error.details?.reason === "recovery_required"
          ? "unexpected_private_content"
          : "cleanup_failed";
    log.warn(
      {
        pushIntentId: intent.id,
        cleanupReason: reason,
        code: error instanceof MaisterError ? error.code : "UNKNOWN",
      },
      "private push output retained",
    );
  }
  const [updated] = await db
    .update(pushes)
    .set({
      cleanupState: reason ? "retained" : "complete",
      cleanupReason: reason,
      cleanupCheckedAt: new Date(),
    })
    .where(eq(pushes.id, intent.id))
    .returning();

  if (!updated)
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "The push cleanup receipt could not be stored.",
    );

  return updated;
}

function result(intent: PushIntent): ConfigPushResult {
  const reason = CONFIG_PERSIST_REASONS.find(
    (value) => value === intent.errorReason,
  );
  const cleanupReason = CONFIG_CLEANUP_REASONS.find(
    (value) => value === intent.cleanupReason,
  );

  return {
    operationId: intent.operationId,
    pushIntentId: intent.id,
    state: intent.state,
    commitSha: intent.snapshot.commitSha,
    localCommitPreserved: true,
    cleanupState: intent.cleanupState,
    ...(reason ? { reason } : {}),
    ...(cleanupReason ? { cleanupReason } : {}),
  };
}

export async function confirmConfigurationPush(
  db: PersistenceDb,
  identity: ConfigOperationIdentity,
  pushPreviewId: string,
  authorize: Authority,
): Promise<ConfigPushResult> {
  await authorize();
  const operation = await configOperation(db, identity);
  let [intent] = await db
    .select()
    .from(pushes)
    .where(
      and(
        eq(pushes.id, pushPreviewId),
        eq(pushes.operationId, identity.id),
        eq(pushes.projectId, identity.projectId),
        eq(pushes.actorUserId, identity.actorUserId),
      ),
    );

  if (!intent)
    throw new MaisterError("PRECONDITION", "Push review was not found.", {
      details: { httpStatus: 404 },
    });
  if (contentDigest(intent.snapshot) !== intent.snapshotDigest)
    throw refused(
      "recovery_required",
      "The push review digest differs from its immutable snapshot.",
    );
  if (["succeeded", "failed", "stale"].includes(intent.state))
    return result(await cleanupPush(db, intent, authorize));
  if (intent.state !== "previewed")
    throw refused(
      "recovery_required",
      "This push was already accepted. Recover its outcome before issuing another push; it will not be reissued.",
    );
  if (liveOwners.has(intent.id))
    throw refused(
      "operation_busy",
      "This push confirmation is already active.",
    );
  liveOwners.add(intent.id);
  const ownerToken = randomUUID();
  const repo = operation.snapshot.repository.repoPath;

  try {
    const policy = await inspectGit(() => pushPolicy(repo));

    if (
      intent.expiresAt.getTime() <= Date.now() ||
      operation.committedSha !== intent.snapshot.commitSha ||
      contentDigest(policy) !==
        contentDigest({
          url: intent.snapshot.url,
          policyDigest: intent.snapshot.policyDigest,
          originalHook: intent.snapshot.originalHook,
          hookDigest: intent.snapshot.hookDigest,
        }) ||
      (await remoteHead(repo, intent.snapshot)) !==
        intent.snapshot.remoteBase ||
      contentDigest(
        await outgoing(
          repo,
          intent.snapshot.commitSha,
          intent.snapshot.remoteBase,
        ),
      ) !== contentDigest(intent.snapshot.outgoingShas)
    ) {
      const [stale] = await db
        .update(pushes)
        .set({
          state: "stale",
          completedAt: new Date(),
          errorReason: "push_review_stale",
        })
        .where(and(eq(pushes.id, intent.id), eq(pushes.state, "previewed")))
        .returning();

      if (!stale)
        throw refused(
          "operation_busy",
          "The push review changed. Read its current receipt.",
        );

      return result(await cleanupPush(db, stale, authorize));
    }
    const names = await privatePushFiles(intent);

    if (names.length !== 3)
      throw refused(
        "push_review_stale",
        "Private push review files are incomplete. Create a fresh review.",
      );
    await authorize();
    try {
      const [claimed] = await db
        .update(pushes)
        .set({
          state: "pending",
          acceptedAt: new Date(),
          ownerToken,
          ownerProcessId: process.pid,
        })
        .where(and(eq(pushes.id, intent.id), eq(pushes.state, "previewed")))
        .returning();

      if (!claimed)
        throw refused(
          "operation_busy",
          "The push review was claimed concurrently.",
        );
      intent = claimed;
    } catch (error) {
      if (isUniqueViolation(error, "project_config_push_active_destination_uq"))
        throw refused(
          "operation_busy",
          "An earlier push to this destination requires outcome recovery.",
        );
      throw error;
    }
    const outcome = await withGitOwnership(
      async (group) => {
        await authorize();
        const [owned] = await db
          .update(pushes)
          .set({ processGroup: group })
          .where(
            and(
              eq(pushes.id, intent.id),
              eq(pushes.ownerToken, ownerToken),
              eq(pushes.state, "pending"),
            ),
          )
          .returning({ id: pushes.id });

        if (!owned)
          throw refused(
            "operation_busy",
            "Push ownership changed before Git issuance.",
          );
      },
      () =>
        gitResult(repo, [
          "-c",
          `core.hooksPath=${intent.snapshot.contentDirectory}`,
          "push",
          "--porcelain",
          "--no-follow-tags",
          "--recurse-submodules=no",
          "--",
          intent.snapshot.url,
          `${intent.snapshot.commitSha}:${intent.snapshot.destination}`,
        ]),
    );
    const knownRefusal =
      outcome.stderr?.includes("MAISTER_PUSH_HOOK_REFUSED") ||
      outcome.stderr?.includes("MAISTER_PUSH_BASELINE_REFUSED") ||
      /\[(?:remote )?rejected\]/u.test(outcome.stdout);
    const state =
      outcome.code === 0 ? "succeeded" : knownRefusal ? "failed" : "unknown";
    const [settled] = await db
      .update(pushes)
      .set({
        state,
        completedAt: state === "unknown" ? null : new Date(),
        errorReason: state === "succeeded" ? null : "push_failed",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(pushes.id, intent.id),
          eq(pushes.ownerToken, ownerToken),
          eq(pushes.state, "pending"),
        ),
      )
      .returning();

    if (!settled)
      throw refused(
        "recovery_required",
        "The push outcome receipt changed. Recover the recorded intent.",
      );
    log.info(
      { pushIntentId: settled.id, operationId: operation.id, state },
      "configuration push completed",
    );

    return result(await cleanupPush(db, settled, authorize));
  } catch (error) {
    if (intent.state === "pending") {
      await db
        .update(pushes)
        .set({
          state: "unknown",
          errorReason: "push_failed",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(pushes.id, intent.id),
            eq(pushes.ownerToken, ownerToken),
            eq(pushes.state, "pending"),
          ),
        );
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        "The push outcome needs recovery. The local configuration commit is preserved; do not reissue this push.",
        {
          details: { reason: "recovery_required" },
          cause: error instanceof Error ? error : undefined,
        },
      );
    }
    throw error;
  } finally {
    liveOwners.delete(intent.id);
  }
}

/** Outcome inspection never issues a new push and does not hold the parent mutation fence. */
export async function recoverConfigurationPushes(
  db: PersistenceDb,
  identity: ConfigOperationIdentity,
  authorize: Authority,
): Promise<void> {
  await authorize();
  const operation = await configOperation(db, identity);
  const intents = await db
    .select()
    .from(pushes)
    .where(
      and(
        eq(pushes.operationId, identity.id),
        eq(pushes.actorUserId, identity.actorUserId),
        inArray(pushes.state, ["pending", "unknown"]),
      ),
    );

  for (const intent of intents) {
    if (liveOwners.has(intent.id))
      throw refused(
        "operation_busy",
        "The accepted push owner is still active.",
      );
    await assertConfigGitOwnerRetired(
      intent.ownerProcessId,
      intent.processGroup,
    );
    const observed = await remoteHead(
      operation.snapshot.repository.repoPath,
      intent.snapshot,
    );
    const succeeded =
      observed === intent.snapshot.commitSha ||
      (observed !== null &&
        (
          await gitResult(operation.snapshot.repository.repoPath, [
            "merge-base",
            "--is-ancestor",
            intent.snapshot.commitSha,
            observed,
          ])
        ).code === 0);
    const notIssued = intent.processGroup === null;
    const state = succeeded ? "succeeded" : notIssued ? "failed" : "unknown";
    const [settled] = await db
      .update(pushes)
      .set({
        state,
        errorReason: succeeded ? null : "push_failed",
        completedAt: state === "unknown" ? null : new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(pushes.id, intent.id),
          eq(pushes.state, intent.state),
          eq(pushes.ownerToken, intent.ownerToken!),
        ),
      )
      .returning();

    if (settled) await cleanupPush(db, settled, authorize);
  }
}

/** One startup scan inspects accepted push outcomes, with per-intent failure isolation. */
export async function recoverAcceptedConfigurationPushes(
  db: PersistenceDb,
): Promise<void> {
  let cursor = "";

  for (;;) {
    const batch = await db
      .select()
      .from(pushes)
      .where(
        and(
          gt(pushes.id, cursor),
          inArray(pushes.state, ["pending", "unknown"]),
        ),
      )
      .orderBy(asc(pushes.id))
      .limit(50);

    if (!batch.length) break;
    for (const intent of batch) {
      cursor = intent.id;
      try {
        await recoverConfigurationPushes(
          db,
          {
            id: intent.operationId,
            projectId: intent.projectId,
            actorUserId: intent.actorUserId,
          },
          async () => {
            await requireProjectActionForUser(
              intent.actorUserId,
              intent.projectId,
              "editSettings",
            );
            await requireProjectActionForUser(
              intent.actorUserId,
              intent.projectId,
              "readRepoFiles",
            );
          },
        );
      } catch (error) {
        log.warn(
          {
            pushIntentId: intent.id,
            code: error instanceof MaisterError ? error.code : "UNKNOWN",
          },
          "accepted configuration push retained for explicit outcome inspection",
        );
      }
    }
  }
  await pruneConfigurationPushReviews(db);
}

/** Terminal push files and expired unconfirmed reviews have no network effects. */
export async function pruneConfigurationPushReviews(
  db: PersistenceDb,
): Promise<void> {
  let cursor = "";

  for (;;) {
    const batch = await db
      .select()
      .from(pushes)
      .where(
        and(
          gt(pushes.id, cursor),
          or(
            and(
              eq(pushes.state, "previewed"),
              lt(pushes.expiresAt, new Date()),
            ),
            and(
              inArray(pushes.state, ["succeeded", "failed", "stale"]),
              ne(pushes.cleanupState, "complete"),
            ),
          ),
        ),
      )
      .orderBy(asc(pushes.id))
      .limit(50);

    if (!batch.length) return;
    for (let intent of batch) {
      cursor = intent.id;
      try {
        if (intent.state === "previewed") {
          const [expired] = await db
            .update(pushes)
            .set({
              state: "stale",
              completedAt: new Date(),
              errorReason: "push_review_stale",
            })
            .where(and(eq(pushes.id, intent.id), eq(pushes.state, "previewed")))
            .returning();

          if (!expired) continue;
          intent = expired;
        }
        await cleanupPush(db, intent, async () => {
          await requireProjectActionForUser(
            intent.actorUserId,
            intent.projectId,
            "editSettings",
          );
          await requireProjectActionForUser(
            intent.actorUserId,
            intent.projectId,
            "readRepoFiles",
          );
        });
      } catch (error) {
        log.warn(
          {
            pushIntentId: intent.id,
            code: error instanceof MaisterError ? error.code : "UNKNOWN",
          },
          "private push cleanup retained for explicit attention",
        );
      }
    }
  }
}
