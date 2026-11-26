import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { and, desc, eq, isNull, notExists } from "drizzle-orm";

import {
  nodeAttempts,
  projects,
  runs,
  specialistRunLinks,
  workspaces,
} from "@/lib/db/schema";
import { workbenchClaimHoldsTree } from "@/lib/runs/lifecycle-claim";

export async function loadFailedNodeRestartTarget(db: Db, runId: string) {
  const [target] = await db
    .select({
      attempt: {
        id: nodeAttempts.id,
        nodeId: nodeAttempts.nodeId,
        nodeType: nodeAttempts.nodeType,
        status: nodeAttempts.status,
        endedAt: nodeAttempts.endedAt,
        checkpointRef: nodeAttempts.checkpointRef,
      },
      workspace: {
        lifecycleOperationState: workspaces.lifecycleOperationState,
        lifecycleOperationName: workspaces.lifecycleOperationName,
        lifecycleOperationLeaseExpiresAt:
          workspaces.lifecycleOperationLeaseExpiresAt,
        promotionState: workspaces.promotionState,
        promotionClaimedAt: workspaces.promotionClaimedAt,
        branch: workspaces.branch,
        worktreePath: workspaces.worktreePath,
      },
    })
    .from(nodeAttempts)
    .innerJoin(runs, eq(runs.id, nodeAttempts.runId))
    .innerJoin(projects, eq(projects.id, runs.projectId))
    .innerJoin(workspaces, eq(workspaces.runId, runs.id))
    .where(
      and(
        eq(runs.id, runId),
        eq(runs.status, "Failed"),
        eq(runs.runKind, "flow"),
        isNull(runs.companyId),
        isNull(runs.parentRunId),
        isNull(runs.agentKind),
        isNull(projects.archivedAt),
        isNull(workspaces.archivedAt),
        isNull(workspaces.removedAt),
        notExists(
          db
            .select({ id: specialistRunLinks.runId })
            .from(specialistRunLinks)
            .where(eq(specialistRunLinks.runId, runs.id)),
        ),
      ),
    )
    .orderBy(
      desc(nodeAttempts.startedAt),
      desc(nodeAttempts.attempt),
      desc(nodeAttempts.id),
    )
    .limit(1);

  if (!target?.workspace.worktreePath || workbenchClaimHoldsTree(target.workspace)) return null;
  const { attempt } = target;

  if (
    !["ai_coding", "judge", "cli", "check", "guard", "human", "form"].includes(
      attempt.nodeType,
    ) ||
    (attempt.status !== "Failed" &&
      !(attempt.status === "Running" && attempt.endedAt === null))
  )
    return null;

  return {
    id: attempt.id,
    nodeId: attempt.nodeId,
    nodeType: attempt.nodeType,
    checkpointRef: attempt.checkpointRef,
    branch: target.workspace.branch,
    worktreePath: target.workspace.worktreePath,
  };
}
