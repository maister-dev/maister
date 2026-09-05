import "server-only";

import type { Workspace as WorkspaceRow } from "@/lib/db/schema";

import { and, desc, eq, isNotNull } from "drizzle-orm";
import pino from "pino";

import { recordArtifact } from "./artifact-store";

import { resolveBaseRef, resolveRefSha } from "@/lib/worktree";
import * as schemaModule from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { hitlRequests } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "default-artifacts",
  level: process.env.LOG_LEVEL ?? "info",
});

// Attempt git merge-base to get the diff base commit. Falls back to the empty
// tree SHA so the diff locator always has a valid (if meaningless) baseCommit
// in environments without a real git repo (e.g. integration test containers
// where the worktree path is a temp dir with no git).
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

async function safeBaseCommit(workspace: WorkspaceRow): Promise<string> {
  try {
    return await resolveBaseRef({
      worktreePath: workspace.worktreePath,
      branch: workspace.branch,
      mainBranch: "main",
    });
  } catch {
    return EMPTY_TREE_SHA;
  }
}

// Resolve the branch tip to an immutable SHA so the default diff locator's
// headRef never drifts when the branch advances (PR2/F3). Falls back to the
// mutable branch name when git is unavailable (e.g. integration test
// containers), and WARNs so the degraded-git record is traceable.
async function safeHeadRef(workspace: WorkspaceRow): Promise<string> {
  try {
    return await resolveRefSha(workspace.worktreePath, workspace.branch);
  } catch (err) {
    log.warn(
      { branch: workspace.branch, err: (err as Error).message },
      "resolveRefSha failed — storing mutable branch headRef",
    );

    return workspace.branch;
  }
}

export type RecordDefaultArtifactsArgs = {
  runId: string;
  nodeAttemptId: string;
  nodeId: string;
  attempt: number;
  workspace: WorkspaceRow;
};

// Record default ("index") artifact rows for a just-finished graph node. The
// rows point at EXISTING payloads; no payload is created here.
//
// - hitl-response: if a hitl_requests row with non-null response exists for
//   (runId, nodeId) → kind "human_note", locator hitl-response
// - diff: always → kind "diff", locator git-range
//
// Deterministic id: run:<nodeAttemptId>:default:<kind>.
export async function recordDefaultArtifacts(
  args: RecordDefaultArtifactsArgs,
  db: Db,
): Promise<void> {
  const { runId, nodeAttemptId, nodeId, attempt, workspace } = args;

  function makeId(kind: string): string {
    return `run:${nodeAttemptId}:default:${kind}`;
  }

  const baseArgs = {
    runId,
    nodeAttemptId,
    nodeId,
    attempt,
    producer: "runner" as const,
    validity: "current" as const,
    visibility: "internal" as const,
    retention: "run" as const,
  };

  // 1. HITL response (best-effort: only if responded row exists)
  try {
    // On an on_reject rework loop a step has multiple responded HITL rows
    // (reject, then the final approve). Bind the human_note to the LATEST one
    // (newest by creation) so the final decision is current evidence, never a
    // stale earlier reject.
    const hitlRows: Array<{ id: string }> = await db
      .select({ id: hitlRequests.id })
      .from(hitlRequests)
      .where(
        and(
          eq(hitlRequests.runId, runId),
          eq(hitlRequests.stepId, nodeId),
          isNotNull(hitlRequests.response),
        ),
      )
      .orderBy(desc(hitlRequests.createdAt))
      .limit(1);

    const hitlRow = hitlRows[0];

    if (hitlRow) {
      await recordArtifact(
        {
          ...baseArgs,
          id: makeId("human_note"),
          artifactDefId: `default:${nodeId}:human_note`,
          kind: "human_note",
          locator: { kind: "hitl-response", hitlRequestId: hitlRow.id },
        },
        db,
      );
    }
  } catch (err) {
    log.warn(
      { runId, nodeId, err: (err as Error).message },
      "default hitl artifact record failed (non-fatal)",
    );
  }

  // 2. Diff artifact (always — uses safe fallback when git unavailable)
  try {
    const baseCommit = await safeBaseCommit(workspace);
    const headRef = await safeHeadRef(workspace);

    await recordArtifact(
      {
        ...baseArgs,
        id: makeId("diff"),
        artifactDefId: `default:${nodeId}:diff`,
        kind: "diff",
        locator: {
          kind: "git-range",
          baseCommit,
          headRef,
        },
      },
      db,
    );
  } catch (err) {
    log.warn(
      { runId, nodeId, err: (err as Error).message },
      "default diff artifact record failed (non-fatal)",
    );
  }
}
