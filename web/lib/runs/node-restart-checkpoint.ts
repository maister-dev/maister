import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { FlowDriverClaim } from "@/lib/flows/graph/driver-claim";
import type {
  NodeRestartCheckpoint,
  NodeRestartPreview,
} from "@/lib/runs/node-restart-types";

import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";

import { and, eq, isNotNull, isNull } from "drizzle-orm";

import {
  flowNodeRestartCheckpoints,
  nodeAttempts,
  runs,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { FlowDriverClaimLost } from "@/lib/flows/graph/driver-claim";
import {
  captureWorkspaceTree,
  checkpointRefName,
  containmentAssert,
  restoreNodeCheckpoint,
} from "@/lib/flows/graph/workspace-checkpoint";
import { git, gitResult } from "@/lib/project-config-persistence/git";
import { withRepositoryMutationFence } from "@/lib/project-config-persistence/repository-lock";
import { loadFailedNodeRestartTarget } from "@/lib/runs/failed-node-restart";
import { writeRescueRef } from "@/lib/worktree";

type Worktree = Readonly<{ worktreePath: string; branch: string }>;
const PREVIEW_FILES = 12;

function checkpointUnavailable(): MaisterError {
  return new MaisterError(
    "CHECKPOINT",
    "The selected attempt has no available checkpoint",
    {
      details: { reason: "restart_checkpoint_unavailable" },
    },
  );
}

async function resolveCheckpoint(
  worktreePath: string,
  runId: string,
  attemptId: string,
  checkpointRef: string | null,
) {
  if (checkpointRef !== checkpointRefName("checkpoints", runId, attemptId))
    throw checkpointUnavailable();
  const result = await gitResult(worktreePath, [
    "rev-parse",
    "--verify",
    `${checkpointRef}^{commit}`,
  ]);

  if (result.code !== 0) throw checkpointUnavailable();
  const sha = result.stdout.trim();
  const [head, tree] = await Promise.all([
    git(worktreePath, ["rev-parse", `${sha}^`]),
    git(worktreePath, ["rev-parse", `${sha}^{tree}`]),
  ]);

  return { sha, head: head.trim(), tree: tree.trim() };
}

async function inspectWorktree(worktree: Worktree) {
  const { worktreePath, branch } = worktree;
  const [root, headRef, head, index] = await Promise.all([
    git(worktreePath, ["rev-parse", "--show-toplevel"]),
    gitResult(worktreePath, ["symbolic-ref", "--quiet", "HEAD"]),
    git(worktreePath, ["rev-parse", "HEAD"]),
    git(worktreePath, ["ls-files", "--stage", "-z"]),
  ]);

  if (
    (await realpath(root.trim())) !== (await realpath(worktreePath)) ||
    headRef.stdout.trim() !== `refs/heads/${branch}`
  )
    throw worktreeChanged();
  const tree = await captureWorkspaceTree(worktreePath);

  return { head: head.trim(), tree, index };
}

function checkpointPreviewToken(input: {
  runId: string;
  attemptId: string;
  checkpointSha: string;
  state: Awaited<ReturnType<typeof inspectWorktree>>;
}): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export async function loadNodeRestartCheckpointPreview(
  db: Db,
  runId: string,
  attemptId: string,
): Promise<{ checkpointSha: string; preview: NodeRestartPreview }> {
  const target = await loadFailedNodeRestartTarget(db, runId);

  if (!target || target.id !== attemptId)
    throw new MaisterError(
      "CONFLICT",
      "The failed attempt is no longer eligible for restart",
    );
  if (!target.checkpointRef) throw checkpointUnavailable();
  containmentAssert(target.worktreePath);
  const checkpoint = await resolveCheckpoint(
    target.worktreePath,
    runId,
    attemptId,
    target.checkpointRef,
  );

  await assertIgnoredFilesAreSafe(target.worktreePath, checkpoint);
  const state = await inspectWorktree(target);
  const token = checkpointPreviewToken({
    runId,
    attemptId,
    checkpointSha: checkpoint.sha,
    state,
  });
  const diff = await git(target.worktreePath, [
    "diff",
    "--name-status",
    "--no-renames",
    "-z",
    state.tree,
    checkpoint.tree,
    "--",
  ]);
  const entries = diff.split("\0").slice(0, -1);
  const files = Array.from(
    { length: Math.min(entries.length / 2, PREVIEW_FILES) },
    (_, index) => ({
      path: entries[index * 2 + 1],
      removed: entries[index * 2] === "D",
    }),
  );

  return {
    checkpointSha: checkpoint.sha,
    preview: {
      token,
      files,
      fileCount: entries.length / 2,
      rewindsCommits: state.head !== checkpoint.head,
    },
  };
}

function worktreeChanged(): MaisterError {
  return new MaisterError(
    "CHECKPOINT",
    "The worktree changed after the checkpoint preview. Review its current changes before restarting.",
    {
      details: { reason: "restart_checkpoint_workspace_changed" },
    },
  );
}

async function assertIgnoredFilesAreSafe(
  worktreePath: string,
  checkpoint: { head: string; tree: string },
): Promise<void> {
  const [ignored, baseline, target] = await Promise.all([
    git(worktreePath, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
    ]),
    git(worktreePath, ["ls-tree", "-r", "--name-only", "-z", checkpoint.head]),
    git(worktreePath, ["ls-tree", "-r", "--name-only", "-z", checkpoint.tree]),
  ]);
  const ignoredPaths = ignored
    .split("\0")
    .filter(Boolean)
    .map((path) => path.replace(/\/$/, ""));
  const files = new Set(ignoredPaths);
  const parents = new Set<string>();

  for (const path of ignoredPaths) {
    for (
      let end = path.indexOf("/");
      end >= 0;
      end = path.indexOf("/", end + 1)
    )
      parents.add(path.slice(0, end));
  }
  for (const path of `${baseline}${target}`.split("\0").filter(Boolean)) {
    let blocked = files.has(path) || parents.has(path);

    for (
      let end = path.indexOf("/");
      !blocked && end >= 0;
      end = path.indexOf("/", end + 1)
    )
      blocked = files.has(path.slice(0, end));
    if (blocked)
      throw new MaisterError(
        "CHECKPOINT",
        "Restoring the checkpoint would overwrite ignored files",
        {
          details: { reason: "restart_checkpoint_ignored_files" },
        },
      );
  }
}

