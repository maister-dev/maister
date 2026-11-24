import "server-only";

import type { Db } from "./db";
import type { workspaces } from "@/lib/db/schema";
import type {
  WorkspaceDiffQuery,
  WorkspaceInputObject,
  WorkspaceGitReview,
  WorkspaceLogPage,
  WorkspaceLogQuery,
} from "../../../runtime/workspace-prepare";

import { z } from "zod";

import { GIT_OBJECT_ID } from "../../../runtime/wait-head";
import {
  WORKSPACE_LOG_MAX_BYTES,
  WORKSPACE_GIT_CHECKPOINT_PREFIX,
  WORKSPACE_LOG_MAX_PAGE_SIZE,
  WORKSPACE_LOG_OBJECT_NAME,
  WORKSPACE_REVIEW_MAX_BYTES,
  WORKSPACE_REVIEW_OBJECT_NAME,
} from "../../../runtime/workspace-prepare";

import { runEventWakeBus } from "./events/run-wake";
import {
  getRuntimeObjectForRun,
  readRuntimeObjectContent,
} from "./runtime-objects";
import {
  readAddressedWorkspaceDiff,
  readAddressedWorkspaceLog,
} from "./workspace-preparation";

import { MaisterError } from "@/lib/errors";

type WorkspaceReview = Readonly<{
  db: Db;
  workspace: typeof workspaces.$inferSelect;
  signal: AbortSignal;
}>;

const logPage = z
  .object({
    head: z.string().regex(GIT_OBJECT_ID),
    commits: z
      .array(
        z
          .object({
            commit: z.string().regex(GIT_OBJECT_ID),
            committedAt: z.string().datetime({ offset: true }),
            subject: z.string(),
          })
          .strict(),
      )
      .max(WORKSPACE_LOG_MAX_PAGE_SIZE),
    nextCursor: z.string().min(1).max(512).nullable(),
  })
  .strict();

const reviewSnapshot = z.strictObject({
  baseCommit: z.string().regex(GIT_OBJECT_ID),
  worktreeTree: z.string().regex(GIT_OBJECT_ID),
  patch: z.string(),
  files: z.array(
    z.strictObject({
      path: z.string().min(1),
      oldPath: z.string().min(1).optional(),
      status: z.enum(["A", "C", "D", "M", "R", "T"]),
      additions: z.number().int().min(0),
      deletions: z.number().int().min(0),
      binary: z.boolean(),
    }),
  ),
});

export function addressedCheckpointId(
  ref: string | null | undefined,
): string | null {
  if (!ref?.startsWith(WORKSPACE_GIT_CHECKPOINT_PREFIX)) return null;
  const id = z
    .uuid()
    .safeParse(ref.slice(WORKSPACE_GIT_CHECKPOINT_PREFIX.length));

  return id.success ? id.data : null;
}

/** Read the exact sealed object after its source event has passed catalogue projection. */
export async function readAddressedWorkspacePatch(
  input: WorkspaceReview &
    Readonly<{ range: Omit<WorkspaceDiffQuery, "generation"> }>,
): Promise<{ patch: string; baseCommit?: string }> {
  input.signal.throwIfAborted();
  const { object: reference, baseCommit } = await readAddressedWorkspaceDiff(
    input.db,
    input.workspace,
    input.range,
  );
  if (input.range.checkpointId && !baseCommit)
    throw new MaisterError(
      "ACP_PROTOCOL",
      "The selected supervisor did not identify the patch's base checkpoint",
    );
  const patch = await readWorkspaceReviewText(input, reference, {
    logicalName: "workspace-diff.patch",
    mimeType: "text/x-diff",
    maxBytes: 64 * 1024,
    pendingReason: "workspace_diff_pending",
  });

  return { patch, baseCommit };
}

export async function readAddressedWorkspaceHistory(
  input: WorkspaceReview &
    Readonly<{ page: Omit<WorkspaceLogQuery, "generation"> }>,
): Promise<WorkspaceLogPage> {
  input.signal.throwIfAborted();
  const { object: reference } = await readAddressedWorkspaceLog(
    input.db,
    input.workspace,
    input.page,
  );
  const text = await readWorkspaceReviewText(input, reference, {
    logicalName: WORKSPACE_LOG_OBJECT_NAME,
    mimeType: "application/json",
    maxBytes: WORKSPACE_LOG_MAX_BYTES,
    pendingReason: "workspace_log_pending",
  });
  try {
    return logPage.parse(JSON.parse(text));
  } catch {
    throw new MaisterError(
      "ACP_PROTOCOL",
      "The selected supervisor returned invalid Git history",
    );
  }
}

export async function readAddressedWorkspaceReviewSnapshot(
  input: WorkspaceReview &
    Readonly<{ range: { base: string } | { checkpointId: string } }>,
): Promise<WorkspaceGitReview> {
  input.signal.throwIfAborted();
  const { object: reference, baseCommit } = await readAddressedWorkspaceDiff(
    input.db,
    input.workspace,
    {
      ...input.range,
      format: "review",
    },
  );
  const text = await readWorkspaceReviewText(input, reference, {
    logicalName: WORKSPACE_REVIEW_OBJECT_NAME,
    mimeType: "application/json",
    maxBytes: WORKSPACE_REVIEW_MAX_BYTES,
    pendingReason: "workspace_diff_pending",
  });
  try {
    const snapshot = reviewSnapshot.parse(JSON.parse(text));
    if (
      snapshot.baseCommit ===
      ("base" in input.range ? input.range.base : baseCommit)
    )
      return snapshot;
  } catch (cause) {
    throw new MaisterError(
      "ACP_PROTOCOL",
      "The selected supervisor returned an invalid review source",
      { cause },
    );
  }

  throw new MaisterError(
    "ACP_PROTOCOL",
    "The selected supervisor returned a different review base",
  );
}

async function readWorkspaceReviewText(
  input: WorkspaceReview,
  reference: WorkspaceInputObject,
  expected: Readonly<{
    logicalName: string;
    mimeType: string;
    maxBytes: number;
    pendingReason: string;
  }>,
): Promise<string> {
  const { db, workspace } = input;
  const runId = workspace.runId;
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(10_000)]);
  while (!signal.aborted) {
    const record = await getRuntimeObjectForRun({
      db,
      runId,
      objectId: reference.objectId,
    });
    if (record && record.object.state !== "pending") {
      const object = record.object;
      if (
        object.executionHostId !== workspace.executionHostId ||
        object.sha256 !== reference.sha256 ||
        object.mimeType !== expected.mimeType ||
        object.logicalName !== expected.logicalName ||
        object.kind !== "diagnostic" ||
        object.sizeBytes === null ||
        object.sizeBytes > expected.maxBytes
      )
        throw new MaisterError(
          "ACP_PROTOCOL",
          "The sealed evidence does not match the addressed workspace reference",
        );
      const { content } = await readRuntimeObjectContent({
        db,
        runId,
        objectId: reference.objectId,
        signal,
      });

      return new TextDecoder().decode(content.bytes);
    }
    await runEventWakeBus.wait(runId, 2_000, signal);
  }

  throw new MaisterError(
    "EXECUTOR_UNAVAILABLE",
    "The selected host's evidence has not been applied",
    {
      details: { reason: expected.pendingReason },
    },
  );
}
