import "server-only";

import type { DeliveryRunKind } from "@/lib/observatory/run-kind";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { ObservatoryRunKind } from "@/lib/observatory/run-kind";
import type { RunOutcomeBucket } from "@/lib/runs/outcome-bucket";
import type { SQL } from "drizzle-orm";

import { sql } from "drizzle-orm";
import pino from "pino";

import * as schema from "@/lib/db/schema";
import { DELIVERY_RUN_KINDS } from "@/lib/observatory/run-kind";
import {
  IN_FLIGHT_OUTCOME_BUCKETS,
  RUN_OUTCOME_BUCKETS,
  isRunOutcomeBucket,
  latestWorkspaceLateralSql,
  runOutcomeBucketSql,
  runSettledSql,
} from "@/lib/runs/outcome-bucket";
import { isDeliveryRunKind } from "@/lib/observatory/run-kind";

/**
 * The Observatory overview read model (ADR-178 D2/D3/D4).
 *
 * Two grouped SELECTs — runs by `(project_id, run_kind, bucket)` and tasks by
 * `project_id` — plus one more for the project page's sub-rows. The count is
 * FIXED: an N+1 over the project list is invisible in the returned DTO, so the
 * grouping happens in the database rather than in a loop here.
 *
 * Read-only (ADR-059): no write, no git call, no new table.
 */

const log = pino({
  name: "observatory-overview",
  level: process.env.LOG_LEVEL ?? "info",
});

export interface OverviewCounts {
  tasksInWork: number;
  tasksStarted: number;
  runs: Record<DeliveryRunKind, number>;
  buckets: Record<RunOutcomeBucket, number>;
}

export type OverviewRowIdentity =
  | {
      kind: "project";
      projectId: string;
      projectSlug: string;
      projectName: string;
    }
  | { kind: "platform" }
  | { kind: "flow"; flowRefId: string }
  | { kind: "runKind"; runKind: DeliveryRunKind };

export interface OverviewRow {
  /** Stable render + test key (`project:<slug>`, `flow:<ref>`, `kind:<kind>`). */
  key: string;
  identity: OverviewRowIdentity;
  counts: OverviewCounts;
}

export interface OverviewTable {
  rows: OverviewRow[];
  /** Project-less runs, for a global admin only, and only when non-empty. */
  platform: OverviewRow | null;
  /** Sub-rows of the single project in scope (project page only). */
  subRows: OverviewRow[];
  totals: OverviewCounts;
  /** At least one in-flight run — the counts can still move (ADR-059). */
  volatile: boolean;
}

export interface OverviewScopeProject {
  id: string;
  slug: string;
  name: string;
}

export interface OverviewInput {
  since: Date;
  until: Date;
  runKind: ObservatoryRunKind;
  /** D4: the project-less group is read ONLY for a global admin. */
  includePlatform: boolean;
  /** Project page: also group by flow ref and by flow-less run kind. */
  includeBreakdown: boolean;
}

const PLATFORM_KEY = "__platform__";

type RunGroupRow = {
  project_id: string | null;
  run_kind: string;
  bucket: string;
  run_count: string | number;
};

type TaskGroupRow = {
  project_id: string;
  tasks_in_work: string | number;
  tasks_started: string | number;
};

type BreakdownRow = {
  flow_ref_id: string | null;
  run_kind: string;
  bucket: string;
  run_count: string | number;
};

/**
 * How many runs of these counts are still in flight?
 *
 * Derived from `IN_FLIGHT_OUTCOME_BUCKETS`, never from a hand-written sum: the
 * volatility flag and the live band answer the same question, and a sixth
 * in-flight bucket must not update one of them and silently under-count the
 * other.
 */
export function inFlightTotal(counts: OverviewCounts): number {
  return IN_FLIGHT_OUTCOME_BUCKETS.reduce(
    (total, bucket) => total + counts.buckets[bucket],
    0,
  );
}

