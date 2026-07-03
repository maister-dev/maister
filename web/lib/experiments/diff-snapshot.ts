import "server-only";

import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";
import pino from "pino";

import * as schemaModule from "@/lib/db/schema";
import type { ExperimentDiffFileSummary } from "@/lib/experiments/types";
import { diffRunWorkspace } from "@/lib/worktree";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { experimentRuns, projects, workspaces } =
  schemaModule as unknown as Record<string, any>;

// FIXME(any): pg|sqlite drizzle union.
type Db = any;

export const EXPERIMENT_DIFF_SNAPSHOT_MAX_BYTES = 512 * 1024;

const log = pino({
  name: "experiments-diff-snapshot",
  level: process.env.LOG_LEVEL ?? "info",
});

export type DiffSnapshotCaptureResult =
  | { status: "not-member"; runId: string }
  | { status: "skipped"; runId: string; reason: "already-captured" }
  | {
      status: "captured";
      runId: string;
      experimentId: string;
      bytes: number;
      truncated: boolean;
      fileCount: number;
    }
  | { status: "failed"; runId: string; message: string };

type ParsedDiffSection = {
  section: string;
  path: string;
  status: string;
  additions: number;
  deletions: number;
};

function splitDiffSections(rawDiff: string): string[] {
  const trimmed = rawDiff.replace(/^\s+/, "").replace(/\n+$/, "");

  if (trimmed.length === 0) return [];

  return trimmed
    .split(/\n(?=diff --git )/)
    .filter((section) => section.startsWith("diff --git"));
}

function repoRelPath(path: string): string {
  if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2);

  return path;
}

function parsePath(headerLine: string): string {
  const match = headerLine.match(/ b\/(.+)$/);

  if (match) return match[1];

  const tokens = headerLine.split(" ");

  return repoRelPath(tokens[tokens.length - 1] ?? "");
}

function deriveStatus(section: string): string {
  if (/^new file mode /m.test(section)) return "A";
  if (/^deleted file mode /m.test(section)) return "D";
  if (/^rename (from|to) /m.test(section)) return "R";
  if (/^copy (from|to) /m.test(section)) return "C";

  return "M";
}

function countChanges(section: string): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;

  for (const line of section.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }

  return { additions, deletions };
}

function parseDiffSection(section: string): ParsedDiffSection {
  const headerLine = section.split("\n", 1)[0];
  const { additions, deletions } = countChanges(section);

  return {
    section,
    path: parsePath(headerLine),
    status: deriveStatus(section),
    additions,
    deletions,
  };
}

function patchHash(section: string): string {
  return createHash("sha256").update(section).digest("hex");
}

export function summarizeDiffFilesWithPatchHashes(
  rawDiff: string,
): ExperimentDiffFileSummary[] {
  return splitDiffSections(rawDiff).map((section) => {
    const parsed = parseDiffSection(section);

    return {
      path: parsed.path,
      status: parsed.status,
      additions: parsed.additions,
      deletions: parsed.deletions,
      patchHash: patchHash(parsed.section),
    };
  });
}

export function capExperimentDiffSnapshot(
  rawDiff: string,
  args: { maxBytes?: number; alreadyTruncated: boolean },
): { text: string; bytes: number; truncated: boolean } {
  const maxBytes = args.maxBytes ?? EXPERIMENT_DIFF_SNAPSHOT_MAX_BYTES;
  const bytes = Buffer.byteLength(rawDiff, "utf8");

  if (bytes <= maxBytes) {
    return {
      text: rawDiff,
      bytes,
      truncated: args.alreadyTruncated,
    };
  }

  return {
    text: Buffer.from(rawDiff, "utf8").subarray(0, maxBytes).toString("utf8"),
    bytes,
    truncated: true,
  };
}

export async function captureExperimentDiffSnapshotForRun(args: {
  db: Db;
  runId: string;
  force?: boolean;
}): Promise<DiffSnapshotCaptureResult> {
  try {
    const memberRows = await args.db
      .select()
      .from(experimentRuns)
      .where(eq(experimentRuns.runId, args.runId));
    const member = memberRows.find(
      (row: Record<string, unknown>) => row.runId === args.runId,
    );

    if (!member) return { status: "not-member", runId: args.runId };
    if (!args.force && member.diffSnapshotCapturedAt) {
      return {
        status: "skipped",
        runId: args.runId,
        reason: "already-captured",
      };
    }

    const workspaceRows = await args.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.runId, args.runId));
    const workspace = workspaceRows.find(
      (row: Record<string, unknown>) => row.runId === args.runId,
    );

    if (!workspace || workspace.removedAt) {
      throw new Error(`workspace unavailable for run ${args.runId}`);
    }

    const projectRows = await args.db
      .select()
      .from(projects)
      .where(eq(projects.id, workspace.projectId));
    const project = projectRows.find(
      (row: Record<string, unknown>) => row.id === workspace.projectId,
    );

    if (!project) {
      throw new Error(`project not found for run ${args.runId}`);
    }

    const diff = await diffRunWorkspace({
      projectRepoPath: String(project.repoPath),
      baseCommit: String(member.baseCommit),
      branch: String(workspace.branch),
    });
    const files = summarizeDiffFilesWithPatchHashes(diff.text);
    const snapshot = capExperimentDiffSnapshot(diff.text, {
      alreadyTruncated: diff.truncated,
    });
    const capturedAt = new Date();

    await args.db
      .update(experimentRuns)
      .set({
        diffSnapshot: snapshot.text,
        diffSnapshotTruncated: snapshot.truncated,
        diffSnapshotBytes: snapshot.bytes,
        diffSnapshotCapturedAt: capturedAt,
        diffFilesSummary: files,
        updatedAt: capturedAt,
      })
      .where(eq(experimentRuns.runId, args.runId));

    log.info(
      {
        experimentId: member.experimentId,
        runId: args.runId,
        bytes: snapshot.bytes,
        truncated: snapshot.truncated,
        fileCount: files.length,
      },
      "experiment diff snapshot captured",
    );

    return {
      status: "captured",
      runId: args.runId,
      experimentId: String(member.experimentId),
      bytes: snapshot.bytes,
      truncated: snapshot.truncated,
      fileCount: files.length,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    log.warn(
      { runId: args.runId, err: message },
      "experiment diff snapshot capture failed",
    );

    return { status: "failed", runId: args.runId, message };
  }
}
