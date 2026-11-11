import "server-only";

import type { SQL } from "drizzle-orm";
import type { SqlTransaction } from "@/lib/db/sql-types";
import type { AssignmentWorkBounds } from "./work-types";
import type { DelegationBounds } from "@/lib/run-results/types";

import { sql } from "drizzle-orm";
import pino from "pino";
import { z } from "zod";

import { assignmentWorkBoundsSchema } from "./work-types";

import { MaisterError } from "@/lib/errors";
import {
  orchestratorMaxDepth,
  orchestratorMaxFanout,
} from "@/lib/instance-config";
import { readAncestorDelegationBounds } from "@/lib/orchestrator/admission";
import { baseTokenSumExpr } from "@/lib/runs/cost-rollups";
import {
  FAILURE_TERMINAL_RUN_STATUSES,
  SLOT_HOLDING_RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
} from "@/lib/runs/run-status-sets";

const log = pino({
  name: "specialist-intake:budget",
  level: process.env.LOG_LEVEL ?? "info",
});

const holdingOrPending = [...SLOT_HOLDING_RUN_STATUSES, "Pending"];
const counts = z.object({
  child_runs: z.coerce.number().int().nonnegative(),
  active_children: z.coerce.number().int().nonnegative(),
  tokens: z.coerce.number().int().nonnegative(),
  elapsed_minutes: z.coerce.number().finite().nonnegative(),
  consecutive_failures: z.coerce.number().int().nonnegative(),
});

type BudgetInput = Readonly<{
  assignmentId: string;
  parentRunId: string;
  rootRunId: string;
  requested: AssignmentWorkBounds;
  reservedRunId?: string;
}>;

/** Read existing assignment work and usage while the caller holds the assignment write fence. */
export async function admitAssignmentWorkBudget(
  tx: SqlTransaction,
  input: BudgetInput,
): Promise<AssignmentWorkBounds> {
  const { assignmentId, parentRunId, rootRunId, requested, reservedRunId } =
    input;
  const [retained] = (await tx.execute(retainedBoundsSql(sql`${assignmentId}`)))
    .rows;
  const ancestors = await readAncestorDelegationBounds(tx, parentRunId);
  const minimum = (
    key: Exclude<keyof AssignmentWorkBounds, "schemaVersion">,
    ceiling: (ancestor: DelegationBounds) => number | null | undefined,
  ): number =>
    Math.min(
      requested[key],
      Number(retained?.[key] ?? requested[key]),
      ...ancestors.map((ancestor) => ceiling(ancestor) ?? requested[key]),
    );
  const bounds = assignmentWorkBoundsSchema.parse({
    schemaVersion: 1,
    maxDepth: Math.min(
      orchestratorMaxDepth(),
      minimum("maxDepth", (ancestor) => ancestor.maxDepth),
    ),
    maxFanout: Math.min(
      orchestratorMaxFanout(),
      minimum("maxFanout", (ancestor) => ancestor.maxFanout),
    ),
    maxActiveChildren: minimum(
      "maxActiveChildren",
      (ancestor) => ancestor.maxActiveChildren,
    ),
    maxChildRuns: minimum(
      "maxChildRuns",
      (ancestor) => ancestor.budget?.maxChildRuns,
    ),
    maxTokens: minimum("maxTokens", (ancestor) => ancestor.budget?.maxTokens),
    wallClockMinutes: minimum(
      "wallClockMinutes",
      (ancestor) => ancestor.budget?.wallClockMinutes,
    ),
    consecutiveFailures: minimum(
      "consecutiveFailures",
      (ancestor) => ancestor.budget?.consecutiveFailures,
    ),
  });
  const [meters] = (
    await tx.execute(
      assignmentMetersSql(sql`${assignmentId}`, sql`${reservedRunId ?? null}`),
    )
  ).rows;
  const usage = counts.parse(meters);
  const metersAndLimits = [
    ["tokens", bounds.maxTokens],
    ["elapsed_minutes", bounds.wallClockMinutes],
    ["consecutive_failures", bounds.consecutiveFailures],
    ["child_runs", bounds.maxChildRuns],
    ["active_children", bounds.maxActiveChildren],
  ] as const;
  const exhausted = metersAndLimits.find(
    ([meter, limit]) => usage[meter] >= limit,
  );

  if (exhausted) {
    const [meter, limit] = exhausted;
    const current = usage[meter];

    log.warn(
      { assignmentId, parentRunId, rootRunId, meter, current, limit },
      "assignment work budget refused",
    );
    throw new MaisterError(
      "PRECONDITION",
      "The specialist assignment delegation budget is exhausted",
      {
        details: {
          reason: "assignment_budget_exhausted",
          meter,
          current,
          limit,
        },
      },
    );
  }
  log.debug(
    { assignmentId, parentRunId, rootRunId, usage, bounds },
    "assignment work budget admitted",
  );

  return bounds;
}