export function emptyOverviewCounts(): OverviewCounts {
  return {
    tasksInWork: 0,
    tasksStarted: 0,
    runs: Object.fromEntries(
      DELIVERY_RUN_KINDS.map((kind) => [kind, 0]),
    ) as Record<DeliveryRunKind, number>,
    buckets: Object.fromEntries(
      RUN_OUTCOME_BUCKETS.map((bucket) => [bucket, 0]),
    ) as Record<RunOutcomeBucket, number>,
  };
}

export function emptyOverviewTable(): OverviewTable {
  return {
    rows: [],
    platform: null,
    subRows: [],
    totals: emptyOverviewCounts(),
    volatile: false,
  };
}

export async function getObservatoryOverview(
  client: NodePgDatabase<typeof schema>,
  scope: readonly OverviewScopeProject[],
  input: OverviewInput,
): Promise<OverviewTable> {
  if (scope.length === 0 && !input.includePlatform) {
    return emptyOverviewTable();
  }

  const [runRows, taskRows, breakdownRows] = await Promise.all([
    selectRunGroups(client, scope, input),
    selectTaskGroups(client, scope, input),
    input.includeBreakdown
      ? selectBreakdownGroups(client, scope, input)
      : Promise.resolve([] as BreakdownRow[]),
  ]);

  const byProject = new Map<string, OverviewCounts>(
    scope.map((project) => [project.id, emptyOverviewCounts()]),
  );
  const platformCounts = emptyOverviewCounts();
  let platformSeen = false;

  for (const row of runRows) {
    const counts =
      row.project_id === null
        ? ((platformSeen = true), platformCounts)
        : byProject.get(row.project_id);

    if (!counts) continue;
    applyRunGroup(counts, row);
  }

  for (const row of taskRows) {
    const counts = byProject.get(row.project_id);

    if (!counts) continue;
    counts.tasksInWork = toCount(row.tasks_in_work);
    counts.tasksStarted = toCount(row.tasks_started);
  }

  const rows: OverviewRow[] = [...scope]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((project) => ({
      key: `project:${project.slug}`,
      identity: {
        kind: "project" as const,
        projectId: project.id,
        projectSlug: project.slug,
        projectName: project.name,
      },
      counts: byProject.get(project.id) ?? emptyOverviewCounts(),
    }));
  const platform: OverviewRow | null = platformSeen
    ? {
        key: PLATFORM_KEY,
        identity: { kind: "platform" },
        counts: platformCounts,
      }
    : null;
  const totals = sumCounts([
    ...rows.map((row) => row.counts),
    ...(platform ? [platform.counts] : []),
  ]);

  log.debug(
    {
      projectCount: scope.length,
      since: input.since,
      until: input.until,
      runKind: input.runKind,
      includePlatform: input.includePlatform,
      groupCount: runRows.length + taskRows.length + breakdownRows.length,
      queryCount: input.includeBreakdown ? 3 : 2,
    },
    "observatory overview grouped",
  );

  return {
    rows,
    platform,
    subRows: buildSubRows(breakdownRows),
    totals,
    volatile: inFlightTotal(totals) > 0,
  };
}

function applyRunGroup(
  counts: OverviewCounts,
  row: { run_kind: string; bucket: string; run_count: string | number },
): void {
  const count = toCount(row.run_count);

  if (isDeliveryRunKind(row.run_kind)) counts.runs[row.run_kind] += count;
  if (isRunOutcomeBucket(row.bucket)) counts.buckets[row.bucket] += count;
}

