import "server-only";

import { access, chmod, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import pino from "pino";

import { atomicWriteText } from "@/lib/atomic";
import { ensureWorktreeGitExclude } from "@/lib/capabilities/materialize";
import { MaisterError } from "@/lib/errors";
import {
  composeCommitMessage,
  type MaisterProvenance,
  MaisterProvenanceError,
} from "@/lib/worktree-provenance-core";

export type { MaisterProvenance } from "@/lib/worktree-provenance-core";

const execFileAsync = promisify(execFile);

const log = pino({
  name: "worktree-provenance",
  level: process.env.LOG_LEVEL ?? "info",
});

const GIT_TIMEOUT_MS = 60_000;

type ManagedPaths = {
  directory: string;
  metadata: string;
  template: string;
  hook: string;
  currentNode: string;
};

function managedPaths(worktreePath: string): ManagedPaths {
  const directory = path.join(worktreePath, ".maister-managed");

  return {
    directory,
    metadata: path.join(directory, "provenance"),
    template: path.join(directory, "commit-template"),
    hook: path.join(directory, "hooks", "prepare-commit-msg"),
    currentNode: path.join(directory, "current-node"),
  };
}

function metadataText(metadata: MaisterProvenance): string {
  const task = metadata.task ? `task=${metadata.task}\n` : "";
  const flow = metadata.flow ? `flow=${metadata.flow}\n` : "";

  return `runId=${metadata.runId}\n${task}${flow}`;
}

function templateText(metadata: MaisterProvenance): string {
  return composeCommitMessage("MAIster managed commit", metadata).replace(
    "MAIster managed commit\n\n",
    "",
  );
}

function hookText(): string {
  return `#!/bin/sh
set -eu

message_file="$1"
managed_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
metadata="$managed_dir/provenance"
node_file="$managed_dir/current-node"

if [ ! -r "$metadata" ]; then
  echo "MAIster provenance metadata is missing: $metadata" >&2
  exit 1
fi

run_id=""
task=""
flow=""
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    runId=*) run_id=\${line#runId=} ;;
    task=*) task=\${line#task=} ;;
    flow=*) flow=\${line#flow=} ;;
  esac
done < "$metadata"

if [ -z "$run_id" ]; then
  echo "MAIster provenance metadata has no runId" >&2
  exit 1
fi

append_trailer() {
  key="$1"
  expected="$2"
  found=0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "$key:"*)
        actual=\${line#"$key:"}
        case "$actual" in
          " "*) actual=\${actual#" "} ;;
          *)
            echo "malformed $key trailer" >&2
            exit 1
            ;;
        esac
        if [ "$found" -eq 1 ]; then
          echo "duplicate $key trailer" >&2
          exit 1
        fi
        if [ "$actual" != "$expected" ]; then
          echo "conflicting $key trailer" >&2
          exit 1
        fi
        found=1
        ;;
    esac
  done < "$message_file"

  if [ "$found" -eq 0 ]; then
    if grep -q '^Maister-' "$message_file"; then
      printf '%s: %s\\n' "$key" "$expected" >> "$message_file"
    else
      printf '\\n%s: %s\\n' "$key" "$expected" >> "$message_file"
    fi
  fi
}

reject_unexpected_trailer() {
  key="$1"
  if grep -q "^$key:" "$message_file"; then
    echo "unexpected $key trailer" >&2
    exit 1
  fi
}

append_trailer "Maister-Run-Id" "$run_id"
if [ -n "$task" ]; then
  append_trailer "Maister-Task" "$task"
else
  reject_unexpected_trailer "Maister-Task"
fi
if [ -n "$flow" ]; then
  append_trailer "Maister-Flow" "$flow"
else
  reject_unexpected_trailer "Maister-Flow"
fi
if [ -r "$node_file" ]; then
  node=$(cat "$node_file")
  if [ -n "$node" ]; then
    append_trailer "Maister-Node" "$node"
  else
    reject_unexpected_trailer "Maister-Node"
  fi
else
  reject_unexpected_trailer "Maister-Node"
fi
`;
}

async function runGit(
  worktreePath: string,
  args: readonly string[],
): Promise<void> {
  await execFileAsync("git", ["-C", worktreePath, ...args], {
    signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
  });
}

async function assertManagedFilesExcluded(worktreePath: string): Promise<void> {
  try {
    await execFileAsync(
      "git",
      ["-C", worktreePath, "check-ignore", "-q", ".maister-managed/provenance"],
      { signal: AbortSignal.timeout(GIT_TIMEOUT_MS) },
    );
  } catch (error) {
    throw new MaisterError(
      "CONFLICT",
      "managed worktree provenance files are not git-excluded",
      { cause: error instanceof Error ? error : undefined },
    );
  }
}

async function configureWorktreeProvenance(
  worktreePath: string,
  paths: ManagedPaths,
): Promise<void> {
  await ensureWorktreeGitExclude(worktreePath);
  await assertManagedFilesExcluded(worktreePath);
  await runGit(worktreePath, ["config", "extensions.worktreeConfig", "true"]);
  await runGit(worktreePath, [
    "config",
    "--worktree",
    "core.hooksPath",
    path.dirname(paths.hook),
  ]);
  await runGit(worktreePath, [
    "config",
    "--worktree",
    "commit.template",
    paths.template,
  ]);
}

async function writeManagedHookAndTemplate(
  paths: ManagedPaths,
  metadata: MaisterProvenance,
): Promise<void> {
  await atomicWriteText(paths.template, templateText(metadata));
  await atomicWriteText(paths.hook, hookText());
  await chmod(paths.hook, 0o755);
}

export async function installWorktreeProvenance(args: {
  worktreePath: string;
  metadata: MaisterProvenance;
}): Promise<void> {
  const paths = managedPaths(args.worktreePath);

  try {
    await atomicWriteText(paths.metadata, metadataText(args.metadata));
    await writeManagedHookAndTemplate(paths, args.metadata);
    await atomicWriteText(paths.currentNode, "");
    await configureWorktreeProvenance(args.worktreePath, paths);

    log.info(
      { runId: args.metadata.runId, worktreePath: args.worktreePath },
      "installed managed worktree provenance",
    );
  } catch (error) {
    if (error instanceof MaisterProvenanceError) {
      throw new MaisterError("PRECONDITION", error.message, { cause: error });
    }

    throw new MaisterError(
      "CONFLICT",
      `failed to install worktree provenance: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error instanceof Error ? error : undefined },
    );
  }
}

export async function ensureWorktreeProvenance(args: {
  worktreePath: string;
  metadata: MaisterProvenance;
}): Promise<void> {
  const paths = managedPaths(args.worktreePath);

  try {
    const existing = await readWorktreeProvenanceMetadata(args.worktreePath);

    if (
      existing.runId !== args.metadata.runId ||
      existing.task !== args.metadata.task ||
      existing.flow !== args.metadata.flow
    ) {
      throw new MaisterError(
        "PRECONDITION",
        "managed worktree provenance conflicts with the delivery owner",
      );
    }

    await writeManagedHookAndTemplate(paths, existing);
    try {
      await readFile(paths.currentNode, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await atomicWriteText(paths.currentNode, "");
    }
    await configureWorktreeProvenance(args.worktreePath, paths);
    log.debug(
      { runId: existing.runId, worktreePath: args.worktreePath },
      "[FIX:provenance] verified managed worktree provenance",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await installWorktreeProvenance(args);

      return;
    }
    if (error instanceof MaisterError) throw error;

    throw new MaisterError(
      "CONFLICT",
      `failed to ensure worktree provenance: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error instanceof Error ? error : undefined },
    );
  }
}

