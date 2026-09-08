import "server-only";

import type { RunnerSnapshot } from "@/lib/db/schema";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { and, eq, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  projectExecutionEvents,
  type ExecutionEventProjector,
} from "@/lib/execution-host/events/projector";
import { projectionTransaction } from "@/lib/execution-host/events/projection-transaction";
import { CANONICAL_PROJECTION_CONSUMERS } from "@/lib/execution-host/events/projection-consumers";

const { nodeAttemptCostRollups, nodeAttempts, runCostRollups, runs } = schema;

type DbClient = NodePgDatabase<typeof schema>;

type TokenTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  resumeInputTokens: number;
  resumeOutputTokens: number;
  resumeCacheReadTokens: number;
  resumeCacheCreationTokens: number;
};

type ParsedCostRecord = {
  model: string;
  sessionName: string;
  nodeAttemptId: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  resumed: boolean;
};

export type CostRollupNodeTotal = TokenTotals & {
  nodeAttemptId: string;
  nodeId: string;
  model: string;
  sourceEventCount: number;
};

export type CostRollupAggregation = {
  run: TokenTotals & {
    byModel: Record<string, Record<string, number>>;
    bySession: Record<string, Record<string, number>>;
    sourceEventCount: number;
  };
  nodeAttempts: CostRollupNodeTotal[];
  malformedLineCount: number;
  unattributedNodeEventCount: number;
};

export type ReconcileRunCostRollupsResult = {
  status: "missing-run" | "reconciled";
  sourceEventCount: number;
};

const log = pino({
  name: "cost-rollups",
  level: process.env.LOG_LEVEL ?? "info",
});

function db(): DbClient {
  return getDb() as unknown as DbClient;
}

function emptyTotals(): TokenTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    resumeInputTokens: 0,
    resumeOutputTokens: 0,
    resumeCacheReadTokens: 0,
    resumeCacheCreationTokens: 0,
  };
}

function addRecord(target: TokenTotals, record: ParsedCostRecord): void {
  target.inputTokens += record.inputTokens;
  target.outputTokens += record.outputTokens;
  target.cacheReadTokens += record.cacheReadTokens;
  target.cacheCreationTokens += record.cacheCreationTokens;

  if (!record.resumed) return;

  target.resumeInputTokens += record.inputTokens;
  target.resumeOutputTokens += record.outputTokens;
  target.resumeCacheReadTokens += record.cacheReadTokens;
  target.resumeCacheCreationTokens += record.cacheCreationTokens;
}

function tokenValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Math.trunc(value);
}

function parseCostRecord(line: string): ParsedCostRecord | null {
  const trimmed = line.trim();

  if (trimmed.length === 0) return null;

  const parsed = JSON.parse(trimmed) as Record<string, unknown>;
  const inputTokens = tokenValue(parsed.input_tokens);
  const outputTokens = tokenValue(parsed.output_tokens);
  const cacheReadTokens = tokenValue(parsed.cache_read_input_tokens);
  const cacheCreationTokens = tokenValue(parsed.cache_creation_input_tokens);

  if (
    inputTokens === 0 &&
    outputTokens === 0 &&
    cacheReadTokens === 0 &&
    cacheCreationTokens === 0
  ) {
    return null;
  }

  return {
    model:
      typeof parsed.model === "string" && parsed.model.trim().length > 0
        ? parsed.model.trim()
        : "unknown",
    sessionName:
      typeof parsed.sessionName === "string" &&
      parsed.sessionName.trim().length > 0
        ? parsed.sessionName.trim()
        : "default",
    nodeAttemptId:
      typeof parsed.nodeAttemptId === "string" &&
      parsed.nodeAttemptId.trim().length > 0
        ? parsed.nodeAttemptId.trim()
        : null,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    resumed: parsed.resumed === true,
  };
}

// Folds a record's four BASE token kinds into a string-keyed bucket map (used
// for both the by-model and by-session breakdowns). Resume tax is NOT added
// separately — the base tokens already include it, matching the run-level
// byModel semantics.
function addByKey(
  bucket: Record<string, Record<string, number>>,
  key: string,
  record: ParsedCostRecord,
): void {
  const current = bucket[key] ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };

  current.inputTokens += record.inputTokens;
  current.outputTokens += record.outputTokens;
  current.cacheReadTokens += record.cacheReadTokens;
  current.cacheCreationTokens += record.cacheCreationTokens;
  bucket[key] = current;
}

