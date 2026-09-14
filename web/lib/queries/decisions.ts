import "server-only";

/**
 * The cross-project decision queue and the `decisions` counter (ADR-169).
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
import { getActionableProjectIds } from "@/lib/queries/visible-projects";
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
   * Where the work sits in the ADR-170 vocabulary. Derived from the kind, not
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

/**
 * What the CALLER asks for. Distinct from `CrossProjectHitlScope`, which is the
 * RESOLVED id set the sources receive: this narrows to one project, that says
 * exactly which projects may contribute after visibility, actionability and
 * this narrowing have all been applied.
 */
export interface DecisionsScope {
  /** Narrows to one project, intersected with reach — never widens it. */
  projectId?: string;
}

const CRITICALITY_RANK = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
} as const satisfies Record<DecisionCriticality, number>;

// ADR-169 D6: the non-HITL kinds carry a FIXED rank on the same scale. They have
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
 * The uncached queue. Callers that live INSIDE one render want
 * `getDecisionsQueue`; callers that run for the lifetime of a request and must
 * see the database move — the attention stream's poll loop — want this one,
 * because a request-scoped memo would freeze their counter at the value it had
 * when the connection opened (ADR-171 D2).
 */
export async function computeDecisionsQueue(
  userId: string,
  globalRole: GlobalRole,
  scope: DecisionsScope = {},
): Promise<DecisionsQueue> {
  const startedAt = Date.now();
  const client = getDb() as NodePgDatabase<typeof schema>;
  // ACTIONABLE, not merely visible (ADR-169 D7). Every one of the four
  // populations asks the reader to DO something — answer, promote, recover or
  // clear — and all four require project `member`. A viewer was being handed
  // items whose inline actions answer 403, which is the opposite of what the
  // attention tone promises.
  const actionableIds = await getActionableProjectIds(
    userId,
    globalRole,
    client,
  );
  const projectIds =
    scope.projectId === undefined
      ? actionableIds
      : actionableIds.filter((id) => id === scope.projectId);

  if (projectIds.length === 0) return { items: [], count: 0 };

  const [projectRows, hitlInbox, promotable, crashed, flagged] =
    await Promise.all([
      client
        .select({ id: projects.id, slug: projects.slug, name: projects.name })
        .from(projects)
        .where(inArray(projects.id, projectIds)),
      // The resolved set goes to ALL FOUR sources. This one would otherwise
      // resolve its own — wider — visibility set, which is what made a
      // project-scoped count include every other project's HITL and a viewer's
      // count include projects they cannot act in.
      getCrossProjectHitlInbox(userId, globalRole, { projectIds }),
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

  // ADR-169 D5: a task held by a blocking relation looks like it needs a human
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
}

/**
 * The HITL entries of the canonical queue, in queue order.
 *
 * Both decision surfaces render HITL cards beside `DecisionSections`, and both
 * used to source them from `getCrossProjectHitlInbox` DIRECTLY — a query that
 * narrows by visibility rather than actionability and drops no
 * relation-blocked task. The cards it produced were therefore outside the
 * `decisions` count printed above them, which is exactly the disagreement
 * `ATN-01` forbids: a viewer saw HITL cards whose actions answer 403, and a
 * blocked task's card was rendered while the badge refused to count it.
 *
 * The queue already carries the whole item, so the second query bought nothing.
 */
export function hitlDecisionsOf(
  items: readonly DecisionItem[],
): CrossProjectHitlItem[] {
  return items.flatMap((item) => (item.kind === "hitl" ? [item.hitl] : []));
}

/**
 * React-`cache`d so every server component of ONE render reads the same answer
 * (ATN-05) — the same mechanism `getPlatformStatus` uses for the chrome. The
 * layout, the home page and the inbox page each call it; the work happens once.
 */
export const getDecisionsQueue = cache(computeDecisionsQueue);

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
