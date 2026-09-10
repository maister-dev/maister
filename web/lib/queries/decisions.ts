import "server-only";

/**
 * The cross-project decision queue and the `decisions` counter (ADR-168).
 *
 * Four populations, one list, one number: respondable HITL, mechanically
 * promotable runs, `Crashed` runs owing recover/discard, and triage-flagged
 * tasks. Everything here is answerable, promotable, recoverable or clearable by
 * the reader NOW — which is what earns the badge its attention tone (D7).
 *
 * The count is the length of the list, derived from the same read (D8). A
 * separate `COUNT(*)` would be cheaper and would be free to disagree with the
 * list it labels, which is precisely the bug the one-number rule exists to
 * prevent.
 */

import type { GlobalRole } from "@/lib/db/schema";
import type { ClassifiedPromotable } from "@/lib/ext-activity/promotable";
import type {
  CrashedDecisionItem,
  FlaggedDecisionItem,
} from "@/lib/queries/decision-sources";
import type { CrossProjectHitlItem } from "@/lib/queries/portfolio";
import type { WorkStage } from "@/lib/work/stage";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { inArray } from "drizzle-orm";
import { cache } from "react";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { listPromotableForProjects } from "@/lib/ext-activity/promotable";
import {
  listCrashedForProjects,
  listFlaggedForProjects,
} from "@/lib/queries/decision-sources";
import { getCrossProjectHitlInbox } from "@/lib/queries/portfolio";
import { getVisibleProjectIds } from "@/lib/queries/visible-projects";
import { getOpenRelationBlockers } from "@/lib/social/relations";

const { projects } = schema;

const log = pino({
  name: "queries-decisions",
  level: process.env.LOG_LEVEL ?? "info",
});

export const DECISION_KINDS = [
  "hitl",
  "crashed",
  "promotable",
  "flagged",
] as const;

export type DecisionKind = (typeof DECISION_KINDS)[number];

export type DecisionCriticality = "low" | "medium" | "high" | "critical";

/** The subset the comparator reads — nothing else may influence the order. */
export interface DecisionOrderKey {
  kind: DecisionKind;
  criticality: DecisionCriticality | null;
  since: Date | null;
  id: string;
}

export interface DecisionBase extends DecisionOrderKey {
  /**
   * Where the work sits in the ADR-169 vocabulary. Derived from the kind, not
   * re-derived per surface: a decision-queue item is by definition parked at
   * exactly one of these four stages, and every surface must name it the same.
   */
  stage: WorkStage;
  projectId: string;
  projectSlug: string;
  projectName: string;
  taskId: string | null;
  taskKey: string | null;
  taskTitle: string | null;
  runId: string | null;
}

export type DecisionItem =
  | (DecisionBase & { kind: "hitl"; hitl: CrossProjectHitlItem })
  | (DecisionBase & { kind: "crashed"; crashed: CrashedDecisionItem })
  | (DecisionBase & { kind: "promotable"; promotable: ClassifiedPromotable })
  | (DecisionBase & { kind: "flagged"; flagged: FlaggedDecisionItem });

export interface DecisionsQueue {
  items: DecisionItem[];
  count: number;
}

export interface DecisionsScope {
  /** Narrows to one project, intersected with visibility — never widens it. */
  projectId?: string;
}

const CRITICALITY_RANK = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
} as const satisfies Record<DecisionCriticality, number>;

// ADR-168 D6: the non-HITL kinds carry a FIXED rank on the same scale. They have
// no criticality of their own, and `tasks.priority` is deliberately not
// consulted — it governs admission, and borrowing it here would create a second
// ordering authority over the same queue.
const NON_HITL_RANK = {
  crashed: CRITICALITY_RANK.high,
  promotable: CRITICALITY_RANK.medium,
  flagged: CRITICALITY_RANK.low,
} as const satisfies Record<Exclude<DecisionKind, "hitl">, number>;

export function decisionRank(
  key: Pick<DecisionOrderKey, "kind" | "criticality">,
): number {
  // A null criticality ranks WITH medium — below an explicitly raised item,
  // above an explicitly lowered one. Ranking it last would bury every HITL row
  // that no one bothered to grade, which is most of them.
  return key.kind === "hitl"
    ? CRITICALITY_RANK[key.criticality ?? "medium"]
    : NON_HITL_RANK[key.kind];
}

