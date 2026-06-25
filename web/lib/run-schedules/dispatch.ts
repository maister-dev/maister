import "server-only";

import type {
  RunScheduleFireOutcome,
  RunScheduleOverlapPolicy,
} from "@/lib/db/schema";
import type { TaskLaunchability } from "@/lib/runs/launchability";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { and, eq, sql } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { nextFireAt } from "@/lib/run-schedules/cron";
import {
  classifyTaskLaunchability,
  getLatestFlowRun,
} from "@/lib/runs/launchability";
import { getOpenRelationBlockers } from "@/lib/social/relations";
import { countLiveRuns, maxConcurrentRunsCap } from "@/lib/scheduler";
import { schedulerAttemptTimeoutSeconds } from "@/lib/scheduler/jobs";
import { launchRun } from "@/lib/services/runs";

const { runSchedules, tasks } = schema;

const log = pino({
  name: "run-schedules",
  level: process.env.LOG_LEVEL ?? "info",
});

// FIXME(any): getDb() returns a pg|sqlite drizzle union; narrow to pg. POC = Postgres.
function db(): NodePgDatabase<typeof schema> {
  return getDb() as unknown as NodePgDatabase<typeof schema>;
}

type DbHandle = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<DbHandle["transaction"]>[0]>[0];

const DISPATCH_BATCH_LIMIT = 10;

export type FireDecision =
  | { action: "launch" }
  | {
      action: "skip";
      outcome:
        | "skipped_task_busy"
        | "skipped_cap"
        | "skipped_target_terminal"
        | "skipped_crashed"
        | "skipped_flagged"
        | "skipped_blocked"
        | "skipped_unconfigured";
    }
  | { action: "catchup"; outcome: "catchup_queued" };

export function decideFire(input: {
  policy: RunScheduleOverlapPolicy;
  launchability: TaskLaunchability;
  capFull: boolean;
}): FireDecision {
  if (input.launchability === "target_terminal") {
    return { action: "skip", outcome: "skipped_target_terminal" };
  }
  if (input.launchability === "crashed") {
    return { action: "skip", outcome: "skipped_crashed" };
  }
  if (input.launchability === "busy") {
    return input.policy === "queue_one"
      ? { action: "catchup", outcome: "catchup_queued" }
      : { action: "skip", outcome: "skipped_task_busy" };
  }
  // ADR-112: a `flagged` task (confirmed duplicate / rejected intake) cannot
  // fire under any policy; like blocked, the queue_one flag is kept so the
  // catch-up fires once a human resolves the flag. Precedence mirrors the
  // classifier (flagged outranks blocked).
  if (input.launchability === "flagged") {
    return { action: "skip", outcome: "skipped_flagged" };
  }
  // ADR-078 D5: relations gate launching under EVERY policy; like crashed,
  // an existing queue_one flag is kept (unblocking fires the catch-up).
  if (input.launchability === "blocked") {
    return { action: "skip", outcome: "skipped_blocked" };
  }
  // M34 (ADR-089): a flowless simple-intent task cannot launch under any
  // policy; the flag is kept — once configured, the catch-up fires.
  if (input.launchability === "unconfigured") {
    return { action: "skip", outcome: "skipped_unconfigured" };
  }
  if (input.capFull) {
    if (input.policy === "skip") {
      return { action: "skip", outcome: "skipped_cap" };
    }
    if (input.policy === "queue_one") {
      return { action: "catchup", outcome: "catchup_queued" };
    }
  }

  return { action: "launch" };
}

export type ScheduleLaunchResult = {
  runId: string;
  status: string;
  queuePosition?: number;
};

export type ScheduleLaunchFn = (
  input: { taskId: string; runnerId?: string },
  actor: { actorUserId: string | null; authorize: () => Promise<void> },
) => Promise<ScheduleLaunchResult>;

const defaultLaunch: ScheduleLaunchFn = (input, actor) =>
  launchRun(input, actor);

export type DispatchSummary = {
  fired: number;
  skippedBusy: number;
  skippedCap: number;
  skippedTerminal: number;
  skippedFlagged: number;
  skippedBlocked: number;
  skippedUnconfigured: number;
  catchupQueued: number;
  launchFailed: number;
  truncated: boolean;
};

export type TriggerResult = {
  outcome: RunScheduleFireOutcome;
  runId?: string;
  queuePosition?: number;
  errorCode?: string;
};

type ClaimedScheduleRow = {
  id: string;
  taskId: string;
  cronExpr: string;
  timezone: string;
  overlapPolicy: RunScheduleOverlapPolicy;
  runnerId: string | null;
  queueOnePending: boolean;
  nextFireAt: Date;
  lastFireOutcome: RunScheduleFireOutcome | null;
  lastFiredAt: Date | null;
};

