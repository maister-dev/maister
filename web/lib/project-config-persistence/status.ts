import "server-only";

import type { ConfigRepositorySnapshot } from "./types";
import type { ConfigPersistReason, ConfigStatus } from "./contracts";
import type { PersistenceDb } from "./store";

import { lstat, readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { git, gitResult } from "./git";
import { commonGitDirectory } from "./repository-lock";
import { manifestMatches } from "./manifest";
import {
  readExportSnapshot,
  assertExportablePackages,
  type ExportSnapshot,
} from "./projection";

import { MaisterError } from "@/lib/errors";
import { sha256 } from "@/lib/evaluations/digest";

type ProjectRepository = Pick<
  ExportSnapshot["project"],
  "repoPath" | "mainBranch"
>;
export type RepositoryObservation = {
  repository: ConfigRepositorySnapshot;
  source: string | null;
  blocker?: ConfigPersistReason;
};

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);

    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function optionalConfig(
  repo: string,
  key: string,
): Promise<string | null> {
  const result = await gitResult(repo, ["config", "--get", key]);

  if (result.code === 1) return null;
  if (result.code !== 0)
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "Git configuration is unreadable.",
      { details: { reason: "repository_unavailable" } },
    );

  return result.stdout.trim() || null;
}

export async function inspectRepository(
  project: ProjectRepository,
): Promise<RepositoryObservation> {
  const repo = await realpath(project.repoPath);
  const top = (await git(repo, ["rev-parse", "--show-toplevel"])).trim();
  const commonDirectory = await commonGitDirectory(repo);
  const branchResult = await gitResult(repo, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);

  if (branchResult.code !== 0 && branchResult.code !== 1)
    throw new MaisterError("EXECUTOR_UNAVAILABLE", "Cannot inspect HEAD.", {
      details: { reason: "repository_unavailable" },
    });
  const branch = branchResult.code === 0 ? branchResult.stdout.trim() : "";
  const headResult = await gitResult(repo, [
    "rev-parse",
    "--verify",
    "--quiet",
    "HEAD",
  ]);

  if (headResult.code !== 0 && headResult.code !== 1)
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "Cannot inspect repository history.",
      { details: { reason: "repository_unavailable" } },
    );
  const head = headResult.code === 0 ? headResult.stdout.trim() : null;
  const [indexEntries, status, authorName, authorEmail, config, format] =
    await Promise.all([
      git(repo, ["ls-files", "--stage", "-v", "-z"]),
      git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      optionalConfig(repo, "user.name"),
      optionalConfig(repo, "user.email"),
      git(repo, ["config", "--null", "--list", "--show-origin"]),
      git(repo, ["rev-parse", "--show-object-format"]),
    ]);
  let blocker: ConfigPersistReason | undefined;

  if ((await realpath(top)) !== repo || format.trim() !== "sha1")
    blocker = "unsupported_checkout";
  if (!branch) blocker = "detached_head";
  else if (branch !== project.mainBranch) blocker = "wrong_branch";
  if (status) blocker ??= "dirty_checkout";
  if (
    indexEntries.split("\0").some((entry) => entry && !entry.startsWith("H "))
  )
    blocker = "unsupported_checkout";
  for (const key of [
    "core.sparseCheckout",
    "core.splitIndex",
    "core.autocrlf",
  ]) {
    const value = await optionalConfig(repo, key);

    if (value && value !== "false" && value !== "input")
      blocker = "unsupported_checkout";
  }
  const attributes = await git(repo, [
    "check-attr",
    "-z",
    "filter",
    "working-tree-encoding",
    "eol",
    "--",
    "maister.yaml",
  ]);
  const fields = attributes.split("\0");

  for (let index = 2; index < fields.length; index += 3) {
    if (fields[index] !== "unspecified" && fields[index] !== "unset")
      blocker = "unsupported_checkout";
  }
  for (const name of [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-merge",
    "rebase-apply",
    "BISECT_LOG",
    "sequencer",
    "index.lock",
    "HEAD.lock",
  ]) {
    const path = (await git(repo, ["rev-parse", "--git-path", name])).trim();

    if (await exists(resolve(repo, path))) blocker = "operation_in_progress";
  }

  const baseline = await gitResult(repo, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${project.mainBranch}`,
  ]);

  if (baseline.code !== 0 && baseline.code !== 1)
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "Cannot inspect target branch.",
      { details: { reason: "repository_unavailable" } },
    );
  const entry =
    baseline.code === 0
      ? (
          await git(repo, [
            "ls-tree",
            baseline.stdout.trim(),
            "--",
            "maister.yaml",
          ])
        ).trim()
      : "";
  const mode = entry ? entry.split(" ")[0]! : null;

  if (mode !== null && mode !== "100644" && mode !== "100755")
    blocker = "unsupported_checkout";
  const source =
    entry && (mode === "100644" || mode === "100755")
      ? await git(repo, ["show", `${baseline.stdout.trim()}:maister.yaml`])
      : null;
  const target = resolve(repo, "maister.yaml");

  if (await exists(target)) {
    const info = await lstat(target);

    if (!info.isFile()) blocker = "unsupported_checkout";
    else if (
      source === null ||
      sha256(await readFile(target, "utf8")) !== sha256(source)
    )
      blocker ??= "dirty_checkout";
  } else if (source !== null) blocker ??= "dirty_checkout";

  return {
    source,
    ...(blocker ? { blocker } : {}),
    repository: {
      repoPath: repo,
      commonDirectory,
      branch,
      head,
      manifestDigest: source === null ? null : sha256(source),
      manifestMode: mode,
      indexEntries,
      status,
      authorName: authorName ?? "maister",
      authorEmail: authorEmail ?? "noreply@maister.local",
      usedDefaultAuthor: !authorName || !authorEmail,
      configDigest: sha256(config),
    },
  };
}

export function assertRepositoryReady(
  observation: RepositoryObservation,
): void {
  if (observation.blocker)
    throw new MaisterError(
      "PRECONDITION",
      "Repository requires attention before saving. Resolve the reported blocker and create a fresh preview.",
      { details: { reason: observation.blocker } },
    );
}

function repositoryStateForReason(
  reason: ConfigPersistReason | undefined,
): ConfigStatus["repositoryState"] {
  switch (reason) {
    case "wrong_branch":
      return "wrong_branch";
    case "detached_head":
      return "detached";
    case "dirty_checkout":
      return "dirty";
    case "operation_in_progress":
    case "operation_busy":
      return "operation_in_progress";
    case "unsupported_checkout":
      return "unavailable";
    default:
      return "ready";
  }
}

export async function currentConfigStatus(
  db: PersistenceDb,
  projectId: string,
): Promise<ConfigStatus> {
  const snapshot = await readExportSnapshot(db, projectId);
  let repositoryState: ConfigStatus["repositoryState"] = "unavailable";

  try {
    const observed = await inspectRepository(snapshot.project);

    repositoryState = repositoryStateForReason(observed.blocker);
    let exportState: ConfigStatus["exportState"] =
      observed.source === null
        ? "missing"
        : manifestMatches(observed.source, snapshot.projection)
          ? "in_sync"
          : "pending";
    let reason = observed.blocker;

    try {
      await assertExportablePackages(snapshot.projection);
    } catch (error) {
      if (!(error instanceof MaisterError) || error.code !== "CONFIG")
        throw error;
      reason = error.details?.reason as ConfigPersistReason;
      exportState = "blocked";
    }
    if (
      await exists(
        resolve(
          observed.repository.commonDirectory,
          "maister-config-mutation.lock",
        ),
      )
    ) {
      reason = "operation_busy";
      repositoryState = "operation_in_progress";
    }

    return {
      exportState,
      exportRevision: snapshot.exportRevision,
      observedAt: new Date().toISOString(),
      repositoryState,
      ...(reason ? { reason } : {}),
    };
  } catch (error) {
    if (error instanceof MaisterError && error.code === "CONFIG") {
      return {
        exportState: "blocked",
        repositoryState,
        observedAt: new Date().toISOString(),
        exportRevision: snapshot.exportRevision,
        reason: "manifest_invalid",
      };
    }
    if (error instanceof MaisterError) throw error;
    if ((error as NodeJS.ErrnoException).code) {
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        "Repository evidence is unavailable. Check host access and retry the observation.",
        {
          cause: error instanceof Error ? error : undefined,
          details: { reason: "repository_unavailable" },
        },
      );
    }
    throw error;
  }
}
