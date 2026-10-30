import "server-only";

import type { RepositoryFence } from "./repository-lock";
import type { ConfigPersistSnapshot } from "./types";

import { chmod, lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import pino from "pino";

import { git, gitResult } from "./git";
import { commonGitDirectory } from "./repository-lock";
import { assertReservedPublicationSeam } from "./publication-state";
import { executeGitConversation } from "./git-conversation";

import { MaisterError } from "@/lib/errors";
import { sha256 } from "@/lib/evaluations/digest";

const log = pino({
  name: "project-config-persistence/publication",
  level: process.env.LOG_LEVEL ?? "info",
});
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export type PreparedConfigCommit = {
  sha: string;
  stagingPath: string;
  privateRef: string;
};

function publicationFailure(message: string): MaisterError {
  return new MaisterError("PRECONDITION", message, {
    details: { reason: "commit_failed" },
  });
}

export async function verifyConfigCommit(
  snapshot: ConfigPersistSnapshot,
  sha: string,
): Promise<void> {
  const repo = snapshot.repository.repoPath;
  const raw = await git(repo, ["cat-file", "commit", sha]);
  const boundary = raw.indexOf("\n\n");
  const headers = raw.slice(0, boundary).split("\n");
  const parents = headers
    .filter((line) => line.startsWith("parent "))
    .map((line) => line.slice(7));
  const expectedParents =
    snapshot.repository.head === null ? [] : [snapshot.repository.head];

  if (
    boundary < 0 ||
    JSON.stringify(parents) !== JSON.stringify(expectedParents) ||
    raw.slice(boundary + 2) !== `${snapshot.message}\n`
  )
    throw publicationFailure(
      "The commit parent or message differs from the reviewed configuration. Inspect repository commit hooks and create a fresh preview.",
    );
  if (
    snapshot.repository.signingRequired &&
    !headers.some((line) => line.startsWith("gpgsig "))
  )
    throw publicationFailure(
      "The prepared commit has no required signature. Inspect repository signing policy and the retained private worktree.",
    );
  const paths = await git(repo, [
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "-r",
    "-z",
    snapshot.repository.head ?? EMPTY_TREE,
    sha,
  ]);

  if (paths !== "maister.yaml\0")
    throw publicationFailure(
      "A commit hook changed additional paths. Inspect the retained private worktree and repository hooks before retrying.",
    );
  const entry = (
    await git(repo, ["ls-tree", sha, "--", "maister.yaml"])
  ).trim();
  const mode = snapshot.repository.manifestMode ?? "100644";

  if (
    !entry.startsWith(`${mode} blob `) ||
    sha256(await git(repo, ["show", `${sha}:maister.yaml`])) !==
      snapshot.proposedDigest
  )
    throw publicationFailure(
      "A commit hook changed the reviewed manifest bytes or mode. Inspect the retained private worktree and create a fresh preview.",
    );
}

async function privateCommitPolicy(
  snapshot: ConfigPersistSnapshot,
): Promise<string[]> {
  const repo = snapshot.repository.repoPath;
  const hooks = resolve(
    repo,
    (await git(repo, ["rev-parse", "--git-path", "hooks/pre-commit"])).trim(),
  );
  const options = [
    "-c",
    `user.name=${snapshot.repository.authorName}`,
    "-c",
    `user.email=${snapshot.repository.authorEmail}`,
    "-c",
    `core.hooksPath=${dirname(hooks)}`,
  ];

  for (const key of [
    "commit.gpgSign",
    "user.signingKey",
    "gpg.format",
    "gpg.program",
    "gpg.openpgp.program",
    "gpg.ssh.program",
    "gpg.x509.program",
  ]) {
    const value = await gitResult(repo, ["config", "--get", key]);

    if (value.code === 0)
      options.push("-c", `${key}=${value.stdout.trimEnd()}`);
    else if (value.code !== 1)
      throw publicationFailure(
        "Git commit policy is unreadable; restore repository configuration before retrying.",
      );
  }

  return options;
}

/** Normal commit hooks and signing run in an operation-owned detached worktree. */
export async function prepareConfigCommit(
  operationId: string,
  snapshot: ConfigPersistSnapshot,
): Promise<PreparedConfigCommit> {
  const repo = snapshot.repository.repoPath;
  const stagingPath = join(snapshot.contentDirectory, "worktree");
  const privateRef = `refs/maister/config-persist/${operationId}`;
  const anchored = await gitResult(repo, [
    "rev-parse",
    "--verify",
    "--quiet",
    privateRef,
  ]);

  if (anchored.code === 0) {
    const sha = anchored.stdout.trim();

    await verifyConfigCommit(snapshot, sha);

    return { sha, stagingPath, privateRef };
  }
  if (anchored.code !== 1)
    throw publicationFailure(
      "The private commit reference is unreadable; recover this operation before retrying.",
    );
  const policy = await privateCommitPolicy(snapshot);
  let present = false;

  try {
    const info = await lstat(stagingPath);

    if (!info.isDirectory() || info.isSymbolicLink())
      throw publicationFailure(
        "The private staging path has unexpected ownership or type; preserve it and inspect this operation.",
      );
    present = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (present) {
    if (
      (await commonGitDirectory(stagingPath)) !==
        snapshot.repository.commonDirectory ||
      (await realpath(
        (await git(stagingPath, ["rev-parse", "--show-toplevel"])).trim(),
      )) !== stagingPath ||
      (await gitResult(stagingPath, ["symbolic-ref", "--quiet", "HEAD"]))
        .code !== 1
    )
      throw publicationFailure(
        "The private worktree identity changed. Preserve it for manual recovery.",
      );
    const sha = (await git(stagingPath, ["rev-parse", "HEAD"])).trim();

    const object = await git(repo, ["cat-file", "commit", sha]);
    const scaffold =
      snapshot.repository.head === null &&
      object.includes(`tree ${EMPTY_TREE}\n`) &&
      !object.split("\n\n")[0]!.includes("\nparent ") &&
      object.endsWith(`\n\nMAIster private scaffold ${operationId}\n`);

    if (sha !== snapshot.repository.head && !scaffold) {
      // A completed commit whose acknowledgement was lost is adopted without rerunning hooks.
      await verifyConfigCommit(snapshot, sha);
      if (
        await git(stagingPath, [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
        ])
      )
        throw publicationFailure(
          "The private worktree contains unexpected edits; preserve it for manual recovery.",
        );
      await git(repo, ["update-ref", privateRef, sha, "0".repeat(40)]);

      return { sha, stagingPath, privateRef };
    }
    const changes = (
      await git(stagingPath, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ])
    )
      .split("\0")
      .filter(Boolean);

    if (changes.some((entry) => entry.slice(3) !== "maister.yaml"))
      throw publicationFailure(
        "The interrupted private worktree contains unrelated changes. Preserve it for inspection.",
      );
    try {
      const contents = await readFile(
        join(stagingPath, "maister.yaml"),
        "utf8",
      );
      const digest = sha256(contents);

      if (
        digest !== snapshot.proposedDigest &&
        digest !== snapshot.repository.manifestDigest
      )
        throw publicationFailure(
          "The interrupted private manifest has unknown contents. Preserve it for inspection.",
        );
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        snapshot.repository.manifestDigest !== null
      )
        throw error;
    }
  }
  if (!present) {
    let base = snapshot.repository.head;

    if (base === null) {
      // The scaffold is private and is amended away; the published first commit has no parent.
      await git(repo, ["hash-object", "-t", "tree", "-w", "/dev/null"]);
      base = (
        await git(repo, [
          ...policy,
          "commit-tree",
          EMPTY_TREE,
          "-m",
          `MAIster private scaffold ${operationId}`,
        ])
      ).trim();
    }
    await git(repo, ["worktree", "add", "--detach", "--", stagingPath, base]);
    await chmod(stagingPath, 0o700);
  }
  const proposed = await readFile(
    join(snapshot.contentDirectory, "after"),
    "utf8",
  );

  if (sha256(proposed) !== snapshot.proposedDigest)
    throw publicationFailure(
      "Private reviewed bytes changed; create a fresh preview.",
    );
  await writeFile(join(stagingPath, "maister.yaml"), proposed, {
    mode: snapshot.repository.manifestMode === "100755" ? 0o700 : 0o600,
  });
  await chmod(
    join(stagingPath, "maister.yaml"),
    snapshot.repository.manifestMode === "100755" ? 0o700 : 0o600,
  );
  await git(stagingPath, ["add", "--", "maister.yaml"]);
  const beforeCommit = (await git(stagingPath, ["rev-parse", "HEAD"])).trim();
  const result = await gitResult(stagingPath, [
    ...policy,
    "commit",
    ...(snapshot.repository.head === null ? ["--amend", "--reset-author"] : []),
    "-m",
    snapshot.message,
  ]);

  const sha = (await git(stagingPath, ["rev-parse", "HEAD"])).trim();

  if (result.code !== 0 && sha === beforeCommit)
    throw publicationFailure(
      "The private configuration commit failed. Check repository hooks, signing credentials and worktree dependencies; create a fresh preview after resolving the failure.",
    );
  await verifyConfigCommit(snapshot, sha);
  if (result.code !== 0)
    log.warn(
      { operationId, sha, exitCode: result.code },
      "prepared configuration commit observed after non-zero Git exit",
    );
  if (
    await git(stagingPath, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ])
  )
    throw publicationFailure(
      "A commit hook left private worktree changes. Inspect the retained operation before retrying.",
    );
  await git(repo, ["update-ref", privateRef, sha, "0".repeat(40)]);
  log.info({ operationId, sha }, "configuration commit prepared");

  return { sha, stagingPath, privateRef };
}