/**
 * Distinguishes a legacy worktree from a broken managed worktree. Callers may
 * leave legacy trees untouched, but malformed managed provenance must fail
 * before it can produce an unattributed commit.
 */
export async function hasManagedWorktreeProvenance(
  worktreePath: string,
): Promise<boolean> {
  return (await readWorktreeProvenanceForPromotion(worktreePath)) !== null;
}

export async function readWorktreeProvenanceForPromotion(
  worktreePath: string,
): Promise<MaisterProvenance | null> {
  const paths = managedPaths(worktreePath);

  try {
    return await readWorktreeProvenanceMetadata(worktreePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;

    try {
      await access(paths.directory);
    } catch (directoryError) {
      if ((directoryError as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }

      throw new MaisterError(
        "PRECONDITION",
        "could not inspect managed provenance directory",
        {
          cause: directoryError instanceof Error ? directoryError : undefined,
        },
      );
    }

    throw new MaisterError(
      "PRECONDITION",
      "managed provenance metadata is missing",
      { cause: error instanceof Error ? error : undefined },
    );
  }
}

export async function setWorktreeProvenanceNode(args: {
  worktreePath: string;
  nodeId: string;
}): Promise<void> {
  const paths = managedPaths(args.worktreePath);

  try {
    composeCommitMessage("validate", {
      runId: "validation",
      node: args.nodeId,
    });
    await atomicWriteText(paths.currentNode, args.nodeId);
    log.debug(
      { worktreePath: args.worktreePath, nodeId: args.nodeId },
      "set provenance node",
    );
  } catch (error) {
    throw new MaisterError(
      "PRECONDITION",
      `invalid worktree provenance node: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error instanceof Error ? error : undefined },
    );
  }
}

export async function clearWorktreeProvenanceNode(
  worktreePath: string,
): Promise<void> {
  const paths = managedPaths(worktreePath);

  await atomicWriteText(paths.currentNode, "");
  log.debug({ worktreePath }, "cleared provenance node");
}

export async function readWorktreeProvenanceMetadata(
  worktreePath: string,
): Promise<MaisterProvenance> {
  const paths = managedPaths(worktreePath);
  const raw = await readFile(paths.metadata, "utf8");
  const values: Partial<Record<"runId" | "task" | "flow", string>> = {};

  for (const line of raw.split("\n").filter(Boolean)) {
    const separator = line.indexOf("=");
    const key = separator >= 0 ? line.slice(0, separator) : "";
    const value = separator >= 0 ? line.slice(separator + 1) : "";

    if ((key !== "runId" && key !== "task" && key !== "flow") || !value) {
      throw new MaisterError(
        "PRECONDITION",
        "managed provenance metadata has an invalid field",
      );
    }
    if (values[key] !== undefined) {
      throw new MaisterError(
        "PRECONDITION",
        `managed provenance metadata duplicates ${key}`,
      );
    }

    values[key] = value;
  }
  const runId = values.runId;

  if (!runId) {
    throw new MaisterError("PRECONDITION", "managed provenance has no runId");
  }

  const metadata = {
    runId,
    ...(values.task ? { task: values.task } : {}),
    ...(values.flow ? { flow: values.flow } : {}),
  };

  try {
    composeCommitMessage("validate", metadata);
  } catch (error) {
    throw new MaisterError(
      "PRECONDITION",
      `managed provenance metadata is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error instanceof Error ? error : undefined },
    );
  }

  return metadata;
}
