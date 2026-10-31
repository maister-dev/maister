import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { RunStatusValue } from "@/lib/runs/run-status-values";
import type { AgentActivityTimestampProvenance } from "@/lib/agents/activity-types";
import type {
  OperationalOutcome,
  OperationalTerminal,
} from "@/lib/run-results/operational-types";
import type { AgentTriggerAttemptOutcome } from "@/lib/agents/trigger-attempt-types";

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import {
  agentTriggerAttempts,
  hitlRequests,
  projects,
  runs,
  workspaces,
} from "@/lib/db/schema";
import { ACTIVE_AGENT_RUN_STATUSES } from "@/lib/agents/activity-status";
import {
  decodeAgentActivityCursor,
  encodeAgentActivityCursor,
} from "@/lib/agents/activity-cursor";
import { TERMINAL_RUN_STATUSES } from "@/lib/runs/run-status-sets";
import { RUN_STATUS_VALUES } from "@/lib/runs/run-status-values";
import { MaisterError } from "@/lib/errors";
import { loadOperationalOutcomes } from "@/lib/run-results/operational-projection";

type AgentOutcome = OperationalTerminal["effectiveOutcome"];
type RunSummary = {
  runId: string;
  status: RunStatusValue;
  at: string;
  outcome: AgentOutcome | null;
};
export type AgentActivitySummary = {
  retainedRunCount: number;
  activeRunCount: number;
  attemptCount: number | null;
  lastLaunched: (RunSummary & { estimated: boolean }) | null;
  lastCompleted: RunSummary | null;
};

