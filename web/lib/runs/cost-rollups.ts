import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { eq, inArray } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { runtimeRoot as configuredRuntimeRoot } from "@/lib/instance-config";

const { nodeAttemptCostRollups, nodeAttempts, projects, runCostRollups, runs } =
  schema;

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

function addByModel(
  byModel: Record<string, Record<string, number>>,
  record: ParsedCostRecord,
): void {
  const current = byModel[record.model] ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };

  current.inputTokens += record.inputTokens;
  current.outputTokens += record.outputTokens;
  current.cacheReadTokens += record.cacheReadTokens;
  current.cacheCreationTokens += record.cacheCreationTokens;
  byModel[record.model] = current;
}

export function aggregateCostJsonlLines(
  lines: Iterable<string>,
  nodeIdByAttemptId: ReadonlyMap<string, string>,
): CostRollupAggregation {
  const runTotals = emptyTotals();
  const byModel: Record<string, Record<string, number>> = {};
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
    addByModel(byModel, record);

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
    })
    .from(runs)
    .innerJoin(projects, eq(projects.id, runs.projectId))
    .where(eq(runs.id, runId));

  if (!run) {
    return { status: "missing-run", sourceEventCount: 0 };
  }

  const costPath = path.join(
    opts.runtimeRoot ?? configuredRuntimeRoot(),
    ".maister",
    run.projectSlug,
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

export async function reconcileProjectScopeCostRollups(
  projectIds: readonly string[],
  opts: { client?: DbClient; runtimeRoot?: string } = {},
): Promise<void> {
  if (projectIds.length === 0) return;

  const client = opts.client ?? db();
  const rows = await client
    .select({ id: runs.id })
    .from(runs)
    .where(inArray(runs.projectId, [...new Set(projectIds)]));

  await reconcileManyRunCostRollups(
    rows.map((run) => run.id),
    { client, runtimeRoot: opts.runtimeRoot },
  );
}