function buildSubRows(rows: readonly BreakdownRow[]): OverviewRow[] {
  const byKey = new Map<string, OverviewRow>();

  for (const row of rows) {
    // A flow run groups by its flow ref; scratch and agent have none, so they
    // become one sub-row per kind.
    const identity: OverviewRowIdentity =
      row.run_kind === "flow" && row.flow_ref_id !== null
        ? { kind: "flow", flowRefId: row.flow_ref_id }
        : {
            kind: "runKind",
            runKind: isDeliveryRunKind(row.run_kind) ? row.run_kind : "flow",
          };
    const key =
      identity.kind === "flow"
        ? `flow:${identity.flowRefId}`
        : `kind:${identity.runKind}`;
    const existing = byKey.get(key) ?? {
      key,
      identity,
      counts: emptyOverviewCounts(),
    };

    applyRunGroup(existing.counts, row);
    byKey.set(key, existing);
  }

  // Flow sub-rows first (alphabetical), then the flow-less kinds in their
  // canonical order — a stable order the table and its tests can both rely on.
  return [...byKey.values()].sort((left, right) => {
    if (left.identity.kind !== right.identity.kind) {
      return left.identity.kind === "flow" ? -1 : 1;
    }
    if (left.identity.kind === "flow" && right.identity.kind === "flow") {
      return left.identity.flowRefId.localeCompare(right.identity.flowRefId);
    }
    if (left.identity.kind === "runKind" && right.identity.kind === "runKind") {
      return (
        DELIVERY_RUN_KINDS.indexOf(left.identity.runKind) -
        DELIVERY_RUN_KINDS.indexOf(right.identity.runKind)
      );
    }

    return 0;
  });
}

function sumCounts(all: readonly OverviewCounts[]): OverviewCounts {
  return all.reduce<OverviewCounts>((total, counts) => {
    total.tasksInWork += counts.tasksInWork;
    total.tasksStarted += counts.tasksStarted;
    for (const kind of DELIVERY_RUN_KINDS) {
      total.runs[kind] += counts.runs[kind];
    }
    for (const bucket of RUN_OUTCOME_BUCKETS) {
      total.buckets[bucket] += counts.buckets[bucket];
    }

    return total;
  }, emptyOverviewCounts());
}

function toCount(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);

  return Number.isFinite(parsed) ? parsed : 0;
}

function idList(scope: readonly OverviewScopeProject[]): SQL {
  return sql.join(
    scope.map((project) => sql`${project.id}`),
    sql`, `,
  );
}

/** Visibility first: the scope ids, plus the project-less group when allowed. */
function scopePredicate(
  scope: readonly OverviewScopeProject[],
  includePlatform: boolean,
): SQL {
  if (scope.length === 0) return sql`r.project_id IS NULL`;

  const inScope = sql`r.project_id IN (${idList(scope)})`;

  return includePlatform ? sql`(${inScope} OR r.project_id IS NULL)` : inScope;
}

function runKindPredicate(runKind: ObservatoryRunKind): SQL {
  return runKind === "all" ? sql`TRUE` : sql`r.run_kind = ${runKind}`;
}

function bucketExpression(): SQL {
  return runOutcomeBucketSql({
    status: sql`r.status`,
    promotionState: sql`w.promotion_state`,
    promotionMode: sql`w.promotion_mode`,
    prState: sql`w.pr_state`,
    removedAt: sql`w.removed_at`,
  });
}

async function selectRunGroups(
  client: NodePgDatabase<typeof schema>,
  scope: readonly OverviewScopeProject[],
  input: OverviewInput,
): Promise<RunGroupRow[]> {
  const result = await client.execute(sql`
    SELECT r.project_id,
           r.run_kind,
           ${bucketExpression()} AS bucket,
           count(*) AS run_count
    FROM runs r
    ${latestWorkspaceLateralSql("r")}
    WHERE ${scopePredicate(scope, input.includePlatform)}
      AND r.started_at >= ${input.since}
      AND r.started_at < ${input.until}
      AND ${runKindPredicate(input.runKind)}
    GROUP BY r.project_id, r.run_kind, bucket
  `);

  return (result.rows ?? []) as RunGroupRow[];
}