type LaunchIntent = {
  scheduleId: string;
  taskId: string;
  runnerId: string | null;
  // The last_fired_at value tx1 stamped — the fencing token for tx2's CAS.
  stagedAt: Date;
};

function rowsOf<T>(result: unknown): T[] {
  const wrapped = result as { rows?: T[] };

  return wrapped.rows ?? (result as T[]);
}

// Raw tx.execute bypasses drizzle's column mappers — timestamptz values may
// arrive as strings; coerce them.
function mapClaimedRow(raw: ClaimedScheduleRow): ClaimedScheduleRow {
  return {
    ...raw,
    nextFireAt: new Date(raw.nextFireAt),
    lastFiredAt: raw.lastFiredAt === null ? null : new Date(raw.lastFiredAt),
  };
}

const CLAIM_COLUMNS = sql`
  rs.id,
  rs.task_id AS "taskId",
  rs.cron_expr AS "cronExpr",
  rs.timezone AS "timezone",
  rs.overlap_policy AS "overlapPolicy",
  rs.runner_id AS "runnerId",
  rs.queue_one_pending AS "queueOnePending",
  rs.next_fire_at AS "nextFireAt",
  rs.last_fire_outcome AS "lastFireOutcome",
  rs.last_fired_at AS "lastFiredAt"
`;

// A FRESH 'dispatching' row is owned by an in-flight dispatch (a trigger-now
// between its tx1 and tx2) — claiming it would double-launch and let a fast
// launch_failed clobber the winner's outcome. Only rows past the scheduler
// attempt timeout (the W1 crash-remnant escape) are claimable again — the
// same staleness rule dispatchScheduleNow applies.
function freshDispatchCutoff(now: Date): Date {
  return new Date(now.getTime() - schedulerAttemptTimeoutSeconds() * 1_000);
}

async function claimDueScheduleRows(
  tx: Tx,
  now: Date,
  limit: number,
): Promise<ClaimedScheduleRow[]> {
  const result = await tx.execute(sql`
    SELECT ${CLAIM_COLUMNS}
    FROM run_schedules rs
    JOIN projects p ON p.id = rs.project_id
    WHERE p.archived_at IS NULL
      AND rs.enabled = true
      AND (rs.next_fire_at <= ${now} OR rs.queue_one_pending = true)
      AND (
        rs.last_fire_outcome IS DISTINCT FROM 'dispatching'
        OR rs.last_fired_at IS NULL
        OR rs.last_fired_at <= ${freshDispatchCutoff(now)}
      )
    ORDER BY rs.next_fire_at ASC NULLS LAST
    LIMIT ${limit}
    FOR UPDATE OF rs SKIP LOCKED
  `);

  return rowsOf<ClaimedScheduleRow>(result).map(mapClaimedRow);
}

async function countClaimableSchedules(tx: Tx, now: Date): Promise<number> {
  const result = await tx.execute(sql`
    SELECT count(*)::int AS cnt
    FROM run_schedules rs
    JOIN projects p ON p.id = rs.project_id
    WHERE p.archived_at IS NULL
      AND rs.enabled = true
      AND (rs.next_fire_at <= ${now} OR rs.queue_one_pending = true)
      AND (
        rs.last_fire_outcome IS DISTINCT FROM 'dispatching'
        OR rs.last_fired_at IS NULL
        OR rs.last_fired_at <= ${freshDispatchCutoff(now)}
      )
  `);

  return Number(rowsOf<{ cnt: number }>(result)[0]?.cnt ?? 0);
}

type StagedDecision =
  | { kind: "intent" }
  | {
      kind: "final";
      outcome:
        | "skipped_task_busy"
        | "skipped_cap"
        | "skipped_target_terminal"
        | "skipped_crashed"
        | "skipped_flagged"
        | "skipped_blocked"
        | "skipped_unconfigured"
        | "catchup_queued";
    };