async function reviewedPublicationState(
  snapshot: ConfigPersistSnapshot,
  revalidate: () => Promise<"old" | "new">,
): Promise<"old" | "new"> {
  try {
    const symbolicHead = (
      await git(snapshot.repository.repoPath, [
        "symbolic-ref",
        "--quiet",
        "HEAD",
      ])
    ).trim();

    if (symbolicHead !== `refs/heads/${snapshot.repository.branch}`)
      throw new MaisterError(
        "CONFLICT",
        "The checked-out branch changed; create a fresh configuration preview.",
        { details: { reason: "stale_preview" } },
      );

    return await revalidate();
  } catch (error) {
    if (
      !(error instanceof MaisterError) ||
      ![
        "CONFLICT",
        "PRECONDITION",
        "CONFIG",
        "UNAUTHENTICATED",
        "UNAUTHORIZED",
        "PASSWORD_CHANGE_REQUIRED",
        "ACCOUNT_INACTIVE",
      ].includes(error.code)
    )
      throw error;
    const stateChanged =
      error.code === "CONFLICT" || error.code === "PRECONDITION";
    const reason = stateChanged
      ? "stale_preview"
      : error.code === "CONFIG"
        ? error.details?.reason
        : "authority_changed";

    if (typeof reason !== "string") throw error;

    throw new MaisterError(
      error.code,
      stateChanged
        ? "Repository evidence changed before publication. Preserve the reported edits and create a fresh preview."
        : error.message,
      {
        cause: error,
        details: {
          reason,
          worktreeUpdateStarted: false,
        },
      },
    );
  }
}