// ADR-117 D2: the stable per-runner group key is derived from the session's
// runner_snapshot (NOT the catalog FK), so a deleted platform_acp_runners row
// never erases historical attribution. Returns null when the snapshot is absent
// or lacks an adapter/model — those sessions fall back to the "unknown" bucket.
export function runnerKeyFromSnapshot(
  snapshot: RunnerSnapshot | null | undefined,
): string | null {
  const adapter = snapshot?.adapter?.trim();
  const model = snapshot?.model?.trim();

  if (!adapter || !model) return null;

  return `${adapter}/${model}`;
}

// Folds the per-session token buckets into per-runner buckets via the
// sessionName → runnerKey map. Sessions with no mapped runner (no run_sessions
// row, or an unusable snapshot) collapse into the "unknown" bucket. Multiple
// sessions mapping to the same runnerKey are summed.
export function foldSessionsByRunner(
  bySession: Record<string, Record<string, number>>,
  runnerKeyBySession: ReadonlyMap<string, string>,
): Record<string, Record<string, number>> {
  const byRunner: Record<string, Record<string, number>> = {};

  for (const [sessionName, totals] of Object.entries(bySession)) {
    const key = runnerKeyBySession.get(sessionName) ?? "unknown";
    const current = byRunner[key] ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };

    current.inputTokens += totals.inputTokens ?? 0;
    current.outputTokens += totals.outputTokens ?? 0;
    current.cacheReadTokens += totals.cacheReadTokens ?? 0;
    current.cacheCreationTokens += totals.cacheCreationTokens ?? 0;
    byRunner[key] = current;
  }

  return byRunner;
}

export function aggregateCostJsonlLines(
  lines: Iterable<string>,
  nodeIdByAttemptId: ReadonlyMap<string, string>,
): CostRollupAggregation {
  const runTotals = emptyTotals();
  const byModel: Record<string, Record<string, number>> = {};
  const bySession: Record<string, Record<string, number>> = {};
  const nodeTotals = new Map<string, CostRollupNodeTotal>();
  let sourceEventCount = 0;
  let malformedLineCount = 0;
  let unattributedNodeEventCount = 0;

  for (const line of lines) {
    let record: ParsedCostRecord | null;

    try {
      record = parseCostRecord(line);
    } catch {
      malformedLineCount += 1;
      continue;
    }

    if (!record) continue;

    sourceEventCount += 1;
    addRecord(runTotals, record);
    addByKey(byModel, record.model, record);
    addByKey(bySession, record.sessionName, record);

    if (!record.nodeAttemptId) {
      unattributedNodeEventCount += 1;
      continue;
    }

    const nodeId = nodeIdByAttemptId.get(record.nodeAttemptId);

    if (!nodeId) {
      unattributedNodeEventCount += 1;
      continue;
    }

    const key = `${record.nodeAttemptId}\u0000${record.model}`;
    const current = nodeTotals.get(key) ?? {
      ...emptyTotals(),
      nodeAttemptId: record.nodeAttemptId,
      nodeId,
      model: record.model,
      sourceEventCount: 0,
    };

    addRecord(current, record);
    current.sourceEventCount += 1;
    nodeTotals.set(key, current);
  }

  return {
    run: {
      ...runTotals,
      byModel,
      bySession,
      sourceEventCount,
    },
    nodeAttempts: [...nodeTotals.values()],
    malformedLineCount,
    unattributedNodeEventCount,
  };
}

export async function reconcileRunCostRollups(
  runId: string,
  opts: { client?: DbClient } = {},
): Promise<ReconcileRunCostRollupsResult> {
  const client = opts.client ?? db();
  const [run] = await client
    .select({
      id: runs.id,
      projectId: runs.projectId,
      taskId: runs.taskId,
      flowId: runs.flowId,
    })
    .from(runs)
    .where(eq(runs.id, runId));

  if (!run) {
    return { status: "missing-run", sourceEventCount: 0 };
  }

  const summary = await projectExecutionEvents({
    db: client,
    runId,
    projector: canonicalCostProjector,
  });

  if (summary.poisoned)
    throw new MaisterError(
      "CONFLICT",
      "canonical cost projection requires repair",
      { details: { reason: "cost_projection_poisoned", runId } },
    );
  await projectionTransaction(client, async (tx) => {
    await tx
      .select({ runId: schema.executionEventConsumers.runId })
      .from(schema.executionEventConsumers)
      .where(
        and(
          eq(schema.executionEventConsumers.runId, runId),
          eq(
            schema.executionEventConsumers.consumerName,
            CANONICAL_PROJECTION_CONSUMERS.cost,
          ),
        ),
      )
      .for("update");
    await refreshRunnerBuckets(tx, runId);
  });
  const [rollup] = await client
    .select({ count: runCostRollups.sourceEventCount })
    .from(runCostRollups)
    .where(eq(runCostRollups.runId, runId))
    .limit(1);

  return { status: "reconciled", sourceEventCount: rollup?.count ?? 0 };
}

const TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheCreationTokens",
  "resumeInputTokens",
  "resumeOutputTokens",
  "resumeCacheReadTokens",
  "resumeCacheCreationTokens",
] as const;

type TokenField = (typeof TOKEN_FIELDS)[number];

function incrementTotals(
  table: Record<TokenField, SQLWrapper> & { sourceCursor: SQLWrapper },
  totals: TokenTotals,
): Record<TokenField, SQL<number>> {
  return Object.fromEntries(
    TOKEN_FIELDS.map((key) => [
      key,
      sql<number>`(CASE WHEN ${table.sourceCursor} LIKE 'canonical-worker:v1:%' THEN ${table[key]} ELSE 0 END) + ${totals[key]}`,
    ]),
  ) as Record<TokenField, SQL<number>>;
}

function incrementBucket(
  column: SQLWrapper,
  key: string,
  record: ParsedCostRecord,
): SQL {
  const current = sql`CASE WHEN ${runCostRollups.sourceCursor} LIKE 'canonical-worker:v1:%' THEN ${column} ELSE '{}'::jsonb END`;

  return sql`jsonb_set(${current}, ARRAY[${key}]::text[], jsonb_build_object(
    'inputTokens', COALESCE((${current}->${key}->>'inputTokens')::bigint, 0) + ${record.inputTokens},
    'outputTokens', COALESCE((${current}->${key}->>'outputTokens')::bigint, 0) + ${record.outputTokens},
    'cacheReadTokens', COALESCE((${current}->${key}->>'cacheReadTokens')::bigint, 0) + ${record.cacheReadTokens},
    'cacheCreationTokens', COALESCE((${current}->${key}->>'cacheCreationTokens')::bigint, 0) + ${record.cacheCreationTokens}
  ))`;
}

async function refreshRunnerBuckets(
  tx: DbClient,
  runId: string,
): Promise<void> {
  await tx.execute(sql`UPDATE run_cost_rollups r SET by_runner = (
    SELECT COALESCE(jsonb_object_agg(grouped.runner_key, grouped.tokens), '{}'::jsonb)
    FROM (
      SELECT attributed.runner_key, jsonb_build_object(
        'inputTokens', sum((attributed.tokens->>'inputTokens')::bigint),
        'outputTokens', sum((attributed.tokens->>'outputTokens')::bigint),
        'cacheReadTokens', sum((attributed.tokens->>'cacheReadTokens')::bigint),
        'cacheCreationTokens', sum((attributed.tokens->>'cacheCreationTokens')::bigint)
      ) AS tokens
      FROM (
        SELECT CASE WHEN NULLIF(btrim(s.runner_snapshot->>'adapter'), '') IS NOT NULL
          AND NULLIF(btrim(s.runner_snapshot->>'model'), '') IS NOT NULL
          THEN btrim(s.runner_snapshot->>'adapter') || '/' || btrim(s.runner_snapshot->>'model')
          ELSE 'unknown' END AS runner_key, bucket.value AS tokens
        FROM jsonb_each(r.by_session) bucket
        LEFT JOIN run_sessions s ON s.run_id = r.run_id AND s.session_name = bucket.key
      ) attributed GROUP BY attributed.runner_key
    ) grouped
  ) WHERE r.run_id = ${runId} AND r.source_cursor LIKE 'canonical-worker:v1:%'`);
}

