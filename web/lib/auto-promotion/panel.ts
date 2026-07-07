import type { LaneClass } from "./config";

import { eq } from "drizzle-orm";

import {
  evaluateAutoPromotion,
  type AutoPromotionEvaluation,
} from "./evaluate";
import { buildAutoPromotionReaders } from "./readers";

import { projects, runs, workspaces } from "@/lib/db/schema";
import { diffChangeStats } from "@/lib/worktree";

// FIXME(any): tests pass a Testcontainers pg client.
type Db = any;

export interface RunAutoPromotionPanel {
  // Non-null only for Review flow runs (§4.8); the run-detail RSC + the GET route
  // both call THIS so their verdicts are identical.
  evaluation: AutoPromotionEvaluation | null;
  // The "promoted automatically via lane X" datum (workspaces.promotion_lane).
  promotedLane: LaneClass | null;
}

// The ONE run-scoped evaluation entry point for the panel surfaces.
export async function computeRunAutoPromotion(
  db: Db,
  runId: string,
  now: Date = new Date(),
): Promise<RunAutoPromotionPanel> {
  const rows = await db
    .select({
      projectId: runs.projectId,
      status: runs.status,
      runKind: runs.runKind,
      taskId: runs.taskId,
      parentRunId: runs.parentRunId,
      workspaceMode: runs.workspaceMode,
      deliveryPolicySnapshot: runs.deliveryPolicySnapshot,
      executionPolicy: runs.executionPolicy,
      promotionHold: runs.promotionHold,
      reviewEnteredAt: runs.reviewEnteredAt,
      worktreePath: workspaces.worktreePath,
      branch: workspaces.branch,
      baseCommit: workspaces.baseCommit,
      promotionLane: workspaces.promotionLane,
      autoPromotion: projects.autoPromotion,
    })
    .from(runs)
    .innerJoin(workspaces, eq(workspaces.runId, runs.id))
    .innerJoin(projects, eq(projects.id, runs.projectId))
    .where(eq(runs.id, runId));

  const c = rows[0];

  if (!c) return { evaluation: null, promotedLane: null };

  const promotedLane = (c.promotionLane ?? null) as LaneClass | null;

  if (c.status !== "Review" || c.runKind !== "flow" || !c.baseCommit) {
    return { evaluation: null, promotedLane };
  }

  let files;

  try {
    files = await diffChangeStats({
      worktreePath: c.worktreePath,
      baseRef: c.baseCommit,
      branch: c.branch,
    });
  } catch {
    return { evaluation: null, promotedLane };
  }

  const evaluation = await evaluateAutoPromotion({
    run: {
      id: runId,
      projectId: c.projectId,
      status: c.status,
      runKind: c.runKind,
      taskId: c.taskId,
      parentRunId: c.parentRunId,
      workspaceMode: c.workspaceMode,
      deliveryPolicySnapshot: c.deliveryPolicySnapshot,
      executionPolicy: c.executionPolicy,
      promotionHold: c.promotionHold,
      reviewEnteredAt: c.reviewEnteredAt,
    },
    project: { id: c.projectId, autoPromotion: c.autoPromotion },
    files,
    now,
    readers: buildAutoPromotionReaders({
      db,
      runId,
      worktreePath: c.worktreePath,
      baseRef: c.baseCommit,
      branch: c.branch,
    }),
  });

  return { evaluation, promotedLane };
}