export function compareDecisions(
  a: DecisionOrderKey,
  b: DecisionOrderKey,
): number {
  const byRank = decisionRank(b) - decisionRank(a);

  if (byRank !== 0) return byRank;

  const at = a.since?.getTime() ?? null;
  const bt = b.since?.getTime() ?? null;

  if (at !== bt) {
    // An unknown age sorts LAST within its rank: "we do not know how long this
    // has waited" is not evidence that it has waited longest.
    if (at === null) return 1;
    if (bt === null) return -1;

    return at - bt;
  }

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const STAGE_BY_KIND = {
  hitl: "WaitingOnHuman",
  crashed: "Crashed",
  promotable: "Review",
  flagged: "Held",
} as const satisfies Record<DecisionKind, WorkStage>;

function isCriticality(value: string | null): value is DecisionCriticality {
  return value !== null && value in CRITICALITY_RANK;
}

/**
 * React-`cache`d so every server component of ONE render reads the same answer
 * (ATN-05) — the same mechanism `getPlatformStatus` uses for the chrome. The
 * layout, the home page and the inbox page each call it; the work happens once.
 */
export const getDecisionsQueue = cache(async function getDecisionsQueue(
  userId: string,
  globalRole: GlobalRole,
  scope: DecisionsScope = {},
): Promise<DecisionsQueue> {
  const startedAt = Date.now();
  const client = getDb() as NodePgDatabase<typeof schema>;
  const visibleIds = await getVisibleProjectIds(userId, globalRole, client);
  const projectIds =
    scope.projectId === undefined
      ? visibleIds
      : visibleIds.filter((id) => id === scope.projectId);

  if (projectIds.length === 0) return { items: [], count: 0 };

  const [projectRows, hitlInbox, promotable, crashed, flagged] =
    await Promise.all([
      client
        .select({ id: projects.id, slug: projects.slug, name: projects.name })
        .from(projects)
        .where(inArray(projects.id, projectIds)),
      getCrossProjectHitlInbox(userId, globalRole),
      listPromotableForProjects(projectIds, { db: client }),
      listCrashedForProjects(projectIds, { db: client }),
      listFlaggedForProjects(projectIds, { db: client }),
    ]);
  const projectById = new Map(projectRows.map((row) => [row.id, row]));

  function project(projectId: string): { slug: string; name: string } {
    return projectById.get(projectId) ?? { slug: projectId, name: projectId };
  }

  const unfiltered: DecisionItem[] = [
    ...hitlInbox.items.map(
      (item): DecisionItem => ({
        kind: "hitl",
        stage: STAGE_BY_KIND.hitl,
        id: `hitl:${item.hitlRequestId}`,
        projectId: item.projectId,
        projectSlug: item.projectSlug,
        projectName: item.projectName,
        taskId: item.taskId,
        taskKey: item.taskRef,
        taskTitle: item.taskTitle,
        runId: item.runId,
        criticality: isCriticality(item.criticality) ? item.criticality : null,
        since: new Date(item.createdAt),
        hitl: item,
      }),
    ),
    ...crashed.map(
      (item): DecisionItem => ({
        kind: "crashed",
        stage: STAGE_BY_KIND.crashed,
        id: `crashed:${item.runId}`,
        projectId: item.projectId,
        projectSlug: item.projectSlug,
        projectName: project(item.projectId).name,
        taskId: item.taskId,
        taskKey: item.taskKey,
        taskTitle: item.taskTitle,
        runId: item.runId,
        criticality: null,
        since: item.crashedAt,
        crashed: item,
      }),
    ),
    ...promotable.map(
      (item): DecisionItem => ({
        kind: "promotable",
        stage: STAGE_BY_KIND.promotable,
        id: `promotable:${item.runId}`,
        projectId: item.projectId,
        projectSlug: project(item.projectId).slug,
        projectName: project(item.projectId).name,
        taskId: item.taskId,
        taskKey: item.taskKey,
        taskTitle: item.taskTitle,
        runId: item.runId,
        criticality: null,
        since: item.inReviewSince,
        promotable: item,
      }),
    ),
    ...flagged.map(
      (item): DecisionItem => ({
        kind: "flagged",
        stage: STAGE_BY_KIND.flagged,
        id: `flagged:${item.taskId}`,
        projectId: item.projectId,
        projectSlug: item.projectSlug,
        projectName: project(item.projectId).name,
        taskId: item.taskId,
        taskKey: item.taskKey,
        taskTitle: item.taskTitle,
        runId: null,
        criticality: null,
        since: item.flaggedAt,
        flagged: item,
      }),
    ),
  ];

  // ADR-168 D5: a task held by a blocking relation looks like it needs a human
  // and does not — nothing the reader can do advances it until its blocker
  // moves. It belongs to a `/work` filter, not to a badge.
  const taskIds = [
    ...new Set(
      unfiltered.flatMap((item) => (item.taskId ? [item.taskId] : [])),
    ),
  ];
  const blockersByTask = await getOpenRelationBlockers(taskIds, client);
  const items = unfiltered
    .filter(
      (item) =>
        item.taskId === null ||
        (blockersByTask.get(item.taskId)?.length ?? 0) === 0,
    )
    .sort(compareDecisions);

  log.debug(
    {
      userId,
      projectCount: projectIds.length,
      hitlCount: hitlInbox.items.length,
      promotableCount: promotable.length,
      crashedCount: crashed.length,
      flaggedCount: flagged.length,
      blockedOut: unfiltered.length - items.length,
      count: items.length,
      elapsedMs: Date.now() - startedAt,
    },
    "decisions queue",
  );

  return { items, count: items.length };
});

/**
 * The canonical `decisions` number. Deliberately the length of the same list
 * every surface renders rather than its own `COUNT(*)` — see D8.
 */
export async function getDecisionsCount(
  userId: string,
  globalRole: GlobalRole,
  scope: DecisionsScope = {},
): Promise<number> {
  return (await getDecisionsQueue(userId, globalRole, scope)).count;
}
