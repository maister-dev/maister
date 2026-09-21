import type { RunStatusValue } from "@/lib/runs/run-status-values";
import type { SQL } from "drizzle-orm";
import type { WorkInFlightStage } from "@/lib/work/stage";

import { sql } from "drizzle-orm";

import { RUN_STATUS_VALUES } from "@/lib/runs/run-status-values";

/**
 * The ONE run-outcome classification (ADR-177 D3).
 *
 * Every run falls into exactly one bucket. The in-flight five ARE
 * `WORK_IN_FLIGHT_STAGES` by name, so the Desk (ADR-172) and the Observatory
 * never carry two words for one state; the settled five refine `WorkStage`'s
 * `Promoted`/`Abandoned`/`Ready(Failed)` with the promotion and PR-lifecycle
 * facts (ADR-140/141) that `WorkStage` deliberately does not carry.
 *
 * Nothing here is persisted (the M51 `STG` rule). The SQL fragment below is
 * GENERATED from the same map the TypeScript union uses, so a cell's count in
 * the Observatory and the `/runs` list it opens cannot disagree.
 *
 * Deliberately NOT `server-only`: the bucket names are link vocabulary that
 * client components build hrefs from.
 */

export const IN_FLIGHT_OUTCOME_BUCKETS = [
  "Queued",
  "Executing",
  "WaitingOnHuman",
  "Review",
  "Crashed",
] as const satisfies readonly WorkInFlightStage[];

export const SETTLED_OUTCOME_BUCKETS = [
  "Delivered",
  "PrOpen",
  "ResultOnly",
  "Failed",
  "Abandoned",
] as const;

export const RUN_OUTCOME_BUCKETS = [
  ...IN_FLIGHT_OUTCOME_BUCKETS,
  ...SETTLED_OUTCOME_BUCKETS,
] as const;

export type RunOutcomeBucket = (typeof RUN_OUTCOME_BUCKETS)[number];

// The exhaustive axis. `satisfies Record<RunStatusValue, RunOutcomeBucket>`
// makes a twelfth run status a COMPILE error here, mirroring
// `STAGE_BY_RUN_STATUS` — the alternative is a run that silently belongs to no
// column and vanishes from a total.
//
// `Done` maps to `Delivered` as its BASE; the two refinement arms below split
// it by promotion state and PR lifecycle.
export const BUCKET_BY_RUN_STATUS = {
  Pending: "Queued",
  Running: "Executing",
  WaitingOnChildren: "Executing",
  NeedsInput: "WaitingOnHuman",
  NeedsInputIdle: "WaitingOnHuman",
  HumanWorking: "WaitingOnHuman",
  Review: "Review",
  Crashed: "Crashed",
  Done: "Delivered",
  Failed: "Failed",
  Abandoned: "Abandoned",
} as const satisfies Record<RunStatusValue, RunOutcomeBucket>;

const OUTCOME_BUCKET_SET: ReadonlySet<string> = new Set(RUN_OUTCOME_BUCKETS);

export function isRunOutcomeBucket(value: string): value is RunOutcomeBucket {
  return OUTCOME_BUCKET_SET.has(value);
}

export interface RunOutcomeBucketColumns {
  status: SQL;
  promotionState: SQL;
  promotionMode: SQL;
  prState: SQL;
  removedAt: SQL;
}

/**
 * The run's LATEST workspace row.
 *
 * `workspaces.run_id` is not unique (a rework claim, a re-adopt), and the
 * `/runs` ledger already reads its `branch` through exactly this lateral — so
 * both surfaces classify from the same row. An older promoted row must not
 * outvote a newer removed one.
 */
export function latestWorkspaceLateralSql(runAlias: string): SQL {
  return sql`
    LEFT JOIN LATERAL (
      SELECT w.branch, w.promotion_state, w.promotion_mode, w.pr_state, w.removed_at
      FROM workspaces w
      WHERE w.run_id = ${sql.raw(runAlias)}.id
      ORDER BY w.created_at DESC, w.id ASC
      LIMIT 1
    ) w ON true
  `;
}

/**
 * Is this run SETTLED — i.e. does its outcome bucket sit in the settled five?
 *
 * The task-overlap rule (ADR-177 D2) closes a run's in-work interval exactly
 * when the run stops being in flight, so it asks the D3 classifier rather than
 * keeping its own status list. That list used to say `Review` and `Crashed` are
 * never settled; D3 already says a `Review` / `Crashed` run whose workspace was
 * REMOVED is `Abandoned` — historical evidence, the board's own rule. Two
 * answers to one question is the drift this module exists to prevent, so there
 * is now one: a task is in work while at least one of its flow runs is in an
 * in-flight bucket, and a removed workspace closes that interval on both axes.
 *
 * Total by construction: `runOutcomeBucketSql` emits an arm for every
 * `RUN_STATUS_VALUES` member, so the CASE is never NULL for a real row.
 */
export function runSettledSql(cols: RunOutcomeBucketColumns): SQL {
  return sql`${runOutcomeBucketSql(cols)} IN (${sql.join(
    SETTLED_OUTCOME_BUCKETS.map((bucket) => sql`${bucket}`),
    sql`, `,
  )})`;
}

/**
 * The ADR-177 D3 `CASE` fragment, generated from `BUCKET_BY_RUN_STATUS` plus the
 * two refinements the status map cannot express. Generated rather than written
 * out so TS and SQL cannot drift.
 */
export function runOutcomeBucketSql(cols: RunOutcomeBucketColumns): SQL {
  const { status, promotionState, promotionMode, prState, removedAt } = cols;

  // Order matters: the refinements are tested BEFORE the plain status map, so a
  // refined row never falls through to its base bucket.
  const refinements: SQL[] = [
    // A user-removed workspace turns a parked Review/Crashed result into
    // historical evidence (the board's rule in deriveStage / deriveWorkStage).
    sql`WHEN ${status} IN ('Review', 'Crashed') AND ${removedAt} IS NOT NULL THEN 'Abandoned'`,
    // ADR-165 result-only completion, and agent runs with no worktree at all.
    sql`WHEN ${status} = 'Done' AND (${promotionState} IS NULL OR ${promotionState} = 'none') THEN 'ResultOnly'`,
    // A PR that was closed without merging is abandoned work, not delivery.
    sql`WHEN ${status} = 'Done' AND ${promotionMode} = 'pull_request' AND ${prState} = 'closed' THEN 'Abandoned'`,
    // NULL pr_state = never scanned by pr_state_scan (ADR-140) — an unscanned
    // PR is not evidence of a merge.
    sql`WHEN ${status} = 'Done' AND ${promotionMode} = 'pull_request' AND (${prState} IS NULL OR ${prState} = 'open') THEN 'PrOpen'`,
  ];
  const statusArms = RUN_STATUS_VALUES.map(
    (value) =>
      sql`WHEN ${status} = ${value} THEN ${BUCKET_BY_RUN_STATUS[value]}`,
  );

  return sql`CASE ${sql.join([...refinements, ...statusArms], sql` `)} END`;
}
