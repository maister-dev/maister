import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { desc, eq } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const { nodeAttempts, runs } = schema;

type DbClient = NodePgDatabase<typeof schema>;

const FAILED_RUN_STATUSES = ["Failed", "Crashed", "Abandoned"] as const;

const log = pino({
  name: "budget-meters",
  level: process.env.LOG_LEVEL ?? "info",
});

function db(): DbClient {
  return getDb() as unknown as DbClient;
}

// Count the leading run of failures in a status list already ordered newest →
// oldest. The streak stops at the first non-failure (a Succeeded attempt, a
// Running/Done run, etc.).
function leadingStreak(
  statuses: readonly string[],
  isFailure: (status: string) => boolean,
): number {
  let streak = 0;

  for (const status of statuses) {
    if (!isFailure(status)) break;

    streak += 1;
  }

  return streak;
}

// Trailing streak of `Failed` node attempts for one run (run-scope failure
// meter), ordered by attempt DESC — counts leading Failed until a non-Failed
// attempt breaks the run.
export async function consecutiveFailedAttempts(
  runId: string,
  opts: { client?: DbClient } = {},
): Promise<number> {
  const client = opts.client ?? db();
  const rows = await client
    .select({ status: nodeAttempts.status })
    .from(nodeAttempts)
    .where(eq(nodeAttempts.runId, runId))
    .orderBy(desc(nodeAttempts.attempt));
  const streak = leadingStreak(
    rows.map((row) => row.status),
    (status) => status === "Failed",
  );

  log.debug({ runId, scope: "run", streak }, "consecutive failed attempts");

  return streak;
}

// Trailing streak of `Failed|Crashed|Abandoned` runs scoped by task_id OR
// root_run_id (task-scope / tree-scope failure meter), ordered by started_at
// DESC. Exactly one of taskId / rootRunId must be provided.
export async function consecutiveFailedRuns(
  key: { taskId?: string; rootRunId?: string },
  opts: { client?: DbClient; excludeRunId?: string } = {},
): Promise<number> {
  if ((key.taskId == null) === (key.rootRunId == null)) {
    throw new MaisterError(
      "CONFIG",
      "consecutiveFailedRuns requires exactly one of taskId or rootRunId",
    );
  }

  const client = opts.client ?? db();
  const scope =
    key.taskId != null
      ? eq(runs.taskId, key.taskId)
      : eq(runs.rootRunId, key.rootRunId as string);
  const rows = await client
    .select({ id: runs.id, status: runs.status })
    .from(runs)
    .where(scope)
    .orderBy(desc(runs.startedAt));
  const failed = new Set<string>(FAILED_RUN_STATUSES);
  // Exclude the live candidate run from the trailing streak. A task's currently
  // Running run is its NEWEST by started_at and is not a failure, so leaving it
  // in breaks the streak at 0 — task-scope consecutiveFailures would never trip
  // (spec E7). Counting failures strictly BEFORE the live run gives the intended
  // "N prior attempts failed" signal. (A tree root is the OLDEST member, so
  // excluding it is a no-op there — kept for uniformity.)
  const statuses = (
    opts.excludeRunId
      ? rows.filter((row) => row.id !== opts.excludeRunId)
      : rows
  ).map((row) => row.status);
  const streak = leadingStreak(statuses, (status) => failed.has(status));

  log.debug(
    {
      scope: key.taskId != null ? "task" : "tree",
      taskId: key.taskId,
      rootRunId: key.rootRunId,
      streak,
    },
    "consecutive failed runs",
  );

  return streak;
}

// Wall-clock minutes elapsed since the root run's started_at (tree-scope
// wall-clock meter). `now` is taken at call time. Returns 0 when the root run is
// missing or has no started_at.
export async function treeWallClockMinutes(
  rootRunId: string,
  opts: { client?: DbClient } = {},
): Promise<number> {
  const client = opts.client ?? db();
  const [row] = await client
    .select({ startedAt: runs.startedAt })
    .from(runs)
    .where(eq(runs.id, rootRunId));

  if (!row?.startedAt) return 0;

  const elapsedMs = Date.now() - row.startedAt.getTime();
  const minutes = elapsedMs <= 0 ? 0 : Math.floor(elapsedMs / 60_000);

  log.debug({ rootRunId, scope: "tree", minutes }, "tree wall-clock minutes");

  return minutes;
}