async function decideAndStage(
  tx: Tx,
  row: ClaimedScheduleRow,
  now: Date,
  opts: { advance: boolean; reservedSlots?: number },
): Promise<StagedDecision> {
  const taskRows = await tx
    .select({
      status: tasks.status,
      projectId: tasks.projectId,
      flowId: tasks.flowId,
      triageStatus: tasks.triageStatus,
    })
    .from(tasks)
    .where(eq(tasks.id, row.taskId));
  const task = taskRows[0]!;
  const latestRun = await getLatestFlowRun(row.taskId, tx);
  const openBlockers =
    (await getOpenRelationBlockers([row.taskId], tx)).get(row.taskId) ?? [];
  const launchability = classifyTaskLaunchability(task, latestRun, {
    openBlockers,
  });
  // Launches staged earlier in the SAME batch haven't created runs yet —
  // count them as occupied slots, or every row in the batch sees the
  // pre-batch live count and skip/queue_one overshoot the cap into Pending.
  const reservedSlots = opts.reservedSlots ?? 0;
  const capFull =
    (await countLiveRuns(tx)) + reservedSlots >= maxConcurrentRunsCap();
  const decision = decideFire({
    policy: row.overlapPolicy,
    launchability,
    capFull,
  });

  log.debug(
    {
      scheduleId: row.id,
      launchability,
      blockers: openBlockers.map((b) => `${b.key}-${b.number}`),
      capFull,
      reservedSlots,
      policy: row.overlapPolicy,
      due: row.nextFireAt.getTime() <= now.getTime(),
      catchup: row.queueOnePending,
    },
    "schedule fire inputs",
  );

  const due = row.nextFireAt.getTime() <= now.getTime();
  const advancedFireAt =
    opts.advance && due
      ? { nextFireAt: nextFireAt(row.cronExpr, row.timezone, now) }
      : {};

  if (decision.action === "launch") {
    await tx
      .update(runSchedules)
      .set({
        lastFireOutcome: "dispatching",
        lastFiredAt: now,
        queueOnePending: false,
        queuedFireAt: null,
        updatedAt: now,
        ...advancedFireAt,
      })
      .where(eq(runSchedules.id, row.id));

    return { kind: "intent" };
  }

  if (decision.action === "catchup") {
    await tx
      .update(runSchedules)
      .set({
        lastFireOutcome: "catchup_queued",
        lastFiredAt: now,
        queueOnePending: true,
        updatedAt: now,
        ...(row.queueOnePending ? {} : { queuedFireAt: now }),
        ...advancedFireAt,
      })
      .where(eq(runSchedules.id, row.id));

    return { kind: "final", outcome: "catchup_queued" };
  }

  // A terminal target can never satisfy a queued catch-up — clear the flag so
  // the row is not re-claimed every tick forever. A crashed target keeps it:
  // recover/discard unblocks the task and the catch-up then fires.
  const clearsFlag = decision.outcome === "skipped_target_terminal";

  await tx
    .update(runSchedules)
    .set({
      lastFireOutcome: decision.outcome,
      lastFiredAt: now,
      updatedAt: now,
      ...(clearsFlag ? { queueOnePending: false, queuedFireAt: null } : {}),
      ...advancedFireAt,
    })
    .where(eq(runSchedules.id, row.id));

  return { kind: "final", outcome: decision.outcome };
}

async function writeFinalOutcome(
  database: DbHandle,
  scheduleId: string,
  stagedAt: Date,
  fields: {
    lastFireOutcome: "launched" | "queued_pending" | "launch_failed";
    lastRunId: string | null;
    lastFireError: string | null;
  },
): Promise<void> {
  // last_fired_at is the fencing token: a reclaim past the attempt timeout
  // re-stamps it, so a launch that outlived its lease misses the CAS instead
  // of cross-attributing its result to the newer attempt's marker.
  const rows = await database
    .update(runSchedules)
    .set({ ...fields, updatedAt: new Date() })
    .where(
      and(
        eq(runSchedules.id, scheduleId),
        eq(runSchedules.lastFireOutcome, "dispatching"),
        eq(runSchedules.lastFiredAt, stagedAt),
      ),
    )
    .returning({ id: runSchedules.id });

  if (rows.length === 0) {
    log.warn({ scheduleId }, "stale dispatch result dropped");
  }
}

async function executeLaunch(
  database: DbHandle,
  intent: LaunchIntent,
  launch: ScheduleLaunchFn,
  actorUserId: string | null,
): Promise<TriggerResult> {
  try {
    const result = await launch(
      { taskId: intent.taskId, runnerId: intent.runnerId ?? undefined },
      { actorUserId, authorize: async () => {} },
    );
    const outcome: TriggerResult["outcome"] =
      result.status === "Pending" ? "queued_pending" : "launched";

    await writeFinalOutcome(database, intent.scheduleId, intent.stagedAt, {
      lastFireOutcome:
        outcome === "queued_pending" ? "queued_pending" : "launched",
      lastRunId: result.runId,
      lastFireError: null,
    });

    return {
      outcome,
      runId: result.runId,
      queuePosition: result.queuePosition,
    };
  } catch (err) {
    const code = isMaisterError(err) ? err.code : "ERROR";
    const message = err instanceof Error ? err.message : String(err);
    const bounded = `${code}: ${message}`.slice(0, 500);

    log.warn(
      { scheduleId: intent.scheduleId, errorCode: code },
      "schedule launch failed",
    );
    await writeFinalOutcome(database, intent.scheduleId, intent.stagedAt, {
      lastFireOutcome: "launch_failed",
      lastRunId: null,
      lastFireError: bounded,
    });

    return { outcome: "launch_failed", errorCode: code };
  }
}

