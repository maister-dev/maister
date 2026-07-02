import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { prepareDiffSummary } from "@/lib/diff/prepare";
import { compileManifest } from "@/lib/flows/graph/compile";
import { resolveManifest } from "@/lib/flows/graph/current-node-kind";
import { runtimeRoot } from "@/lib/instance-config";
import { interpretScratchUpdate } from "@/lib/scratch-runs/transcript";
import { diffRunWorkspace, resolveBaseRef } from "@/lib/worktree";
import {
  consecutiveFailedAttempts,
  consecutiveFailedRuns,
  treeWallClockMinutes,
} from "@/lib/runs/budget-meters";
import {
  budgetBreachClaimStage,
  budgetBreachProgressFromInput,
  budgetBreachSchemaView,
  getBudgetBreachAvailableOptions,
  isActiveBudgetBreachClaim,
  type BudgetBreachAvailableOption,
  type BudgetBreachBudgetObservation,
  type BudgetBreachClaimStage,
  type BudgetBreachMeter,
  type BudgetBreachProgressDto,
  type BudgetBreachRunStatus,
} from "@/lib/runs/budget-breach-fork";
import {
  budgetFromSnapshot,
  type BudgetAxis,
  type BudgetLimits,
  type BudgetScope,
  type BudgetState,
} from "@/lib/runs/execution-policy";
import { effectiveLimit, isSetLimit } from "@/lib/runs/keepalive-sweeper";

const {
  gateResults,
  hitlRequests,
  nodeAttempts,
  projects,
  runCostRollups,
  runs,
  stepRuns,
  workspaces,
} = schema;

const log = pino({
  name: "inbox-context",
  level: process.env.LOG_LEVEL ?? "info",
});

// FIXME(any): getDb() returns a pg|sqlite drizzle union; narrow to pg. POC = Postgres.
type Db = NodePgDatabase<typeof schema>;

export interface InboxGateChip {
  gateId: string;
  kind:
    | "command_check"
    | "skill_check"
    | "ai_judgment"
    | "artifact_required"
    | "external_check"
    | "human_review";
  mode: "blocking" | "advisory";
  status:
    | "pending"
    | "running"
    | "passed"
    | "failed"
    | "stale"
    | "skipped"
    | "overridden";
}

export interface InboxCardContext {
  lastAgentMessage: { text: string; at: string } | null;
  gates: InboxGateChip[];
  diff: { files: number; additions: number; deletions: number } | null;
  progress: { done: number; total: number } | null;
  budgetProgress: BudgetBreachProgressDto | null;
  availableOptions: BudgetBreachAvailableOption[];
  claimStage: BudgetBreachClaimStage | null;
}

export interface InboxContextRun {
  id: string;
  projectId: string;
  currentStepId: string | null;
  flowRevisionId: string | null;
  flowId: string | null;
}

const MAX_MESSAGE_CHARS = 1000;

// Coalesce the trailing contiguous run of `agent_message_chunk` text from a run's
// `run.events.jsonl` — i.e. the last thing the agent said. A tool call resets the
// buffer (the agent moved on); thought/usage chunks are ignored.
export function extractLastAgentMessage(rawJsonl: string): string | null {
  let buffer = "";

  for (const line of rawJsonl.split("\n")) {
    const trimmed = line.trim();

    if (!trimmed || !trimmed.includes("session.update")) continue;

    let parsed: { type?: unknown; update?: unknown };

    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (parsed.type !== "session.update") continue;
    const interpreted = interpretScratchUpdate(parsed.update);

    if (!interpreted) continue;

    if (interpreted.kind === "text") buffer += interpreted.text;
    else if (
      interpreted.kind === "tool_call" ||
      interpreted.kind === "tool_update"
    )
      buffer = "";
  }

  const text = buffer.trim();

  if (text.length === 0) return null;

  return text.length > MAX_MESSAGE_CHARS
    ? `${text.slice(0, MAX_MESSAGE_CHARS)}…`
    : text;
}