/**
 * D2. One aggregate over each task's flow runs, so the "in work" overlap and
 * the "taken into work" first-launch rule share a single pass.
 *
 * `min(started_at)` is taken over ALL of a task's flow runs, not only the
 * in-window ones: a task relaunched inside the period was taken into work when
 * its FIRST run started, which may be long before `since`.
 *
 * "Settled" is asked of the D3 classifier (`runSettledSql`), not of a second
 * status list — so a `Review` / `Crashed` run whose workspace was REMOVED
 * closes its task's interval, exactly as it already counts in the `Abandoned`
 * column. Without that, one discarded crash kept its task in "in work" in every
 * future window, forever.
 *
 * A settled run with no `ended_at` is treated as still open — we cannot prove
 * when it settled, and claiming it settled before `since` would silently drop
 * the task from the period.
 *
 * Interval arithmetic: `[started_at, settled_at)` overlaps `[since, until)`
 * when `started_at < until AND settled_at > since`. Both bounds are strict —
 * a run that settled exactly at `since` belongs to the PREVIOUS period, and
 * `>=` would have let it count in both.
 *
 * KNOWN SCALING CHARACTERISTIC (ADR-059): the inner aggregate is deliberately
 * unbounded in time, because `min(started_at)` has to see a task's whole
 * history to know when it was taken into work. It therefore grows with the
 * scoped projects' total flow-run count, not with the period — and it carries
 * the latest-workspace lateral across that whole set, because the settled test
 * reads `removed_at`. An index (or a `tasks.first_run_started_at` column)
 * becomes an explicit migration task if volume proves the need; it is not one
 * today.
 */
async function selectTaskGroups(
  client: NodePgDatabase<typeof schema>,
  scope: readonly OverviewScopeProject[],
  input: OverviewInput,
): Promise<TaskGroupRow[]> {
  if (scope.length === 0) return [];

  const settled = runSettledSql({
    status: sql`r.status`,
    promotionState: sql`w.promotion_state`,
    promotionMode: sql`w.promotion_mode`,
    prState: sql`w.pr_state`,
    removedAt: sql`w.removed_at`,
  });
  const result = await client.execute(sql`
    SELECT t.project_id,
           count(*) FILTER (WHERE t.in_work) AS tasks_in_work,
           count(*) FILTER (
             WHERE t.first_started_at >= ${input.since}
               AND t.first_started_at < ${input.until}
           ) AS tasks_started
    FROM (
      SELECT r.task_id,
             r.project_id,
             min(r.started_at) AS first_started_at,
             bool_or(
               r.started_at < ${input.until}
               AND (
                 NOT (${settled})
                 OR r.ended_at IS NULL
                 OR r.ended_at > ${input.since}
               )
             ) AS in_work
      FROM runs r
      ${latestWorkspaceLateralSql("r")}
      WHERE r.run_kind = 'flow'
        AND r.task_id IS NOT NULL
        AND r.project_id IN (${idList(scope)})
      GROUP BY r.task_id, r.project_id
    ) t
    GROUP BY t.project_id
  `);

  return (result.rows ?? []) as TaskGroupRow[];
}

async function selectBreakdownGroups(
  client: NodePgDatabase<typeof schema>,
  scope: readonly OverviewScopeProject[],
  input: OverviewInput,
): Promise<BreakdownRow[]> {
  if (scope.length === 0) return [];

  const result = await client.execute(sql`
    SELECT f.flow_ref_id,
           r.run_kind,
           ${bucketExpression()} AS bucket,
           count(*) AS run_count
    FROM runs r
    LEFT JOIN flows f ON f.id = r.flow_id
    ${latestWorkspaceLateralSql("r")}
    WHERE r.project_id IN (${idList(scope)})
      AND r.started_at >= ${input.since}
      AND r.started_at < ${input.until}
      AND ${runKindPredicate(input.runKind)}
    GROUP BY f.flow_ref_id, r.run_kind, bucket
  `);

  return (result.rows ?? []) as BreakdownRow[];
}
