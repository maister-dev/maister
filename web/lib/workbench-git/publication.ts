import "server-only";

import type { BranchUpstream } from "@/lib/worktree";

import { and, eq, gt } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { branchNameSchema } from "@/lib/git-ref-names";
import {
  DEFAULT_PUBLIC_BRANCH_TEMPLATE,
  attemptFromBranch,
  renderPublicBranchName,
} from "@/lib/workbench-git/public-branch-name";

// FIXME(any): dual drizzle-orm peer-dep variants — callers pass their own
// drizzle handle (the app client, a transaction, or a test container's).
type Db = any;

const { workspaces } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "workbench-git-publication",
  level: process.env.LOG_LEVEL ?? "info",
});

export type PublishNameSource = "upstream" | "request" | "template";

export type PublishNameInput = {
  runId: string;
  internalBranch: string;
  remote: string;
  // The operator's explicit name (the publish dialog), or null.
  requested: string | null;
  // `projects.public_branch_template`; absent → the default.
  template: string | null | undefined;
  // `<projects.task_key>-<tasks.number>`, or null for a task-less run.
  taskKey: string | null;
  taskTitle: string | null;
  // `workspaces.published_branch/remote` — the durable record of the last
  // publish (the upstream config can be lost: a re-attach from the archive, a
  // recovered worktree).
  recordedBranch: string | null;
  recordedRemote: string | null;
  // A PR recorded BEFORE ADR-181 was opened from the INTERNAL name (promotion
  // pushed `origin/<internal>`) and has no publication record.
  legacyPrHead: boolean;
  // `branchUpstream(internal)` read by the caller.
  upstream: BranchUpstream | null;
};

// ADR-181 D4 step 2 — the ONE answer to "under which name is this run's branch
// published on `remote`?", shared by publish and pull-request promotion. An
// EXISTING publication on that remote fixes the name — (a) the upstream,
// (a2) the recorded publication, (a3) a pre-ADR-181 PR's internal head — and a
// different request is refused loudly, never silently forked into a second
// branch (and a second PR). Only then (b) the operator's name, (c) the template.
// `source: "upstream"` names every fixed case.
export function resolvePublishName(input: PublishNameInput): {
  name: string;
  source: PublishNameSource;
} {
  const fixed =
    input.upstream !== null && input.upstream.remote === input.remote
      ? input.upstream.branch
      : input.recordedBranch !== null && input.recordedRemote === input.remote
        ? input.recordedBranch
        : input.legacyPrHead && input.remote === "origin"
          ? input.internalBranch
          : null;

  if (fixed !== null) {
    if (input.requested !== null && input.requested !== fixed) {
      throw new MaisterError(
        "PRECONDITION",
        `run ${input.runId} is already published as ${input.remote}/${fixed}; its public name cannot change`,
        { details: { reason: "public_name_fixed" } },
      );
    }
    if (input.recordedBranch !== null && input.recordedBranch !== fixed) {
      log.warn(
        {
          runId: input.runId,
          recordedBranch: input.recordedBranch,
          fixedBranch: fixed,
        },
        "published_branch disagrees with the branch upstream — the upstream wins",
      );
    }

    return { name: fixed, source: "upstream" };
  }

  if (input.requested !== null) {
    const parsed = branchNameSchema.safeParse(input.requested);

    if (!parsed.success) {
      throw new MaisterError(
        "PRECONDITION",
        `Invalid branchName: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      );
    }

    return { name: parsed.data, source: "request" };
  }

  return {
    name: renderPublicBranchName(
      input.template ?? DEFAULT_PUBLIC_BRANCH_TEMPLATE,
      {
        taskKey: input.taskKey,
        title: input.taskTitle,
        attempt: attemptFromBranch(input.internalBranch),
        runId: input.runId,
      },
    ),
    source: "template",
  };
}

// ADR-181 D7: where a run's branch lives on a remote — its publication when
// recorded, else `origin` under the internal name (the pre-ADR-181 shape). The
// sync push and its recovery, the re-attach revival and the reattach-source
// fact all read the branch back from here.
export type PublishedTarget = { remote: string; remoteBranch: string };

export function publishedTarget(workspace: {
  branch: string;
  publishedBranch?: string | null;
  publishedRemote?: string | null;
}): PublishedTarget {
  return workspace.publishedBranch && workspace.publishedRemote
    ? {
        remote: workspace.publishedRemote,
        remoteBranch: workspace.publishedBranch,
      }
    : { remote: "origin", remoteBranch: workspace.branch };
}

export type RecordPublishedInput = {
  database?: Db;
  workspaceId: string;
  remote: string;
  branch: string;
  at: Date;
  // The claim the push ran under: publish and sync hold the lifecycle slot,
  // pull-request promotion holds the promotion claim.
  fence: { kind: "lifecycle" | "promotion"; attemptId: string };
};

// ADR-181 D4 step 6 — the ONE writer of `published_branch/remote/at`, run only
// AFTER the push succeeded, under the claim that pushed. A push that landed
// while this write failed is recovered by the retry: the upstream names the
// same branch, the push is a no-op, and this records it.
export async function recordPublished(
  args: RecordPublishedInput,
): Promise<void> {
  const client = args.database ?? getDb();
  const fence =
    args.fence.kind === "lifecycle"
      ? [
          eq(workspaces.lifecycleOperationAttemptId, args.fence.attemptId),
          eq(workspaces.lifecycleOperationState, "claiming"),
          gt(workspaces.lifecycleOperationLeaseExpiresAt, new Date()),
        ]
      : [
          eq(workspaces.promotionAttemptId, args.fence.attemptId),
          eq(workspaces.promotionState, "claiming"),
        ];
  const rows = await client
    .update(workspaces)
    .set({
      publishedBranch: args.branch,
      publishedRemote: args.remote,
      publishedAt: args.at,
    })
    .where(and(eq(workspaces.id, args.workspaceId), ...fence))
    .returning({ id: workspaces.id });

  if (rows.length === 0) {
    throw new MaisterError(
      "CONFLICT",
      `claim lost before the publication was recorded: ${args.workspaceId}`,
    );
  }

  log.info(
    {
      workspaceId: args.workspaceId,
      remote: args.remote,
      branch: args.branch,
      fence: args.fence.kind,
    },
    "publication recorded",
  );
}