export async function dispatchDueSchedules(
  opts: {
    now?: Date;
    launch?: ScheduleLaunchFn;
    limit?: number;
  } = {},
): Promise<DispatchSummary> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? DISPATCH_BATCH_LIMIT;
  const launch = opts.launch ?? defaultLaunch;
  const database = db();

  const summary: DispatchSummary = {
    fired: 0,
    skippedBusy: 0,
    skippedCap: 0,
    skippedTerminal: 0,
    skippedFlagged: 0,
    skippedBlocked: 0,
    skippedUnconfigured: 0,
    catchupQueued: 0,
    launchFailed: 0,
    truncated: false,
  };
  const intents: LaunchIntent[] = [];

  await database.transaction(async (tx) => {
    const claimed = await claimDueScheduleRows(tx, now, limit);

    if (claimed.length === limit) {
      const total = await countClaimableSchedules(tx, now);

      summary.truncated = total > limit;
      if (summary.truncated) {
        log.warn(
          { limit, total },
          "run-schedule dispatch batch truncated; remainder stays due",
        );
      }
    }

    for (const row of claimed) {
      const staged = await decideAndStage(tx, row, now, {
        advance: true,
        reservedSlots: intents.length,
      });

      if (staged.kind === "intent") {
        intents.push({
          scheduleId: row.id,
          taskId: row.taskId,
          runnerId: row.runnerId,
          stagedAt: now,
        });
      } else {
        switch (staged.outcome) {
          case "skipped_task_busy":
            summary.skippedBusy += 1;
            break;
          case "skipped_cap":
            summary.skippedCap += 1;
            break;
          case "skipped_target_terminal":
          case "skipped_crashed":
            summary.skippedTerminal += 1;
            break;
          case "skipped_flagged":
            summary.skippedFlagged += 1;
            break;
          case "skipped_blocked":
            summary.skippedBlocked += 1;
            break;
          case "skipped_unconfigured":
            summary.skippedUnconfigured += 1;
            break;
          case "catchup_queued":
            summary.catchupQueued += 1;
            break;
        }
        log.info(
          { scheduleId: row.id, outcome: staged.outcome },
          "schedule fire decision",
        );
      }
    }
  });

  for (const intent of intents) {
    const result = await executeLaunch(database, intent, launch, null);

    if (result.outcome === "launch_failed") {
      summary.launchFailed += 1;
    } else {
      summary.fired += 1;
    }
    log.info(
      {
        scheduleId: intent.scheduleId,
        outcome: result.outcome,
        runId: result.runId,
      },
      "schedule fire result",
    );
  }

  return summary;
}

export async function dispatchScheduleNow(
  scheduleId: string,
  opts: {
    actorUserId: string | null;
    now?: Date;
    launch?: ScheduleLaunchFn;
  },
): Promise<TriggerResult> {
  const now = opts.now ?? new Date();
  const launch = opts.launch ?? defaultLaunch;
  const database = db();

  let intent: LaunchIntent | null = null;
  let finalOutcome: TriggerResult | null = null;

  await database.transaction(async (tx) => {
    const result = await tx.execute(sql`
      SELECT ${CLAIM_COLUMNS}
      FROM run_schedules rs
      WHERE rs.id = ${scheduleId}
      FOR UPDATE SKIP LOCKED
    `);
    const rawRow = rowsOf<ClaimedScheduleRow>(result)[0];
    const row = rawRow ? mapClaimedRow(rawRow) : undefined;

    if (!row) {
      throw new MaisterError(
        "CONFLICT",
        `schedule dispatch in progress: ${scheduleId}`,
      );
    }

    const timeoutMs = schedulerAttemptTimeoutSeconds() * 1_000;
    const freshDispatching =
      row.lastFireOutcome === "dispatching" &&
      row.lastFiredAt !== null &&
      now.getTime() - row.lastFiredAt.getTime() < timeoutMs;

    if (freshDispatching) {
      throw new MaisterError(
        "CONFLICT",
        `schedule dispatch in progress: ${scheduleId}`,
      );
    }

    const staged = await decideAndStage(tx, row, now, { advance: false });

    if (staged.kind === "intent") {
      intent = {
        scheduleId: row.id,
        taskId: row.taskId,
        runnerId: row.runnerId,
        stagedAt: now,
      };
    } else {
      finalOutcome = { outcome: staged.outcome };
      log.info(
        { scheduleId, outcome: staged.outcome, actorUserId: opts.actorUserId },
        "schedule trigger decision",
      );
    }
  });

  if (finalOutcome) return finalOutcome;

  const result = await executeLaunch(
    database,
    intent!,
    launch,
    opts.actorUserId,
  );

  log.info(
    {
      scheduleId,
      outcome: result.outcome,
      runId: result.runId,
      actorUserId: opts.actorUserId,
    },
    "schedule trigger result",
  );

  return result;
}