export const canonicalCostProjector: ExecutionEventProjector = {
  consumerName: CANONICAL_PROJECTION_CONSUMERS.cost,
  project: async (tx, event) => {
    if (event.eventType !== "usage.recorded") return;
    const payload = event.payload ?? {};
    const record = parseCostRecord(
      JSON.stringify({
        input_tokens: payload.inputTokens,
        output_tokens: payload.outputTokens,
        cache_read_input_tokens: payload.cacheReadInputTokens,
        cache_creation_input_tokens: payload.cacheCreationInputTokens,
        model: payload.model,
        sessionName: payload.sessionName,
        nodeAttemptId: payload.nodeAttemptId,
        resumed: payload.resumed,
      }),
    );

    if (!record) return;
    const [run] = await tx
      .select({
        id: runs.id,
        projectId: runs.projectId,
        taskId: runs.taskId,
        flowId: runs.flowId,
      })
      .from(runs)
      .where(eq(runs.id, event.runId))
      .limit(1);

    if (!run)
      throw new MaisterError("CONFLICT", "cost event references a missing run");
    const totals = emptyTotals();

    addRecord(totals, record);
    const bucket = {
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cacheReadTokens: record.cacheReadTokens,
      cacheCreationTokens: record.cacheCreationTokens,
    };
    const sourceCursor = `canonical-worker:v1:${event.runSequence}`;
    const now = new Date();

    await tx
      .insert(runCostRollups)
      .values({
        runId: run.id,
        projectId: run.projectId,
        taskId: run.taskId,
        flowId: run.flowId,
        ...totals,
        byModel: { [record.model]: bucket },
        bySession: { [record.sessionName]: bucket },
        byRunner: {},
        sourceEventCount: 1,
        sourceCursor,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: runCostRollups.runId,
        set: {
          ...incrementTotals(runCostRollups, totals),
          byModel: incrementBucket(
            runCostRollups.byModel,
            record.model,
            record,
          ),
          bySession: incrementBucket(
            runCostRollups.bySession,
            record.sessionName,
            record,
          ),
          sourceEventCount: sql`(CASE WHEN ${runCostRollups.sourceCursor} LIKE 'canonical-worker:v1:%' THEN ${runCostRollups.sourceEventCount} ELSE 0 END) + 1`,
          sourceCursor,
          updatedAt: now,
        },
      });
    await refreshRunnerBuckets(tx, event.runId);
    if (!record.nodeAttemptId) return;
    const [attempt] = await tx
      .select({ id: nodeAttempts.id, nodeId: nodeAttempts.nodeId })
      .from(nodeAttempts)
      .where(
        and(
          eq(nodeAttempts.id, record.nodeAttemptId),
          eq(nodeAttempts.runId, event.runId),
        ),
      )
      .limit(1);

    if (!attempt) {
      log.warn(
        { runId: event.runId, eventId: event.id },
        "cost-event-has-no-owned-node-attempt",
      );

      return;
    }
    await tx
      .insert(nodeAttemptCostRollups)
      .values({
        runId: run.id,
        projectId: run.projectId,
        nodeAttemptId: attempt.id,
        nodeId: attempt.nodeId,
        model: record.model,
        ...totals,
        sourceEventCount: 1,
        sourceCursor,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          nodeAttemptCostRollups.nodeAttemptId,
          nodeAttemptCostRollups.model,
        ],
        set: {
          ...incrementTotals(nodeAttemptCostRollups, totals),
          sourceEventCount: sql`(CASE WHEN ${nodeAttemptCostRollups.sourceCursor} LIKE 'canonical-worker:v1:%' THEN ${nodeAttemptCostRollups.sourceEventCount} ELSE 0 END) + 1`,
          sourceCursor,
          updatedAt: now,
        },
      });
  },
};

export async function reconcileManyRunCostRollups(
  runIds: readonly string[],
  opts: { client?: DbClient } = {},
): Promise<void> {
  const uniqueRunIds = [...new Set(runIds)];

  await Promise.all(
    uniqueRunIds.map((runId) => reconcileRunCostRollups(runId, opts)),
  );
}

// Cost-budget governance: the budget token total is the SUM of the four BASE
// token columns (the resume* columns are a subset already folded into the base
// by addRecord, so they are NOT added here — adding them would double-count the
// resume tax). COALESCE(..., 0) covers the no-rows case (missing run / empty
// task / empty tree). Returned as a JS number (token counts are well within
// Number.MAX_SAFE_INTEGER for any realistic spend).
const baseTokenSumExpr = sql<number>`coalesce(sum(
  ${runCostRollups.inputTokens}
  + ${runCostRollups.outputTokens}
  + ${runCostRollups.cacheReadTokens}
  + ${runCostRollups.cacheCreationTokens}
), 0)`;

// PG returns bigint sums as a string; coerce to a JS number at the boundary.
function asTokenNumber(value: number | string | null): number {
  return Number(value ?? 0);
}