async function loadLastAgentMessage(
  client: Db,
  run: InboxContextRun,
): Promise<InboxCardContext["lastAgentMessage"]> {
  try {
    const slugRows = await client
      .select({ slug: projects.slug })
      .from(projects)
      .where(eq(projects.id, run.projectId));
    const slug = slugRows[0]?.slug;

    if (!slug) return null;

    const eventsLogPath = path.join(
      runtimeRoot(),
      ".maister",
      slug,
      "runs",
      run.id,
      "run.events.jsonl",
    );
    const raw = await readFile(eventsLogPath, "utf8");
    const text = extractLastAgentMessage(raw);

    if (!text) return null;

    const st = await stat(eventsLogPath);

    return { text, at: st.mtime.toISOString() };
  } catch (err) {
    log.warn(
      { runId: run.id, err },
      "[inbox-context] lastAgentMessage read failed",
    );

    return null;
  }
}

async function loadCurrentNodeGates(
  client: Db,
  run: InboxContextRun,
): Promise<InboxGateChip[]> {
  if (!run.currentStepId) return [];

  try {
    const attemptRows = await client
      .select({ id: nodeAttempts.id })
      .from(nodeAttempts)
      .where(
        and(
          eq(nodeAttempts.runId, run.id),
          eq(nodeAttempts.nodeId, run.currentStepId),
        ),
      )
      .orderBy(desc(nodeAttempts.attempt))
      .limit(1);
    const attemptId = attemptRows[0]?.id;

    if (!attemptId) return [];

    return await client
      .select({
        gateId: gateResults.gateId,
        kind: gateResults.kind,
        mode: gateResults.mode,
        status: gateResults.status,
      })
      .from(gateResults)
      .where(eq(gateResults.nodeAttemptId, attemptId));
  } catch (err) {
    log.warn(
      { runId: run.id, currentStepId: run.currentStepId, err },
      "[inbox-context] gates read failed",
    );

    return [];
  }
}

async function countSucceededNodes(client: Db, runId: string): Promise<number> {
  const rows = await client
    .select({ nodeId: nodeAttempts.nodeId })
    .from(nodeAttempts)
    .where(
      and(eq(nodeAttempts.runId, runId), eq(nodeAttempts.status, "Succeeded")),
    );

  return new Set(rows.map((r) => r.nodeId)).size;
}

async function countSucceededSteps(client: Db, runId: string): Promise<number> {
  const rows = await client
    .select({ stepId: stepRuns.stepId })
    .from(stepRuns)
    .where(and(eq(stepRuns.runId, runId), eq(stepRuns.status, "Succeeded")));

  return new Set(rows.map((r) => r.stepId)).size;
}

async function loadProgress(
  client: Db,
  run: InboxContextRun,
): Promise<InboxCardContext["progress"]> {
  try {
    const manifest = await resolveManifest(client, {
      flowRevisionId: run.flowRevisionId,
      flowId: run.flowId,
    });

    if (!manifest) return null;
    const total = compileManifest(manifest).nodes.size;

    if (total === 0) return null;

    // Graph (`nodes[]`) runs ledger progress in node_attempts; legacy linear
    // (`steps[]`) runs record it in step_runs (runner.ts:184 dispatch). Counting
    // only node_attempts would render every legacy run as 0/N.
    const isLinear = Array.isArray(manifest.steps) && manifest.steps.length > 0;
    const done = isLinear
      ? await countSucceededSteps(client, run.id)
      : await countSucceededNodes(client, run.id);

    return { done: Math.min(done, total), total };
  } catch (err) {
    log.warn({ runId: run.id, err }, "[inbox-context] progress read failed");

    return null;
  }
}

