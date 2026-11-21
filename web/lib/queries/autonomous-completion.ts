import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";

import { normalizePublicationOrigin } from "../../../runtime/workspace-publication";
import { GIT_OBJECT_ID } from "../../../runtime/wait-head";

import {
  projects,
  runAutonomousDecisions,
  runAutonomousReversals,
  runs,
} from "@/lib/db/schema";

export type AutonomousCompletionCounts = Readonly<{
  done: number;
  failed: number;
  reverted: number;
}>;

export async function getAutonomousCompletionCounts(
  db: Db,
  projectIds: readonly string[],
  period: { since: Date; until: Date },
  runKind: string | undefined,
): Promise<AutonomousCompletionCounts> {
  if (
    projectIds.length === 0 ||
    (runKind && runKind !== "all" && runKind !== "flow")
  )
    return { done: 0, failed: 0, reverted: 0 };
  const [counts] = await db
    .select({
      done: sql<number>`count(*) FILTER (WHERE ${runAutonomousDecisions.action} IN ('promote','finalize_pr'))`.mapWith(
        Number,
      ),
      failed:
        sql<number>`count(*) FILTER (WHERE ${runAutonomousDecisions.action}='fail')`.mapWith(
          Number,
        ),
      reverted:
        sql<number>`(SELECT count(distinct (${runAutonomousReversals.decisionId}, ${runAutonomousReversals.revertCommit}))
      FROM ${runAutonomousReversals}
      WHERE ${inArray(runAutonomousReversals.projectId, projectIds)}
        AND ${runAutonomousReversals.reversedAt} >= ${period.since.toISOString()}::timestamptz
        AND ${runAutonomousReversals.reversedAt} < ${period.until.toISOString()}::timestamptz)`.mapWith(
          Number,
        ),
    })
    .from(runAutonomousDecisions)
    .where(
      and(
        inArray(runAutonomousDecisions.projectId, projectIds),
        eq(runAutonomousDecisions.phase, "observed"),
        gte(runAutonomousDecisions.createdAt, period.since),
        lt(runAutonomousDecisions.createdAt, period.until),
      ),
    );

  return counts;
}

export async function getRecentAutonomousDecisions(
  db: Db,
  runId: string,
  projectId: string,
) {
  const decisions = await db
    .select({
      id: runAutonomousDecisions.id,
      action: runAutonomousDecisions.action,
      phase: runAutonomousDecisions.phase,
      reason: runAutonomousDecisions.reason,
      at: runAutonomousDecisions.createdAt,
      deliveredCommit: sql<
        string | null
      >`${runAutonomousDecisions.witness}->>'deliveredCommit'`,
      repoUrl: projects.repoUrl,
      archivedAt: projects.archivedAt,
      verifiedReversals:
        sql<number>`(SELECT count(*) FROM ${runAutonomousReversals}
        WHERE ${runAutonomousReversals.decisionId} = ${runAutonomousDecisions.id})`.mapWith(
          Number,
        ),
    })
    .from(runAutonomousDecisions)
    .innerJoin(projects, eq(projects.id, runAutonomousDecisions.projectId))
    .where(
      and(
        eq(runAutonomousDecisions.runId, runId),
        eq(runAutonomousDecisions.projectId, projectId),
      ),
    )
    .orderBy(
      desc(runAutonomousDecisions.createdAt),
      desc(runAutonomousDecisions.id),
    )
    .limit(5);

  return decisions.map(
    ({ deliveredCommit, repoUrl, archivedAt, ...decision }) => ({
      ...decision,
      canReportReversal:
        decision.phase === "observed" &&
        decision.action !== "fail" &&
        !archivedAt &&
        !!repoUrl &&
        normalizePublicationOrigin(repoUrl)?.startsWith("github.com/") ===
          true &&
        deliveredCommit !== null &&
        GIT_OBJECT_ID.test(deliveredCommit),
    }),
  );
}

export async function getCurrentReviewRefusals(
  db: Db,
  runIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (runIds.length === 0) return new Map();
  const results = await db
    .selectDistinctOn([runAutonomousDecisions.runId], {
      runId: runAutonomousDecisions.runId,
      reason: runAutonomousDecisions.reason,
      phase: runAutonomousDecisions.phase,
    })
    .from(runAutonomousDecisions)
    .innerJoin(
      runs,
      and(
        eq(runs.id, runAutonomousDecisions.runId),
        eq(runs.projectId, runAutonomousDecisions.projectId),
      ),
    )
    .where(
      and(
        inArray(runAutonomousDecisions.runId, runIds),
        eq(runs.status, "Review"),
        or(
          gte(runAutonomousDecisions.createdAt, runs.reviewEnteredAt),
          // A refused failure enters Review without a promotable Review epoch.
          and(
            isNull(runs.reviewEnteredAt),
            or(
              eq(runAutonomousDecisions.action, "fail"),
              eq(runAutonomousDecisions.reason, "pr_conflict_action_required"),
            ),
            gte(runAutonomousDecisions.createdAt, runs.endedAt),
          ),
        ),
      ),
    )
    .orderBy(
      runAutonomousDecisions.runId,
      desc(runAutonomousDecisions.createdAt),
      desc(runAutonomousDecisions.id),
    );

  return new Map(
    results
      .filter((entry) => entry.phase === "refused")
      .map((entry) => [entry.runId, entry.reason]),
  );
}
