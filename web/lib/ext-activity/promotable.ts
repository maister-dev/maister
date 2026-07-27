import "server-only";

import type { PromotionReadyItem } from "@/lib/ext-activity/types";
import type { ReadinessState } from "@/lib/flows/graph/readiness-core";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { and, eq, inArray } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { isLaunchedLineageRun } from "@/lib/evaluations/membership";
import { isPhaseReady } from "@/lib/flows/graph/readiness-core";
import { computeReadinessByRun } from "@/lib/queries/readiness-batch";

const { projects, runs, tasks, workspaces } = schema;

type DbClient = NodePgDatabase<typeof schema>;

const log = pino({
  name: "ext-activity-promotable",
  level: process.env.LOG_LEVEL ?? "info",
});

// Allow-list, never a `!terminal` deny-list: an unrecognized kind or status is
// refused by default, so a future `runs.status` value cannot silently become a
// promote recommendation.
export const PROMOTABLE_RUN_KINDS = ["flow"] as const;
export const PROMOTABLE_RUN_STATUSES = ["Review"] as const;

// Layer 1 of D5' — mechanical acceptance. This layer, and only this layer, is
// equivalent to what `promoteRun` unconditionally enforces (the status CAS plus
// readiness), which is why T-A6 asserts it biconditionally against
// `assertEvidenceReady`. `isPhaseReady` is the SSOT and is never re-spelled:
// `overridden` outranks `ready` in READINESS_PRIORITY, so a `state === "ready"`
// comparison would silently drop a run whose blocking gate a human waived.
export function isMechanicallyPromotable(input: {
  runKind: string;
  status: string;
  readiness: ReadinessState | undefined;
}): boolean {
  if (!(PROMOTABLE_RUN_KINDS as readonly string[]).includes(input.runKind)) {
    return false;
  }
  if (!(PROMOTABLE_RUN_STATUSES as readonly string[]).includes(input.status)) {
    return false;
  }
  if (input.readiness === undefined) return false;

  return isPhaseReady(input.readiness);
}

export function comparePromotable(
  a: PromotionReadyItem,
  b: PromotionReadyItem,
): number {
  const at = a.inReviewSince?.getTime() ?? null;
  const bt = b.inReviewSince?.getTime() ?? null;

  if (at !== bt) {
    if (at === null) return 1;
    if (bt === null) return -1;

    return at - bt;
  }

  return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0;
}

type CandidateRow = {
  runId: string;
  runKind: string;
  status: string;
  promotionHold: unknown;
  taskId: string | null;
  taskTitle: string | null;
  projectTaskKey: string | null;
  taskNumber: number | null;
  targetBranch: string | null;
  reviewEnteredAt: Date | null;
};

export async function listProjectPromotable(
  projectId: string,
  deps?: { db?: DbClient },
): Promise<PromotionReadyItem[]> {
  const client = deps?.db ?? (getDb() as DbClient);
  const candidates: CandidateRow[] = await client
    .select({
      runId: runs.id,
      runKind: runs.runKind,
      status: runs.status,
      promotionHold: runs.promotionHold,
      taskId: runs.taskId,
      taskTitle: tasks.title,
      projectTaskKey: projects.taskKey,
      taskNumber: tasks.number,
      targetBranch: workspaces.targetBranch,
      reviewEnteredAt: runs.reviewEnteredAt,
    })
    .from(runs)
    .innerJoin(projects, eq(projects.id, runs.projectId))
    .leftJoin(tasks, eq(tasks.id, runs.taskId))
    .leftJoin(workspaces, eq(workspaces.runId, runs.id))
    .where(
      and(
        eq(runs.projectId, projectId),
        inArray(runs.runKind, [...PROMOTABLE_RUN_KINDS]),
        inArray(runs.status, [...PROMOTABLE_RUN_STATUSES]),
      ),
    );

  if (candidates.length === 0) {
    log.debug(
      { projectId, candidateCount: 0 },
      "[ext-activity.promotable] classified",
    );

    return [];
  }

  const readinessByRun = await computeReadinessByRun(
    client,
    candidates.map((row) => row.runId),
  );
  const mechanical: Array<{ row: CandidateRow; readiness: ReadinessState }> = [];

  for (const row of candidates) {
    const readiness = readinessByRun.get(row.runId);

    if (readiness === undefined) {
      log.warn(
        { projectId, runId: row.runId },
        "[ext-activity.promotable] no readiness entry for a candidate run",
      );
      continue;
    }

    if (
      isMechanicallyPromotable({
        runKind: row.runKind,
        status: row.status,
        readiness,
      })
    ) {
      mechanical.push({ row, readiness });
    }
  }

  // Layer 2 of D5' — operator-intent suppression. This is a DELIBERATE
  // divergence from `promoteRun`, not a mirror of it: `promoteRun` refuses on a
  // hold only for `attribution.source === "auto_promotion"` and on launched
  // lineage only under `isUnattendedPromotion`, so a HUMAN promote of either
  // succeeds. The pulse withholds them anyway — a hold means an operator said
  // stop, and a launched-lineage participant is decided by its study. Do not
  // "simplify" this into the candidate SQL: keeping it here is what makes the
  // divergence legible, and what lets the counters below answer "why is my green
  // Review run missing from the list?" without a debugger.
  const unheld = mechanical.filter((entry) => entry.row.promotionHold == null);
  const lineageFlags = await Promise.all(
    unheld.map((entry) => isLaunchedLineageRun(client, entry.row.runId)),
  );
  const surviving = unheld.filter((_entry, index) => !lineageFlags[index]);

  const items = surviving
    .map(({ row, readiness }) => ({
      runId: row.runId,
      taskId: row.taskId ?? null,
      taskKey:
        row.projectTaskKey && row.taskNumber !== null
          ? `${row.projectTaskKey}-${row.taskNumber}`
          : null,
      taskTitle: row.taskTitle ?? null,
      targetBranch: row.targetBranch ?? null,
      readiness,
      inReviewSince: row.reviewEnteredAt ?? null,
    }))
    .sort(comparePromotable);

  log.debug(
    {
      projectId,
      candidateCount: candidates.length,
      readyCount: items.length,
      excludedHold: mechanical.length - unheld.length,
      excludedLineage: lineageFlags.filter(Boolean).length,
    },
    "[ext-activity.promotable] classified",
  );

  return items;
}
