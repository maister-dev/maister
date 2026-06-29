import "server-only";

import type { RunnerSnapshot } from "@/lib/db/schema";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { eq, sql } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { runtimeRoot as configuredRuntimeRoot } from "@/lib/instance-config";

const {
  localPackages,
  nodeAttemptCostRollups,
  nodeAttempts,
  projects,
  runCostRollups,
  runSessions,
  runs,
} = schema;

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

type CostSourceRun = {
  id: string;
  projectSlug: string | null;
  localPackageSlug: string | null;
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
  status: "missing-run" | "missing-cost-file" | "reconciled";
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

export function resolveRunCostSourceSlug(run: CostSourceRun): string {
  const slug = run.projectSlug ?? run.localPackageSlug;

  if (!slug) {
    throw new MaisterError(
      "CONFIG",
      `cost rollup owner slug missing for run: ${run.id}`,
    );
  }

  return slug;
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
  opts: { client?: DbClient; runtimeRoot?: string } = {},
): Promise<ReconcileRunCostRollupsResult> {
  const client = opts.client ?? db();
  const [run] = await client
    .select({
      id: runs.id,
      projectId: runs.projectId,
      taskId: runs.taskId,
      flowId: runs.flowId,
      projectSlug: projects.slug,
      localPackageSlug: localPackages.slug,
    })
    .from(runs)
    .leftJoin(projects, eq(projects.id, runs.projectId))
    .leftJoin(localPackages, eq(localPackages.id, runs.localPackageId))
    .where(eq(runs.id, runId));

  if (!run) {
    return { status: "missing-run", sourceEventCount: 0 };
  }

  const ownerSlug = resolveRunCostSourceSlug(run);

  const costPath = path.join(
    opts.runtimeRoot ?? configuredRuntimeRoot(),
    ".maister",
    ownerSlug,
    "runs",
    run.id,
    "cost.jsonl",
  );
  let raw: string;

  try {
    raw = await readFile(costPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing-cost-file", sourceEventCount: 0 };
    }

    throw err;
  }

  const attemptRows = await client
    .select({
      id: nodeAttempts.id,
      nodeId: nodeAttempts.nodeId,
    })
    .from(nodeAttempts)
    .where(eq(nodeAttempts.runId, run.id));
  const nodeIdByAttemptId = new Map(
    attemptRows.map((attempt) => [attempt.id, attempt.nodeId] as const),
  );
  const aggregation = aggregateCostJsonlLines(
    raw.split("\n"),
    nodeIdByAttemptId,
  );
  const sessionRows = await client
    .select({
      sessionName: runSessions.sessionName,
      runnerSnapshot: runSessions.runnerSnapshot,
    })
    .from(runSessions)
    .where(eq(runSessions.runId, run.id));
  const runnerKeyBySession = new Map<string, string>();

  for (const session of sessionRows) {
    const key = runnerKeyFromSnapshot(session.runnerSnapshot);

    if (key) runnerKeyBySession.set(session.sessionName, key);
  }
  const byRunner = foldSessionsByRunner(
    aggregation.run.bySession,
    runnerKeyBySession,
  );
  const sourceCursor = `bytes:${Buffer.byteLength(raw, "utf8")}:events:${aggregation.run.sourceEventCount}`;
  const now = new Date();

  await client
    .delete(nodeAttemptCostRollups)
    .where(eq(nodeAttemptCostRollups.runId, run.id));

  if (aggregation.run.sourceEventCount === 0) {
    await client.delete(runCostRollups).where(eq(runCostRollups.runId, run.id));
  } else {
    const runValues = {
      runId: run.id,
      projectId: run.projectId,
      taskId: run.taskId,
      flowId: run.flowId,
      inputTokens: aggregation.run.inputTokens,
      outputTokens: aggregation.run.outputTokens,
      cacheReadTokens: aggregation.run.cacheReadTokens,
      cacheCreationTokens: aggregation.run.cacheCreationTokens,
      resumeInputTokens: aggregation.run.resumeInputTokens,
      resumeOutputTokens: aggregation.run.resumeOutputTokens,
      resumeCacheReadTokens: aggregation.run.resumeCacheReadTokens,
      resumeCacheCreationTokens: aggregation.run.resumeCacheCreationTokens,
      byModel: aggregation.run.byModel,
      byRunner,
      sourceEventCount: aggregation.run.sourceEventCount,
      sourceCursor,
      updatedAt: now,
    };

    await client.insert(runCostRollups).values(runValues).onConflictDoUpdate({
      target: runCostRollups.runId,
      set: runValues,
    });
  }

  if (aggregation.nodeAttempts.length > 0) {
    await client.insert(nodeAttemptCostRollups).values(
      aggregation.nodeAttempts.map((attempt) => ({
        runId: run.id,
        projectId: run.projectId,
        nodeAttemptId: attempt.nodeAttemptId,
        nodeId: attempt.nodeId,
        model: attempt.model,
        inputTokens: attempt.inputTokens,
        outputTokens: attempt.outputTokens,
        cacheReadTokens: attempt.cacheReadTokens,
        cacheCreationTokens: attempt.cacheCreationTokens,
        resumeInputTokens: attempt.resumeInputTokens,
        resumeOutputTokens: attempt.resumeOutputTokens,
        resumeCacheReadTokens: attempt.resumeCacheReadTokens,
        resumeCacheCreationTokens: attempt.resumeCacheCreationTokens,
        sourceEventCount: attempt.sourceEventCount,
        sourceCursor,
        updatedAt: now,
      })),
    );
  }

  if (aggregation.malformedLineCount > 0) {
    log.warn(
      { runId: run.id, malformedLineCount: aggregation.malformedLineCount },
      "cost-rollup skipped malformed lines",
    );
  }
  if (aggregation.unattributedNodeEventCount > 0) {
    log.warn(
      {
        runId: run.id,
        unattributedNodeEventCount: aggregation.unattributedNodeEventCount,
      },
      "cost-rollup skipped node-attempt attribution for some events",
    );
  }
  log.debug(
    {
      runId: run.id,
      sourceEventCount: aggregation.run.sourceEventCount,
      nodeAttemptRollupCount: aggregation.nodeAttempts.length,
    },
    "cost-rollup reconciled",
  );

  return {
    status: "reconciled",
    sourceEventCount: aggregation.run.sourceEventCount,
  };
}

export async function reconcileManyRunCostRollups(
  runIds: readonly string[],
  opts: { client?: DbClient; runtimeRoot?: string } = {},
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

export async function queryRunTreeTokens(
  rootRunId: string,
  opts: { client?: DbClient } = {},
): Promise<number> {
  const client = opts.client ?? db();
  const [row] = await client
    .select({ total: baseTokenSumExpr })
    .from(runCostRollups)
    .innerJoin(runs, eq(runs.id, runCostRollups.runId))
    .where(eq(runs.rootRunId, rootRunId));
  const total = asTokenNumber(row?.total ?? 0);

  log.debug({ rootRunId, scope: "tree", total }, "budget token total");

  return total;
}