async function loadDiffSummary(
  client: Db,
  run: InboxContextRun,
): Promise<InboxCardContext["diff"]> {
  try {
    const wsRows = await client
      .select()
      .from(workspaces)
      .where(eq(workspaces.runId, run.id));
    const workspace = wsRows[0];

    if (!workspace || workspace.removedAt) return null;

    const projRows = await client
      .select({ mainBranch: projects.mainBranch })
      .from(projects)
      .where(eq(projects.id, run.projectId));
    const project = projRows[0];

    if (!project) return null;

    const base =
      workspace.baseCommit ??
      (await resolveBaseRef({
        worktreePath: workspace.worktreePath,
        branch: workspace.branch,
        mainBranch: project.mainBranch,
      }));
    const { text, truncated } = await diffRunWorkspace({
      projectRepoPath: workspace.worktreePath,
      baseCommit: base,
      branch: workspace.branch,
    });
    const summary = prepareDiffSummary(text, truncated);

    return {
      files: summary.files.length,
      additions: summary.files.reduce((sum, f) => sum + (f.additions ?? 0), 0),
      deletions: summary.files.reduce((sum, f) => sum + (f.deletions ?? 0), 0),
    };
  } catch (err) {
    log.warn({ runId: run.id, err }, "[inbox-context] diff read failed");

    return null;
  }
}

type PendingBudgetBreachRow = {
  schema: unknown;
  response: unknown;
  runKind: "flow" | "scratch" | "agent";
  status: BudgetBreachRunStatus;
  taskId: string | null;
  flowId: string | null;
  agentId: string | null;
  parentRunId: string | null;
  rootRunId: string | null;
  agentWorkspace: "none" | "repo_read" | "worktree" | null;
  startedAt: Date;
  endedAt: Date | null;
  resumeStartedAt: Date | null;
  executionPolicy: unknown;
  budgetState: BudgetState | null;
  workspaceId: string | null;
  workspaceRemovedAt: Date | null;
};

function zeroGateSummary(): BudgetBreachProgressDto["gates"] {
  return {
    open: 0,
    satisfied: 0,
    failed: 0,
    unknown: 0,
  };
}

function summarizeGates(
  gates: InboxGateChip[],
): BudgetBreachProgressDto["gates"] {
  return gates.reduce((summary, gate) => {
    if (gate.status === "passed" || gate.status === "overridden") {
      summary.satisfied += 1;
    } else if (gate.status === "failed") {
      summary.failed += 1;
    } else if (gate.status === "pending" || gate.status === "running") {
      summary.open += 1;
    } else {
      summary.unknown += 1;
    }

    return summary;
  }, zeroGateSummary());
}

function emptyBudgetObservation(): BudgetBreachBudgetObservation {
  return { limit: null, spent: null, source: "no-data" };
}

function effectiveBudgetLimitOrNull(
  snapshotBudget: BudgetAxis,
  override: BudgetAxis | undefined,
  scope: BudgetScope,
  field: keyof BudgetLimits,
): number | null {
  const limit = effectiveLimit(snapshotBudget, override, scope, field);

  return isSetLimit(limit) ? limit : null;
}

function observation(
  limit: number | null,
  spent: number | null,
): BudgetBreachBudgetObservation {
  return {
    limit,
    spent,
    source: limit !== null && spent !== null ? "value" : "no-data",
  };
}

function wallclockMinutes(row: PendingBudgetBreachRow, now: Date): number {
  const end = row.endedAt ?? now;

  return Math.max(
    0,
    Math.round((end.getTime() - row.startedAt.getTime()) / 60_000),
  );
}

const baseTokenSpend = sql<number | string>`coalesce(sum(
  ${runCostRollups.inputTokens}
  + ${runCostRollups.outputTokens}
  + ${runCostRollups.cacheReadTokens}
  + ${runCostRollups.cacheCreationTokens}
), 0)`;

function tokenSpendFromAggregate(
  row: { total: number | string | null; rows: number | string | null } | null,
): number | null {
  if (row === null || Number(row.rows ?? 0) === 0) {
    return null;
  }

  return Number(row.total ?? 0);
}

