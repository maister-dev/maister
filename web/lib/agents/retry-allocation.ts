import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type {
  AgentRetryClaim,
  AgentRetryAllocation,
} from "@/lib/agents/retry-types";
import type { MaisterProvenance } from "@/lib/worktree-provenance";

import { lstat, realpath } from "node:fs/promises";

import { eq } from "drizzle-orm";

import { agentRetryIntents } from "@/lib/db/schema";
import { armAgentRetryAllocation } from "@/lib/agents/retry-ownership";
import { retryDigest, retryRefusal } from "@/lib/agents/retry-guards";
import {
  addWorktree,
  listWorktrees,
  headCommit,
  statusPorcelain,
} from "@/lib/worktree";
import { readWorktreeProvenanceMetadata } from "@/lib/worktree-provenance";

export async function allocateAgentRetryWorktree(
  db: Db,
  claim: AgentRetryClaim,
  args: {
    runId: string;
    projectId: string;
    repositoryPath: string;
    path: string;
    branch: string;
    baseCommit: string;
  },
): Promise<void> {
  const [intent] = await db
    .select()
    .from(agentRetryIntents)
    .where(eq(agentRetryIntents.id, claim.intentId));

  if (!intent) throw retryRefusal("retry_intent_unavailable");
  const provenance: MaisterProvenance = {
    version: 2,
    runId: args.runId,
    projectId: args.projectId,
    parentRepoPath: args.repositoryPath,
    branch: args.branch,
    workspaceKind: "agent",
    createdAt: intent.createdAt.toISOString(),
  };
  const resource: AgentRetryAllocation["resources"][number] = {
    kind: "worktree",
    path: args.path,
    repositoryPath: args.repositoryPath,
    branch: args.branch,
    baseCommit: args.baseCommit,
    provenanceDigest: retryDigest(provenance),
  };

  await armAgentRetryAllocation(db, claim, resource);
  let exists: boolean;

  try {
    await lstat(args.path);
    exists = true;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
    exists = false;
  }
  if (exists) {
    const metadata = await readWorktreeProvenanceMetadata(args.path);
    const awaitedPath = await realpath(args.path);
    const registered = (await listWorktrees(args.repositoryPath)).find(
      (tree) => tree.path === awaitedPath,
    );

    if (
      retryDigest(metadata) !== resource.provenanceDigest ||
      !registered ||
      registered.branch !== `refs/heads/${args.branch}` ||
      (await headCommit({ worktreePath: args.path })) !== args.baseCommit ||
      (await statusPorcelain({ worktreePath: args.path })).trim()
    )
      throw retryRefusal("retry_resource_conflict");

    return;
  }
  await addWorktree({
    projectRepoPath: args.repositoryPath,
    worktreePath: args.path,
    branch: args.branch,
    startPoint: args.baseCommit,
    provenance,
  });
}