/** Git locks HEAD and its branch before the safe index/worktree transition. */
export async function publishConfigCommit(
  snapshot: ConfigPersistSnapshot,
  sha: string,
  checks: {
    beforeWrite: () => Promise<"old" | "new">;
    beforePublish: () => Promise<void>;
  },
  fence: RepositoryFence,
): Promise<void> {
  const repo = snapshot.repository.repoPath;

  await verifyConfigCommit(snapshot, sha);
  let reserved = false;

  try {
    await executeGitConversation(
      repo,
      ["update-ref", "--stdin"],
      async (conversation) => {
        await conversation.command("start", "start: ok");
        conversation.write(
          snapshot.repository.head === null
            ? `create HEAD ${sha}`
            : `update HEAD ${sha} ${snapshot.repository.head}`,
        );
        await conversation.command("prepare", "prepare: ok");
        const observed = await reviewedPublicationState(
          snapshot,
          checks.beforeWrite,
        );

        if (observed === "old")
          await git(repo, [
            "read-tree",
            "-m",
            "-u",
            snapshot.repository.head ?? EMPTY_TREE,
            sha,
          ]);
        await fence.reserveIndex();
        reserved = true;
        await fence.assertIndexReservation();
        await checks.beforePublish();
        await assertReservedPublicationSeam(snapshot, sha);
        await conversation.command("commit", "commit: ok");
      },
    );
  } finally {
    if (reserved) await fence.releaseIndex();
  }
  if (
    (
      await git(repo, ["rev-parse", `refs/heads/${snapshot.repository.branch}`])
    ).trim() !== sha
  )
    throw new MaisterError(
      "CONFLICT",
      "Publication requires receipt recovery; preserve the repository state.",
      { details: { reason: "recovery_required" } },
    );
  log.info(
    { sha, branch: snapshot.repository.branch },
    "configuration commit published",
  );
}