async function loadTokenSpend(
  client: Db,
  run: InboxContextRun,
  row: PendingBudgetBreachRow,
  scope: BudgetScope,
): Promise<number | null> {
  if (scope === "run") {
    const rows = await client
      .select({
        total: baseTokenSpend,
        rows: sql<number | string>`count(${runCostRollups.runId})`,
      })
      .from(runCostRollups)
      .where(eq(runCostRollups.runId, run.id));

    return tokenSpendFromAggregate(rows[0] ?? null);
  }

  if (scope === "task") {
    if (!row.taskId) return null;
    const rows = await client
      .select({
        total: baseTokenSpend,
        rows: sql<number | string>`count(${runCostRollups.runId})`,
      })
      .from(runCostRollups)
      .innerJoin(runs, eq(runs.id, runCostRollups.runId))
      .where(eq(runs.taskId, row.taskId));

    return tokenSpendFromAggregate(rows[0] ?? null);
  }

  const rootRunId = row.rootRunId ?? run.id;
  const rows = await client
    .select({
      total: baseTokenSpend,
      rows: sql<number | string>`count(${runCostRollups.runId})`,
    })
    .from(runCostRollups)
    .innerJoin(runs, eq(runs.id, runCostRollups.runId))
    .where(eq(runs.rootRunId, rootRunId));

  return tokenSpendFromAggregate(rows[0] ?? null);
}

async function loadFailureSpend(
  client: Db,
  run: InboxContextRun,
  row: PendingBudgetBreachRow,
  scope: BudgetScope,
): Promise<number | null> {
  if (scope === "run") {
    return consecutiveFailedAttempts(run.id, { client });
  }

  if (scope === "task") {
    return row.taskId
      ? consecutiveFailedRuns(
          { taskId: row.taskId },
          { client, excludeRunId: run.id },
        )
      : null;
  }

  return consecutiveFailedRuns(
    { rootRunId: row.rootRunId ?? run.id },
    { client, excludeRunId: run.id },
  );
}

async function loadWallclockSpend(
  client: Db,
  row: PendingBudgetBreachRow,
  run: InboxContextRun,
  scope: BudgetScope,
  now: Date,
): Promise<number | null> {
  if (scope !== "tree") {
    return wallclockMinutes(row, now);
  }

  return treeWallClockMinutes(row.rootRunId ?? run.id, { client });
}

async function budgetObservation(args: {
  client: Db;
  run: InboxContextRun;
  row: PendingBudgetBreachRow;
  scope: BudgetScope;
  dimension: BudgetBreachMeter;
  limit: number | null;
  now: Date;
}): Promise<BudgetBreachBudgetObservation> {
  if (args.limit === null) return emptyBudgetObservation();

  try {
    const spent =
      args.dimension === "tokens"
        ? await loadTokenSpend(args.client, args.run, args.row, args.scope)
        : args.dimension === "failures"
          ? await loadFailureSpend(args.client, args.run, args.row, args.scope)
          : await loadWallclockSpend(
              args.client,
              args.row,
              args.run,
              args.scope,
              args.now,
            );

    return observation(args.limit, spent);
  } catch (err) {
    log.warn(
      {
        runId: args.run.id,
        scope: args.scope,
        dimension: args.dimension,
        err: err instanceof Error ? err.message : String(err),
      },
      "[inbox-context] budget progress spend read failed",
    );

    return observation(args.limit, null);
  }
}

async function loadPendingBudgetBreach(
  client: Db,
  runId: string,
): Promise<PendingBudgetBreachRow | null> {
  const rows = await client
    .select({
      schema: hitlRequests.schema,
      response: hitlRequests.response,
      runKind: runs.runKind,
      status: runs.status,
      taskId: runs.taskId,
      flowId: runs.flowId,
      agentId: runs.agentId,
      parentRunId: runs.parentRunId,
      rootRunId: runs.rootRunId,
      agentWorkspace: runs.agentWorkspace,
      startedAt: runs.startedAt,
      endedAt: runs.endedAt,
      resumeStartedAt: runs.resumeStartedAt,
      executionPolicy: runs.executionPolicy,
      budgetState: runs.budgetState,
      workspaceId: workspaces.id,
      workspaceRemovedAt: workspaces.removedAt,
    })
    .from(hitlRequests)
    .innerJoin(runs, eq(runs.id, hitlRequests.runId))
    .leftJoin(workspaces, eq(workspaces.runId, runs.id))
    .where(
      and(
        eq(hitlRequests.runId, runId),
        eq(hitlRequests.kind, "budget_breach"),
        isNull(hitlRequests.respondedAt),
        eq(runs.id, runId),
      ),
    )
    .orderBy(desc(hitlRequests.createdAt))
    .limit(1);

  const row = rows[0];

  if (!row) return null;

  return {
    ...row,
    budgetState: row.budgetState ?? null,
  };
}

