import "server-only";

import type {
  AgentizationSummary,
  ObservatoryFunnel,
} from "@/lib/queries/observatory-agentization-core";
import type { ObservatoryFilters } from "@/lib/queries/observatory";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { and, eq, gte, inArray, isNotNull, lte } from "drizzle-orm";

import * as schema from "@/lib/db/schema";
import {
  rollupAgentization,
  rollupObservatoryFunnel,
} from "@/lib/queries/observatory-agentization-core";
import { isDeliveryRunKind } from "@/lib/observatory/run-kind";

export interface ProjectAgentizationSummary {
  agentization: AgentizationSummary;
  funnel: ObservatoryFunnel;
}

export async function getProjectAgentization(
  client: NodePgDatabase<typeof schema>,
  input: {
    projectId: string;
    mainBranch: string;
    filters: ObservatoryFilters;
    now: Date;
  },
): Promise<ProjectAgentizationSummary> {
  const runKind = input.filters.runKind ?? "all";
  const since = new Date(
    input.now.getTime() -
      (input.filters.windowDays ?? 30) * 24 * 60 * 60 * 1000,
  );
  const runConditions = [eq(schema.runs.projectId, input.projectId)];

  if (runKind !== "all") {
    runConditions.push(eq(schema.runs.runKind, runKind));
  }

  const runRows = await client
    .select({
      id: schema.runs.id,
      runKind: schema.runs.runKind,
      status: schema.runs.status,
      promotedHeadSha: schema.runs.promotedHeadSha,
      mergeCommitSha: schema.runs.mergeCommitSha,
      diffStat: schema.runs.diffStat,
      launchMode: schema.runs.launchMode,
      triggerSource: schema.runs.triggerSource,
      promotionLane: schema.workspaces.promotionLane,
      platformPromotedAt: schema.workspaces.promotedAt,
      prNumber: schema.workspaces.prNumber,
      endedAt: schema.runs.endedAt,
      startedAt: schema.runs.startedAt,
    })
    .from(schema.runs)
    .leftJoin(schema.workspaces, eq(schema.workspaces.runId, schema.runs.id))
    .where(and(...runConditions));

  const runIds = runRows.map((row) => row.id);
  const [hitlRows, reviewRows, takeoverRows, deliveryRows] = await Promise.all([
    selectHitlRunIds(client, runIds),
    selectHumanReviewRunIds(client, runIds),
    selectTakeoverRunIds(client, runIds),
    client
      .select({
        bucketStart: schema.repoDeliveryRollups.bucketStart,
        bucketEnd: schema.repoDeliveryRollups.bucketEnd,
        commits: schema.repoDeliveryRollups.commits,
        mergePrUnits: schema.repoDeliveryRollups.mergePrUnits,
        additions: schema.repoDeliveryRollups.additions,
        deletions: schema.repoDeliveryRollups.deletions,
        deliveryRefs: schema.repoDeliveryRollups.deliveryRefs,
        providerComplete: schema.repoDeliveryRollups.providerComplete,
        fetchedAt: schema.repoDeliveryRollups.fetchedAt,
      })
      .from(schema.repoDeliveryRollups)
      .where(
        and(
          eq(schema.repoDeliveryRollups.projectId, input.projectId),
          eq(schema.repoDeliveryRollups.branch, input.mainBranch),
          gte(schema.repoDeliveryRollups.bucketStart, since),
          lte(schema.repoDeliveryRollups.bucketStart, input.now),
        ),
      ),
  ]);
  const hitlRunIds = new Set(hitlRows);
  const humanReviewRunIds = new Set(reviewRows);
  const takeoverRunIds = new Set(takeoverRows);
  const normalizedRuns = runRows.flatMap((row) =>
    row.runKind !== null && isDeliveryRunKind(row.runKind)
      ? [
          {
            id: row.id,
            runKind: row.runKind,
            startedAt: row.startedAt,
            status: row.status,
            promotedHeadSha: row.promotedHeadSha,
            mergeCommitSha: row.mergeCommitSha,
            diffStat: row.diffStat,
            prNumber: row.prNumber,
            active: row.endedAt === null,
            launchMode: row.launchMode,
            triggerSource: row.triggerSource,
            promotionLane: toPromotionLane(
              row.platformPromotedAt,
              row.promotionLane,
            ),
            platformPromoted: row.platformPromotedAt !== null,
            hasHitl: hitlRunIds.has(row.id),
            hasHumanReview: humanReviewRunIds.has(row.id),
            hasHumanTakeover: takeoverRunIds.has(row.id),
          },
        ]
      : [],
  );

  return {
    agentization: rollupAgentization({
      runKind,
      runs: normalizedRuns,
      buckets: deliveryRows,
    }),
    funnel: rollupObservatoryFunnel({
      runKind,
      runs: normalizedRuns,
      since,
    }),
  };
}

function toPromotionLane(
  promotedAt: Date | null,
  recordedLane: string | null,
): "auto" | "manual" | null {
  if (promotedAt === null) return null;

  return recordedLane === null ? "manual" : "auto";
}

async function selectHitlRunIds(
  client: NodePgDatabase<typeof schema>,
  runIds: readonly string[],
): Promise<string[]> {
  const rows = await client
    .select({ runId: schema.hitlRequests.runId })
    .from(schema.hitlRequests)
    .where(inArray(schema.hitlRequests.runId, [...runIds]));

  return rows.map((row) => row.runId);
}

async function selectHumanReviewRunIds(
  client: NodePgDatabase<typeof schema>,
  runIds: readonly string[],
): Promise<string[]> {
  const rows = await client
    .select({ runId: schema.assignments.runId })
    .from(schema.assignments)
    .where(
      and(
        inArray(schema.assignments.runId, [...runIds]),
        eq(schema.assignments.actionKind, "human_review"),
      ),
    );

  return rows.map((row) => row.runId);
}

async function selectTakeoverRunIds(
  client: NodePgDatabase<typeof schema>,
  runIds: readonly string[],
): Promise<string[]> {
  const [eventRows, attemptRows] = await Promise.all([
    client
      .select({ runId: schema.assignmentEvents.runId })
      .from(schema.assignmentEvents)
      .where(
        and(
          inArray(schema.assignmentEvents.runId, [...runIds]),
          eq(schema.assignmentEvents.eventKind, "taken_over"),
        ),
      ),
    client
      .select({ runId: schema.nodeAttempts.runId })
      .from(schema.nodeAttempts)
      .where(
        and(
          inArray(schema.nodeAttempts.runId, [...runIds]),
          isNotNull(schema.nodeAttempts.ownerUserId),
        ),
      ),
  ]);

  return [
    ...eventRows.map((row) => row.runId),
    ...attemptRows.map((row) => row.runId),
  ];
}
