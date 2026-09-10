import "server-only";

import type { PromotionReadyItem } from "@/lib/ext-activity/types";
import type { ReadinessState } from "@/lib/flows/graph/readiness-core";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { and, eq, inArray } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { launchedLineageRunIds } from "@/lib/evaluations/membership";
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
  projectId: string | null;
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

interface ClassifiedPromotable extends PromotionReadyItem {
  // The owning project, needed only by the cross-project queue. Deliberately
  // absent from `PromotionReadyItem`, whose shape is a frozen ext contract.
  projectId: string;
}

// SOLID: the loader knows how rows are fetched; the classifier knows what makes
// a row promotable. Splitting them is what lets ONE readiness pass cover many
// projects — the classifier no longer has to be told which project it is in.
async function loadPromotableCandidates(
  client: DbClient,
  projectIds: readonly string[],
): Promise<CandidateRow[]> {
  if (projectIds.length === 0) return [];

  const joined: CandidateRow[] = await client
    .select({
      runId: runs.id,
      projectId: runs.projectId,
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
        inArray(runs.projectId, [...projectIds]),
        inArray(runs.runKind, [...PROMOTABLE_RUN_KINDS]),
        inArray(runs.status, [...PROMOTABLE_RUN_STATUSES]),
      ),
    );

  // `workspaces.run_id` carries no UNIQUE constraint (only `worktree_path` does),
  // and the orphan-worktree reconcilers can insert a second row for a run — so
  // the left join is one-to-MANY in principle and would emit the same runId
  // twice. Collapse to the first row per run: the list is a set of runs, and a
  // duplicate would also break the deterministic ordering REQ-A2 AC4 promises.
  return [...new Map(joined.map((row) => [row.runId, row])).values()];
}

async function classifyPromotable(
  client: DbClient,
  candidates: readonly CandidateRow[],
  logScope: Record<string, unknown>,
): Promise<ClassifiedPromotable[]> {
  if (candidates.length === 0) {
    log.debug(
      { ...logScope, candidateCount: 0 },
      "[ext-activity.promotable] classified",
    );

    return [];
  }

  const readinessByRun = await computeReadinessByRun(
    client,
    candidates.map((row) => row.runId),
  );
  const mechanical: Array<{ row: CandidateRow; readiness: ReadinessState }> =
    [];

  for (const row of candidates) {
    const readiness = readinessByRun.get(row.runId);

    if (readiness === undefined) {
      log.warn(
        { ...logScope, runId: row.runId },
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
  // ONE batched query, not one per candidate: the pulse is a polling endpoint,
  // and an N-query here would reintroduce exactly the per-run cost REQ-A3
  // forbids for readiness two lines above.
  const lineageRunIds = await launchedLineageRunIds(
    client,
    unheld.map((entry) => entry.row.runId),
  );
  const surviving = unheld.filter(
    (entry) => !lineageRunIds.has(entry.row.runId),
  );

  const items = surviving
    // `runs.project_id` is nullable in the schema (projectless assistant runs),
    // but the candidate SQL filters `project_id IN (...)`, which excludes NULL
    // by SQL semantics. This narrows the type; it removes no reachable row.
    .filter(
      (
        entry,
      ): entry is {
        row: CandidateRow & { projectId: string };
        readiness: ReadinessState;
      } => entry.row.projectId !== null,
    )
    .map(({ row, readiness }) => ({
      runId: row.runId,
      projectId: row.projectId,
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
      ...logScope,
      candidateCount: candidates.length,
      readyCount: items.length,
      excludedHold: mechanical.length - unheld.length,
      excludedLineage: unheld.length - surviving.length,
    },
    "[ext-activity.promotable] classified",
  );

  return items;
}

/**
 * Cross-project promotable runs in ONE readiness pass (T2.3).
 *
 * Calling `listProjectPromotable` per project would restore the per-project N
 * the cross-project decision queue exists to avoid.
 */
export async function listPromotableForProjects(
  projectIds: readonly string[],
  deps?: { db?: DbClient },
): Promise<ClassifiedPromotable[]> {
  const client = deps?.db ?? (getDb() as DbClient);
  const candidates = await loadPromotableCandidates(client, projectIds);

  return classifyPromotable(client, candidates, {
    projectCount: projectIds.length,
  });
}

export async function listProjectPromotable(
  projectId: string,
  deps?: { db?: DbClient },
): Promise<PromotionReadyItem[]> {
  const client = deps?.db ?? (getDb() as DbClient);
  const candidates = await loadPromotableCandidates(client, [projectId]);
  const classified = await classifyPromotable(client, candidates, {
    projectId,
  });

  // Project to the EXACT public shape. `projectId` is an internal convenience
  // for the cross-project caller and must not ride out on a frozen ext contract
  // just because it happens to be on the object.
  return classified.map((item) => ({
    runId: item.runId,
    taskId: item.taskId,
    taskKey: item.taskKey,
    taskTitle: item.taskTitle,
    targetBranch: item.targetBranch,
    readiness: item.readiness,
    inReviewSince: item.inReviewSince,
  }));
}
