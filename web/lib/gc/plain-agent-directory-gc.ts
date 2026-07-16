import "server-only";

import { lstat, realpath, rm } from "node:fs/promises";
import path from "node:path";

import { and, asc, eq, inArray } from "drizzle-orm";
import pino from "pino";

import { restoreAgentMaterialization } from "@/lib/agents/dirty-watchdog";
import { getDb } from "@/lib/db/client";
import { projects, runs } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { worktreesRoot } from "@/lib/instance-config";

const log = pino({
  name: "gc-plain-agent-directory",
  level: process.env.LOG_LEVEL ?? "info",
});

const PLAIN_AGENT_DIRECTORY_TERMINAL_STATUSES = [
  "Done",
  "Failed",
  "Abandoned",
  "Crashed",
] as const;
const PLAIN_AGENT_DIRECTORY_BATCH_SIZE = 100;

export type PlainAgentDirectoryCandidate = {
  runId: string;
  projectSlug: string;
  status: (typeof PLAIN_AGENT_DIRECTORY_TERMINAL_STATUSES)[number];
};

export type PlainAgentDirectoryGcSummary = {
  scanned: number;
  removed: number;
  missing: number;
  failed: number;
};

export type PlainAgentDirectoryGcOptions = {
  candidates?: readonly PlainAgentDirectoryCandidate[];
  restoreMaterialization?: (cwd: string, runId: string) => Promise<void>;
  removeDirectory?: (args: {
    root: string;
    directoryPath: string;
  }) => Promise<boolean>;
};

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isContainedPath(root: string, target: string): boolean {
  const relative = path.relative(root, target);

  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".."
  );
}

export async function removeOwnedPlainAgentDirectory(args: {
  root: string;
  directoryPath: string;
}): Promise<boolean> {
  let resolvedRoot: string;

  try {
    resolvedRoot = await realpath(args.root);
  } catch (error) {
    if (isMissingPathError(error)) return false;

    throw error;
  }

  let targetStat: Awaited<ReturnType<typeof lstat>>;

  try {
    targetStat = await lstat(args.directoryPath);
  } catch (error) {
    if (isMissingPathError(error)) return false;

    throw error;
  }

  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    throw new MaisterError(
      "PRECONDITION",
      "plain agent cleanup target must be a non-symlink directory",
    );
  }

  const resolvedTarget = await realpath(args.directoryPath);

  if (!isContainedPath(resolvedRoot, resolvedTarget)) {
    throw new MaisterError(
      "PRECONDITION",
      "plain agent cleanup target escapes the managed worktrees root",
    );
  }

  const pathSegments = path.relative(resolvedRoot, resolvedTarget).split(path.sep);

  if (pathSegments.length !== 2) {
    throw new MaisterError(
      "PRECONDITION",
      "plain agent cleanup target is not a direct run directory",
    );
  }

  await rm(resolvedTarget, { recursive: true, force: true });

  return true;
}

async function loadPlainAgentDirectoryCandidates(): Promise<
  PlainAgentDirectoryCandidate[]
> {
  const rows = await getDb()
    .select({
      runId: runs.id,
      projectSlug: projects.slug,
      status: runs.status,
    })
    .from(runs)
    .innerJoin(projects, eq(projects.id, runs.projectId))
    .where(
      and(
        eq(runs.runKind, "agent"),
        eq(runs.agentWorkspace, "none"),
        inArray(runs.status, [...PLAIN_AGENT_DIRECTORY_TERMINAL_STATUSES]),
      ),
    )
    .orderBy(asc(runs.endedAt), asc(runs.id))
    .limit(PLAIN_AGENT_DIRECTORY_BATCH_SIZE);

  return rows as PlainAgentDirectoryCandidate[];
}

export async function runPlainAgentDirectoryGcSweep(
  options: PlainAgentDirectoryGcOptions = {},
): Promise<PlainAgentDirectoryGcSummary> {
  const candidates =
    options.candidates === undefined
      ? await loadPlainAgentDirectoryCandidates()
      : [...options.candidates];
  const root = worktreesRoot();
  const restore = options.restoreMaterialization ?? restoreAgentMaterialization;
  const remove = options.removeDirectory ?? removeOwnedPlainAgentDirectory;
  let removed = 0;
  let missing = 0;
  let failed = 0;

  for (const candidate of candidates) {
    const directoryPath = path.join(root, candidate.projectSlug, candidate.runId);

    try {
      await restore(directoryPath, candidate.runId);
      const didRemove = await remove({ root, directoryPath });

      if (didRemove) {
        removed += 1;
        log.info(
          { runId: candidate.runId, status: candidate.status },
          "plain agent directory reaped after materialization restoration",
        );
      } else {
        missing += 1;
      }
    } catch (error) {
      failed += 1;
      log.warn(
        {
          runId: candidate.runId,
          status: candidate.status,
          errorType: error instanceof Error ? error.name : "unknown",
        },
        "plain agent directory cleanup failed and will retry",
      );
    }
  }

  const summary = { scanned: candidates.length, removed, missing, failed };

  log.info(summary, "plain agent directory cleanup sweep completed");

  return summary;
}
