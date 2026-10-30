import "server-only";

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { open, realpath, stat } from "node:fs/promises";

import { git } from "./git";

import { MaisterError } from "@/lib/errors";
import { contentDigest } from "@/lib/evaluations/digest";

const POLICY_HOOKS = [
  "pre-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "post-checkout",
  "reference-transaction",
  "pre-push",
] as const;

async function hookDigest(path: string): Promise<string> {
  const handle = await open(path, "r");

  try {
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    let consumed = 0;

    while (consumed < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        consumed,
        buffer.length - consumed,
        consumed,
      );

      if (bytesRead === 0) break;
      consumed += bytesRead;
    }
    if (consumed > 1024 * 1024)
      throw new MaisterError(
        "PRECONDITION",
        "Git hook policy exceeds the supported review size.",
        { details: { reason: "unsupported_checkout" } },
      );

    return createHash("sha256")
      .update(buffer.subarray(0, consumed))
      .digest("hex");
  } finally {
    await handle.close();
  }
}

export type RepositoryHook = {
  path: string;
  digest: string | null;
  executable: boolean;
};

/** Resolve each hook independently; a linked hook never changes the directory of other hooks. */
export async function readRepositoryHook(
  repo: string,
  name: (typeof POLICY_HOOKS)[number],
): Promise<RepositoryHook> {
  const path = resolve(
    repo,
    (await git(repo, ["rev-parse", "--git-path", `hooks/${name}`])).trim(),
  );

  try {
    const canonical = await realpath(path);
    const info = await stat(canonical);

    if (!info.isFile() || info.size > 1024 * 1024)
      throw new MaisterError(
        "PRECONDITION",
        "A Git hook has unsupported type or size; inspect repository policy before saving configuration.",
        { details: { reason: "unsupported_checkout" } },
      );

    return {
      path: canonical,
      digest: await hookDigest(canonical),
      executable: (info.mode & 0o111) !== 0,
    };
  } catch (error) {
    if (
      !["ENOENT", "ENOTDIR"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      throw error;

    return { path, digest: null, executable: false };
  }
}

export async function repositoryPolicyDigest(
  repo: string,
  authorName: string,
  authorEmail: string,
  configuration: string,
): Promise<string> {
  for (const key of [
    "GIT_DIR",
    "GIT_COMMON_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
  ]) {
    if (process.env[key])
      throw new MaisterError(
        "PRECONDITION",
        "Repository-overriding Git environment variables are unsupported for reviewed configuration persistence. Remove the override from the web service and create a fresh preview.",
        { details: { reason: "unsupported_checkout" } },
      );
  }
  const identityOptions = [
    "-c",
    `user.name=${authorName}`,
    "-c",
    `user.email=${authorEmail}`,
  ];
  const identities: string[] = [];

  for (const key of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]) {
    const value = (await git(repo, [...identityOptions, "var", key])).trimEnd();
    const match = /^(.*) [0-9]+ [+-][0-9]{4}$/u.exec(value);

    if (!match)
      throw new MaisterError(
        "PRECONDITION",
        "Git author or committer identity is invalid; correct the service identity before reviewing a commit.",
        { details: { reason: "unsupported_checkout" } },
      );
    identities.push(match[1]!);
  }
  const hooks: Array<{
    name: string;
    path: string;
    digest: string | null;
    executable: boolean;
  }> = [];

  for (const name of POLICY_HOOKS)
    hooks.push({ name, ...(await readRepositoryHook(repo, name)) });

  return contentDigest({
    configuration,
    identities,
    hooks,
    authorDate: process.env.GIT_AUTHOR_DATE ?? null,
    committerDate: process.env.GIT_COMMITTER_DATE ?? null,
  });
}