export async function applyNodeRestartCheckpoint(input: {
  db: Db;
  claim: FlowDriverClaim;
  nodeId: string;
  worktree: Worktree;
  intent: NodeRestartCheckpoint;
}): Promise<void> {
  const { db, claim, nodeId, worktree, intent } = input;
  const { runId } = claim;
  if (claim.scope !== "assignment") throw new FlowDriverClaimLost(claim);
  const assertPending = async (): Promise<void> => {
    const [current] = await db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.id, runId),
          eq(runs.executionAssignmentId, claim.assignmentId),
          eq(runs.status, "Running"),
          eq(runs.currentStepId, nodeId),
          isNotNull(runs.resumeStartedAt),
        ),
      );

    if (!current) throw new FlowDriverClaimLost(claim);
  };
  const { worktreePath } = worktree;

  await withRepositoryMutationFence(worktreePath, async () => {
    await assertPending();
    const [attempt] = await db
      .select({ checkpointRef: nodeAttempts.checkpointRef })
      .from(nodeAttempts)
      .where(
        and(
          eq(nodeAttempts.id, intent.attemptId),
          eq(nodeAttempts.runId, runId),
          eq(nodeAttempts.nodeId, nodeId),
          eq(nodeAttempts.status, "Failed"),
        ),
      );
    const checkpoint = await resolveCheckpoint(
      worktreePath,
      runId,
      intent.attemptId,
      attempt?.checkpointRef ?? null,
    );

    if (checkpoint.sha !== intent.checkpointSha) throw checkpointUnavailable();
    const state = await inspectWorktree(worktree);
    if (intent.rescueRef)
      await git(worktreePath, [
        "rev-parse",
        "--verify",
        `${intent.rescueRef}^{commit}`,
      ]);
    if (
      intent.rescueRef &&
      state.head === checkpoint.head &&
      state.tree === checkpoint.tree &&
      (
        await gitResult(worktreePath, [
          "diff-index",
          "--cached",
          "--quiet",
          "HEAD",
          "--",
        ])
      ).code === 0
    )
      return;

    const inspectToken = (snapshot: typeof state) =>
      checkpointPreviewToken({
        runId,
        attemptId: intent.attemptId,
        checkpointSha: checkpoint.sha,
        state: snapshot,
      });
    if (inspectToken(state) !== intent.previewToken) throw worktreeChanged();

    if (!intent.rescueRef) {
      const rescue = await writeRescueRef({ worktreePath, runId });
      const [tree, head] = (
        await git(worktreePath, [
          "rev-parse",
          `${rescue.sha}^{tree}`,
          `${rescue.sha}^1`,
        ])
      )
        .trim()
        .split("\n");

      if (tree !== state.tree || head !== state.head) throw worktreeChanged();
      const [saved] = await db
        .update(flowNodeRestartCheckpoints)
        .set({ rescueRef: rescue.ref })
        .where(
          and(
            eq(flowNodeRestartCheckpoints.assignmentId, claim.assignmentId),
            isNull(flowNodeRestartCheckpoints.rescueRef),
          ),
        )
        .returning({ assignmentId: flowNodeRestartCheckpoints.assignmentId });

      if (!saved) throw new FlowDriverClaimLost(claim);
    }
    if (inspectToken(await inspectWorktree(worktree)) !== intent.previewToken)
      throw worktreeChanged();
    await assertIgnoredFilesAreSafe(worktreePath, checkpoint);
    await restoreNodeCheckpoint(worktreePath, checkpoint.sha, assertPending);
    const restored = await inspectWorktree(worktree);

    if (
      restored.head !== checkpoint.head ||
      restored.tree !== checkpoint.tree ||
      (
        await gitResult(worktreePath, [
          "diff-index",
          "--cached",
          "--quiet",
          "HEAD",
          "--",
        ])
      ).code !== 0
    )
      throw new MaisterError(
        "CHECKPOINT",
        "The worktree could not be fully restored. The rescue snapshot is retained.",
        {
          details: { reason: "restart_checkpoint_restore_incomplete" },
        },
      );
  });
}