function retainedBoundsSql(assignmentId: SQL): SQL {
  return sql`
      SELECT
        min((bounds->>'maxDepth')::int) AS "maxDepth",
        min((bounds->>'maxFanout')::int) AS "maxFanout",
        min((bounds->>'maxActiveChildren')::int) AS "maxActiveChildren",
        min((bounds->>'maxChildRuns')::int) AS "maxChildRuns",
        min((bounds->>'maxTokens')::bigint) AS "maxTokens",
        min((bounds->>'wallClockMinutes')::int) AS "wallClockMinutes",
        min((bounds->>'consecutiveFailures')::int) AS "consecutiveFailures"
      FROM specialist_work WHERE assignment_id=${assignmentId}
    `;
}

function assignmentMetersSql(assignmentId: SQL, reservedRunId: SQL): SQL {
  return sql`
      WITH appointments AS (
        SELECT run_id, linked_at, role FROM specialist_run_links WHERE assignment_id=${assignmentId}
      ), children AS (
        SELECT reserved_run_id AS id FROM specialist_work WHERE assignment_id=${assignmentId}
        UNION
        SELECT run_id FROM appointments WHERE role='child'
      ), finished AS (
        SELECT child.status, row_number() OVER (ORDER BY child.ended_at DESC NULLS LAST, child.id DESC) AS ordinal
        FROM children JOIN runs child ON child.id=children.id
        WHERE child.status=ANY(${sql.param(TERMINAL_RUN_STATUSES)}::text[])
      )
      SELECT
        (SELECT count(*) FROM children WHERE id IS DISTINCT FROM ${reservedRunId}) AS child_runs,
        (SELECT count(*) FROM children LEFT JOIN runs child ON child.id=children.id
          WHERE children.id IS DISTINCT FROM ${reservedRunId} AND (child.status=ANY(${sql.param(holdingOrPending)}::text[])
            OR (child.id IS NULL AND EXISTS (
              SELECT 1 FROM specialist_work work
              WHERE work.reserved_run_id=children.id AND work.decision_state='open'
            )))) AS active_children,
        (SELECT count(*) FROM children JOIN runs child ON child.id=children.id
          WHERE children.id IS DISTINCT FROM ${reservedRunId}
            AND child.status=ANY(${sql.param(SLOT_HOLDING_RUN_STATUSES)}::text[])) AS active_slots,
        (SELECT ${baseTokenSumExpr} FROM appointments JOIN run_cost_rollups ON run_cost_rollups.run_id=appointments.run_id) AS tokens,
        (SELECT coalesce(greatest(extract(epoch FROM (clock_timestamp()-min(linked_at)))/60, 0), 0) FROM appointments) AS elapsed_minutes,
        (SELECT count(*) FROM finished
          WHERE ordinal < coalesce((SELECT min(ordinal) FROM finished
            WHERE status<>ALL(${sql.param(FAILURE_TERMINAL_RUN_STATUSES)}::text[])), 9223372036854775807)) AS consecutive_failures
    `;
}

/** Shared scheduler eligibility for appointed work. Pending reservations already own their attempt budget. */
export function assignmentBudgetAllowsDispatchSql(runId: SQL): SQL<boolean> {
  return sql<boolean>`NOT EXISTS (
    SELECT 1 FROM specialist_run_links appointment
    JOIN specialist_assignments assignment ON assignment.id=appointment.assignment_id
    CROSS JOIN LATERAL (${retainedBoundsSql(sql`appointment.assignment_id`)}) limits
    CROSS JOIN LATERAL (${assignmentMetersSql(sql`appointment.assignment_id`, runId)}) usage
    WHERE appointment.run_id=${runId} AND limits."maxTokens" IS NOT NULL AND (
      assignment.status IN ('completed','failed','cancelled')
      OR usage.tokens>=limits."maxTokens"
      OR usage.elapsed_minutes>=limits."wallClockMinutes"
      OR usage.consecutive_failures>=limits."consecutiveFailures"
      OR (appointment.work_witness IS NOT NULL AND (
        usage.active_slots>=limits."maxActiveChildren"
        OR EXISTS (
          SELECT 1 FROM specialist_work work
          JOIN runs parent ON parent.id=work.parent_run_id
          WHERE work.id=appointment.work_id AND work.work_revision=appointment.work_revision
            AND work.child_run_id=appointment.run_id
            AND (work.decision_state<>'open' OR parent.status=ANY(${sql.param(TERMINAL_RUN_STATUSES)}::text[]))
        )
      ))
    )
  )`;
}