async function buildBudgetProgress(
  client: Db,
  run: InboxContextRun,
  row: PendingBudgetBreachRow,
  gates: InboxGateChip[],
  progress: InboxCardContext["progress"],
  diff: InboxCardContext["diff"],
): Promise<BudgetBreachProgressDto | null> {
  const schemaView = budgetBreachSchemaView(row.schema);

  if (schemaView === null) return null;

  const snapshotBudget = budgetFromSnapshot(row.executionPolicy);
  const ceilingOverride = row.budgetState?.ceilingOverride;
  const scope = schemaView.scope;
  const now = new Date();
  const minutes = wallclockMinutes(row, now);
  const budgetByDimension: Record<
    BudgetBreachMeter,
    BudgetBreachBudgetObservation
  > = {
    tokens: await budgetObservation({
      client,
      run,
      row,
      scope,
      dimension: "tokens",
      limit: effectiveBudgetLimitOrNull(
        snapshotBudget,
        ceilingOverride,
        scope,
        "maxTokens",
      ),
      now,
    }),
    failures: await budgetObservation({
      client,
      run,
      row,
      scope,
      dimension: "failures",
      limit: effectiveBudgetLimitOrNull(
        snapshotBudget,
        ceilingOverride,
        scope,
        "consecutiveFailures",
      ),
      now,
    }),
    wallclock: await budgetObservation({
      client,
      run,
      row,
      scope,
      dimension: "wallclock",
      limit: effectiveBudgetLimitOrNull(
        snapshotBudget,
        ceilingOverride,
        scope,
        "wallClockMinutes",
      ),
      now,
    }),
  };

  budgetByDimension[schemaView.meter] = {
    limit: schemaView.limit,
    spent: schemaView.current,
    source: "value",
  };

  return budgetBreachProgressFromInput({
    schema: row.schema,
    budgetByDimension,
    nodes: {
      completed: progress?.done ?? null,
      total: progress?.total ?? null,
      currentNodeId: run.currentStepId,
    },
    diff:
      diff === null
        ? null
        : {
            filesChanged: diff.files,
            insertions: diff.additions,
            deletions: diff.deletions,
          },
    gates: summarizeGates(gates),
    wallclockMinutes: minutes,
    resumeCount: row.resumeStartedAt === null ? 0 : 1,
  });
}

// The run is loaded + authorized (`readBoard`) by the caller. Each field is read
// independently and degrades to null/[] on a missing or unreadable source — the
// route never 500s for a missing peek (M17/inbox-card-redesign).
export async function getInboxCardContext(
  run: InboxContextRun,
): Promise<InboxCardContext> {
  const client = getDb() as unknown as Db;

  const [lastAgentMessage, gates, progress, diff] = await Promise.all([
    loadLastAgentMessage(client, run),
    loadCurrentNodeGates(client, run),
    loadProgress(client, run),
    loadDiffSummary(client, run),
  ]);
  const budgetRow = await loadPendingBudgetBreach(client, run.id);

  if (budgetRow === null) {
    return {
      lastAgentMessage,
      gates,
      diff,
      progress,
      budgetProgress: null,
      availableOptions: [],
      claimStage: null,
    };
  }

  return {
    lastAgentMessage,
    gates,
    diff,
    progress,
    budgetProgress: await buildBudgetProgress(
      client,
      run,
      budgetRow,
      gates,
      progress,
      diff,
    ),
    availableOptions: isActiveBudgetBreachClaim(budgetRow.response)
      ? []
      : getBudgetBreachAvailableOptions({
          runKind: budgetRow.runKind,
          status: budgetRow.status,
          taskId: budgetRow.taskId,
          flowId: budgetRow.flowId,
          agentId: budgetRow.agentId,
          parentRunId: budgetRow.parentRunId,
          agentWorkspace: budgetRow.agentWorkspace,
          hasOwnedWorkspace:
            budgetRow.workspaceId !== null &&
            budgetRow.workspaceRemovedAt === null,
        }),
    claimStage: budgetBreachClaimStage(budgetRow.response),
  };
}