const utcTimestamp = (
  column: ReturnType<typeof sql>,
): ReturnType<typeof sql<string>> =>
  sql<string>`to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** One SQL statement aggregates all requested identities, including identities with no retained runs. */
export async function getAgentActivitySummaries(
  db: Db,
  projectId: string,
  agentIds: readonly string[],
): Promise<Map<string, AgentActivitySummary>> {
  if (!agentIds.length) return new Map();
  const ids = [...new Set(agentIds)];
  const result = await db.execute<{
    agent_id: string;
    retained: number;
    active: number;
    attempts: number | null;
    latest: AgentActivitySummary["lastLaunched"];
    completed: AgentActivitySummary["lastCompleted"];
  }>(sql`
    WITH requested AS (SELECT unnest(ARRAY[${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )}]::text[]) AS agent_id),
    totals AS (
      SELECT source_agent_id, count(*)::int AS retained,
        count(*) FILTER (WHERE status IN ${ACTIVE_AGENT_RUN_STATUSES})::int AS active
      FROM runs WHERE project_id=${projectId} AND source_agent_id IN ${ids}
      GROUP BY source_agent_id
    ), attempts AS (
      SELECT source_agent_id, CASE WHEN bool_or(provenance='legacy_latest') THEN NULL ELSE count(*)::int END AS amount
      FROM agent_trigger_attempts WHERE project_id=${projectId} AND source_agent_id IN ${ids}
      GROUP BY source_agent_id
    )
    SELECT requested.agent_id, coalesce(totals.retained,0) AS retained, coalesce(totals.active,0) AS active,
      CASE WHEN attempts.source_agent_id IS NULL THEN 0 ELSE attempts.amount END AS attempts,
      latest.value AS latest, completed.value AS completed
    FROM requested LEFT JOIN totals ON totals.source_agent_id=requested.agent_id
    LEFT JOIN attempts ON attempts.source_agent_id=requested.agent_id
    LEFT JOIN LATERAL (
      SELECT json_build_object('runId',r.id,'status',r.status,'at',${utcTimestamp(sql`r.activity_sort_at`)},
        'estimated',r.activity_timestamp_provenance NOT IN ('launch','verified_creation'),
        'outcome',r.operational_terminal->>'effectiveOutcome') AS value
      FROM runs r WHERE r.project_id=${projectId} AND r.source_agent_id=requested.agent_id
      ORDER BY r.activity_sort_at DESC,r.id DESC LIMIT 1
    ) latest ON true
    LEFT JOIN LATERAL (
      SELECT json_build_object('runId',r.id,'status',r.status,'at',${utcTimestamp(sql`r.ended_at`)},
        'outcome',r.operational_terminal->>'effectiveOutcome') AS value
      FROM runs r WHERE r.project_id=${projectId} AND r.source_agent_id=requested.agent_id
        AND r.status IN ${[...TERMINAL_RUN_STATUSES]} AND r.ended_at IS NOT NULL
      ORDER BY r.ended_at DESC,r.id DESC LIMIT 1
    ) completed ON true
  `);

  return new Map(
    result.rows.map((row) => [
      row.agent_id,
      {
        retainedRunCount: row.retained,
        activeRunCount: row.active,
        attemptCount: row.attempts,
        lastLaunched: row.latest,
        lastCompleted: row.completed,
      },
    ]),
  );
}

const historySchema = z
  .object({
    projectId: z.string().min(1).max(256),
    agentId: z.string().min(1).max(256),
    limit: z.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).max(2048).optional(),
    status: z.enum(RUN_STATUS_VALUES).optional(),
    triggerSource: z
      .enum(["manual", "cron", "domain_event", "webhook", "flow", "scheduled"])
      .optional(),
    outcome: z
      .enum(["success", "partial", "blocked", "failed", "cancelled", "crashed"])
      .optional(),
  })
  .strict();

export type AgentHistoryFilter = z.input<typeof historySchema>;
export type AgentHistoryItem = {
  runId: string;
  agentId: string;
  runKind: "agent" | "flow";
  status: RunStatusValue;
  triggerSource: typeof runs.$inferSelect.triggerSource;
  launchedAt: string | null;
  sortAt: string;
  timestampProvenance: AgentActivityTimestampProvenance;
  workspaceAvailable: boolean;
  outcome: AgentOutcome | null;
  retryOfRunId: string | null;
};
export type ActivityPage<T> = {
  items: T[];
  nextCursor: string | null;
  asOf: string;
};

async function activityPageBounds(
  db: Db,
  scope: string,
  cursor: string | undefined,
): Promise<{ upper: string; at: string | null; id: string | null }> {
  if (cursor) return decodeAgentActivityCursor(scope, cursor);
  const result = await db.execute<{ at: string }>(
    sql`SELECT ${utcTimestamp(sql`clock_timestamp()`)} AS at`,
  );

  return { upper: result.rows[0].at, at: null, id: null };
}

/** Cursor membership is bounded by launch time; status/outcome filters remain live canonical state. */
export async function getAgentRunHistory(
  db: Db,
  input: AgentHistoryFilter,
): Promise<ActivityPage<AgentHistoryItem>> {
  const parsed = historySchema.safeParse(input);

  if (!parsed.success)
    throw new MaisterError("CONFIG", "Invalid agent history filters", {
      details: { issues: parsed.error.issues },
    });
  const { projectId, agentId, limit, cursor, status, triggerSource, outcome } =
    parsed.data;
  const scope = JSON.stringify([
    "runs",
    projectId,
    agentId,
    status ?? null,
    triggerSource ?? null,
    outcome ?? null,
  ]);
  const bounds = await activityPageBounds(db, scope, cursor);
  const rows = await db
    .select({
      runId: runs.id,
      agentId: runs.sourceAgentId,
      runKind: runs.runKind,
      status: runs.status,
      triggerSource: runs.triggerSource,
      launchedAt: runs.launchedAt,
      sortAt: utcTimestamp(sql`${runs.activitySortAt}`),
      timestampProvenance: runs.activityTimestampProvenance,
      workspaceAvailable: sql<boolean>`${workspaces.id} IS NOT NULL`,
      outcome: sql<AgentOutcome | null>`${runs.operationalTerminal}->>'effectiveOutcome'`,
      retryOfRunId: runs.retryOfRunId,
    })
    .from(runs)
    .leftJoin(
      workspaces,
      and(eq(workspaces.runId, runs.id), isNull(workspaces.removedAt)),
    )
    .where(
      and(
        eq(runs.projectId, projectId),
        eq(runs.sourceAgentId, agentId),
        inArray(runs.runKind, ["agent", "flow"]),
        sql`${runs.activitySortAt} <= ${bounds.upper}::timestamptz`,
        bounds.at
          ? sql`(${runs.activitySortAt},${runs.id}) < (${bounds.at}::timestamptz,${bounds.id})`
          : undefined,
        status ? eq(runs.status, status) : undefined,
        triggerSource ? eq(runs.triggerSource, triggerSource) : undefined,
        outcome
          ? sql`${runs.operationalTerminal}->>'effectiveOutcome'=${outcome}`
          : undefined,
      ),
    )
    .orderBy(desc(runs.activitySortAt), desc(runs.id))
    .limit(limit + 1);
  const items: AgentHistoryItem[] = rows.slice(0, limit).map((row) => {
    if (
      !row.agentId ||
      !row.timestampProvenance ||
      (row.runKind !== "agent" && row.runKind !== "flow")
    )
      throw new MaisterError("CONFIG", "Agent history identity is incomplete", {
        details: { runId: row.runId },
      });

    return {
      ...row,
      agentId: row.agentId,
      runKind: row.runKind,
      timestampProvenance: row.timestampProvenance,
      launchedAt: row.launchedAt?.toISOString() ?? null,
    };
  });
  const last = items.at(-1);

  return {
    items,
    asOf: bounds.upper,
    nextCursor:
      rows.length > limit && last
        ? encodeAgentActivityCursor(scope, {
            upper: bounds.upper,
            at: last.sortAt,
            id: last.runId,
          })
        : null,
  };
}

/** Protected result bodies are hydrated only after the HTTP/page owner grants repository-content access. */
export async function loadAgentHistoryEvidence(
  db: Db,
  page: ActivityPage<AgentHistoryItem>,
): Promise<
  ActivityPage<AgentHistoryItem & { operationalOutcome?: OperationalOutcome }>
> {
  const outcomes = await loadOperationalOutcomes(
    db,
    page.items.map((row) => row.runId),
  );

  return {
    ...page,
    items: page.items.map((row) => {
      const operationalOutcome = outcomes.get(row.runId);

      return operationalOutcome ? { ...row, operationalOutcome } : row;
    }),
  };
}

export type AgentAttemptItem = {
  attemptId: string;
  triggerSource: string;
  claimedAt: string;
  settledAt: string | null;
  outcome: AgentTriggerAttemptOutcome | null;
  runId: string | null;
  reasonCode: string | null;
  provenance: "recorded" | "legacy_latest";
};

export async function getAgentAttemptHistory(
  db: Db,
  input: Pick<AgentHistoryFilter, "projectId" | "agentId" | "limit" | "cursor">,
): Promise<ActivityPage<AgentAttemptItem>> {
  const parsed = historySchema
    .pick({ projectId: true, agentId: true, limit: true, cursor: true })
    .safeParse(input);

  if (!parsed.success)
    throw new MaisterError("CONFIG", "Invalid agent attempt history filters");
  const { projectId, agentId, limit, cursor } = parsed.data;
  const scope = JSON.stringify(["attempts", projectId, agentId]);
  const bounds = await activityPageBounds(db, scope, cursor);
  const rows = await db
    .select({
      attemptId: agentTriggerAttempts.id,
      triggerSource: agentTriggerAttempts.triggerSource,
      claimedAt: utcTimestamp(sql`${agentTriggerAttempts.claimedAt}`),
      settledAt: agentTriggerAttempts.settledAt,
      outcome: agentTriggerAttempts.outcome,
      runId: agentTriggerAttempts.runId,
      reasonCode: agentTriggerAttempts.reasonCode,
      provenance: agentTriggerAttempts.provenance,
    })
    .from(agentTriggerAttempts)
    .where(
      and(
        eq(agentTriggerAttempts.projectId, projectId),
        eq(agentTriggerAttempts.sourceAgentId, agentId),
        sql`${agentTriggerAttempts.claimedAt} <= ${bounds.upper}::timestamptz`,
        bounds.at
          ? sql`(${agentTriggerAttempts.claimedAt},${agentTriggerAttempts.id}) < (${bounds.at}::timestamptz,${bounds.id})`
          : undefined,
      ),
    )
    .orderBy(
      desc(agentTriggerAttempts.claimedAt),
      desc(agentTriggerAttempts.id),
    )
    .limit(limit + 1);
  const items: AgentAttemptItem[] = rows.slice(0, limit).map((row) => ({
    ...row,
    settledAt: row.settledAt?.toISOString() ?? null,
    provenance: row.provenance === "claim" ? "recorded" : "legacy_latest",
  }));
  const last = items.at(-1);

  return {
    items,
    asOf: bounds.upper,
    nextCursor:
      rows.length > limit && last
        ? encodeAgentActivityCursor(scope, {
            upper: bounds.upper,
            at: last.claimedAt,
            id: last.attemptId,
          })
        : null,
  };
}

export type ActiveAgentExecution = {
  runId: string;
  projectId: string;
  projectSlug: string;
  projectName: string;
  agentId: string | null;
  displayName: string | null;
  status: RunStatusValue;
  runKind: "agent" | "flow";
  pool: "agent" | "flow";
  launchedAt: string | null;
  workspaceAvailable: boolean;
  pendingInputCount: number;
};

/** The caller supplies its already-authorized project set; an empty set never widens visibility. */
export async function getActiveAgentExecutions(
  db: Db,
  projectIds: readonly string[],
): Promise<ActiveAgentExecution[]> {
  if (!projectIds.length) return [];
  const rows = await db
    .select({
      runId: runs.id,
      projectId: projects.id,
      projectSlug: projects.slug,
      projectName: projects.name,
      agentId: runs.sourceAgentId,
      displayName: sql<
        string | null
      >`${runs.agentActivitySnapshot}->>'displayName'`,
      status: runs.status,
      runKind: runs.runKind,
      launchedAt: runs.launchedAt,
      workspaceAvailable: sql<boolean>`${workspaces.id} IS NOT NULL`,
      pendingInputCount: sql<number>`(SELECT count(*)::int FROM ${hitlRequests} WHERE ${hitlRequests.runId}=${runs.id} AND ${hitlRequests.respondedAt} IS NULL AND ${hitlRequests.supersededAt} IS NULL AND (${hitlRequests.activationState} IS NULL OR ${hitlRequests.activationState}='active'))`,
    })
    .from(runs)
    .innerJoin(projects, eq(projects.id, runs.projectId))
    .leftJoin(
      workspaces,
      and(eq(workspaces.runId, runs.id), isNull(workspaces.removedAt)),
    )
    .where(
      and(
        inArray(runs.projectId, [...projectIds]),
        isNull(projects.archivedAt),
        inArray(runs.status, ACTIVE_AGENT_RUN_STATUSES),
        sql`(${runs.runKind}='agent' OR (${runs.runKind}='flow' AND ${runs.sourceAgentId} IS NOT NULL))`,
      ),
    )
    .orderBy(desc(runs.activitySortAt), desc(runs.id));

  return rows.map((row) => {
    if (row.runKind !== "agent" && row.runKind !== "flow")
      throw new MaisterError("CONFIG", "Unexpected agent execution kind");

    return {
      ...row,
      runKind: row.runKind,
      pool: row.runKind,
      launchedAt: row.launchedAt?.toISOString() ?? null,
    };
  });
}