export async function queryRunTokens(
  runId: string,
  opts: { client?: DbClient } = {},
): Promise<number> {
  const client = opts.client ?? db();
  const [row] = await client
    .select({ total: baseTokenSumExpr })
    .from(runCostRollups)
    .where(eq(runCostRollups.runId, runId));
  const total = asTokenNumber(row?.total ?? 0);

  log.debug({ runId, scope: "run", total }, "budget token total");

  return total;
}

export async function queryTaskTokens(
  taskId: string,
  opts: { client?: DbClient } = {},
): Promise<number> {
  const client = opts.client ?? db();
  const [row] = await client
    .select({ total: baseTokenSumExpr })
    .from(runCostRollups)
    .innerJoin(runs, eq(runs.id, runCostRollups.runId))
    .where(eq(runs.taskId, taskId));
  const total = asTokenNumber(row?.total ?? 0);

  log.debug({ taskId, scope: "task", total }, "budget token total");

  return total;
}

/**
 * Tree-wide token totals BY KIND and BY MODEL — the readable sibling of
 * `queryRunTreeTokens`, which returns one flat sum for the budget meter.
 *
 * Covers the root AND every descendant in one read. The scope is `id = root OR
 * root_run_id = root`, not `root_run_id` alone: the launchers write
 * `parent.rootRunId ?? parent.id`, so a DESCENDANT carries the root's id while
 * the ROOT ITSELF carries NULL. A `root_run_id`-only predicate silently drops
 * the root's own spend from its own tree total.
 *
 * Shares the row-folding helper with the per-run summary rather than
 * reimplementing the by-model merge (ADR-165 T8.3).
 */
export async function queryRunTreeTokensByKind(
  rootRunId: string,
  opts: { client?: DbClient } = {},
): Promise<{
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  byModel: Record<string, Record<string, number>>;
  runCount: number;
}> {
  const client = opts.client ?? db();
  const rows = (await client
    .select({
      inputTokens: runCostRollups.inputTokens,
      outputTokens: runCostRollups.outputTokens,
      cacheReadTokens: runCostRollups.cacheReadTokens,
      cacheCreationTokens: runCostRollups.cacheCreationTokens,
      byModel: runCostRollups.byModel,
    })
    .from(runCostRollups)
    .innerJoin(runs, eq(runs.id, runCostRollups.runId))
    .where(or(eq(runs.id, rootRunId), eq(runs.rootRunId, rootRunId)))) as {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    byModel: Record<string, Record<string, number>> | null;
  }[];

  return foldTokenRows(rows);
}

/**
 * Sum a set of rollup rows into one total, merging `byModel` key by key.
 *
 * ONE folding rule, so the per-run and tree summaries can never disagree about
 * what "total" or "by model" means.
 */
export function foldTokenRows(
  rows: readonly {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    byModel: Record<string, Record<string, number>> | null;
  }[],
): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  byModel: Record<string, Record<string, number>>;
  runCount: number;
} {
  const byModel: Record<string, Record<string, number>> = {};
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;

  for (const row of rows) {
    inputTokens += row.inputTokens;
    outputTokens += row.outputTokens;
    cacheReadTokens += row.cacheReadTokens;
    cacheCreationTokens += row.cacheCreationTokens;

    for (const [model, kinds] of Object.entries(row.byModel ?? {})) {
      const target = (byModel[model] ??= {});

      for (const [kind, value] of Object.entries(kinds)) {
        target[kind] = (target[kind] ?? 0) + value;
      }
    }
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens:
      inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
    byModel,
    runCount: rows.length,
  };
}

/**
 * Flat token total for a whole tree — the ADR-101 budget meter.
 *
 * Scope is `id = root OR root_run_id = root`, for the same reason as
 * `queryRunTreeTokensByKind`: a DESCENDANT carries the root's id while the ROOT
 * ITSELF carries NULL, so a `root_run_id`-only predicate silently excludes the
 * root coordinator's own spend from its own budget.
 */
export async function queryRunTreeTokens(
  rootRunId: string,
  opts: { client?: DbClient } = {},
): Promise<number> {
  const client = opts.client ?? db();
  const [row] = await client
    .select({ total: baseTokenSumExpr })
    .from(runCostRollups)
    .innerJoin(runs, eq(runs.id, runCostRollups.runId))
    .where(or(eq(runs.id, rootRunId), eq(runs.rootRunId, rootRunId)));
  const total = asTokenNumber(row?.total ?? 0);

  log.debug({ rootRunId, scope: "tree", total }, "budget token total");

  return total;
}
