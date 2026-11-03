import "server-only";

import type { InteractiveTaskLaunchPrincipal } from "@/lib/tasks/admission-types";
import type { Db } from "@/lib/execution-host/db";
import type {
  AgentRetryBatchItem,
  AgentRetryBatchOptions,
  AgentRetryBatchResult,
} from "@/lib/agents/retry-batch-types";

import { sql } from "drizzle-orm";
import pino from "pino";
import { z } from "zod";

import { taskLaunchBodySchema } from "@/lib/tasks/launch-schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { assertRetryAuthority, retryRefusal } from "@/lib/agents/retry-guards";
import { acceptAgentRetry, getAgentRetryOptions } from "@/lib/agents/retry";
import {
  decodeAgentActivityCursor,
  encodeAgentActivityCursor,
} from "@/lib/agents/activity-cursor";

const PAGE_SIZE = 50;
const log = pino({
  name: "agent-retry-batch",
  level: process.env.LOG_LEVEL ?? "info",
});
const runIdsSchema = z
  .array(z.string().uuid())
  .min(1)
  .max(100)
  .refine(
    (values) => new Set(values).size === values.length,
    "Source runs must be unique",
  );
const filterSchema = z
  .object({
    runIds: runIdsSchema.optional(),
    cursor: z.string().min(1).max(2048).optional(),
    runnerId: z.string().min(1).max(256).optional(),
  })
  .strict()
  .refine(
    (value) => !(value.runIds && value.cursor),
    "Selected sources cannot use a cursor",
  );
const requestSchema = z
  .object({
    runnerId: z.string().min(1).max(256),
    items: z
      .array(
        z
          .object({
            runId: z.string().uuid(),
            requestKey: z.string().uuid(),
            previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
            strategy: z.enum(["pre_work_retry", "fresh_qualification"]),
            launchRequest: taskLaunchBodySchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.items.map((item) => item.runId)).size ===
      value.items.length,
    "Source runs must be unique",
  );

type SourceRow = {
  runId: string;
  taskId: string | null;
  title: string;
  sortAt: string;
};

export type AgentRetryBatchScope = {
  projectId: string;
  agentId: string;
  userId: string;
};

async function selectedSources(
  db: Db,
  scope: AgentRetryBatchScope,
  runIds: string[],
): Promise<SourceRow[]> {
  const result =
    await db.execute<SourceRow>(sql`SELECT r.id AS "runId",r.task_id AS "taskId",
    coalesce(t.title,r.id) AS title,
    to_char(coalesce(r.activity_sort_at,r.started_at,'epoch'::timestamptz) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "sortAt"
    FROM runs r LEFT JOIN tasks t ON t.id=r.task_id AND t.project_id=r.project_id
    WHERE r.project_id=${scope.projectId} AND coalesce(r.source_agent_id,r.agent_id)=${scope.agentId}
      AND r.run_kind='agent' AND r.id IN ${runIds}
    ORDER BY coalesce(r.activity_sort_at,r.started_at,'epoch'::timestamptz) DESC,r.id DESC`);

  if (result.rows.length !== runIds.length)
    throw retryRefusal("retry_batch_source_unavailable");

  return result.rows;
}

function refusalReason(error: MaisterError): string {
  return typeof error.details?.reason === "string"
    ? error.details.reason
    : "retry_agent_unavailable";
}

export async function getAgentRetryBatchOptions(
  db: Db,
  scope: AgentRetryBatchScope,
  filter: unknown = {},
): Promise<AgentRetryBatchOptions> {
  await assertRetryAuthority(db, scope.projectId, scope.userId);
  const parsed = filterSchema.safeParse(filter);

  if (!parsed.success)
    throw new MaisterError("CONFIG", "Invalid batch retry preview filters");
  const cursorScope = JSON.stringify([
    "agent-retry-batch",
    scope.projectId,
    scope.agentId,
    scope.userId,
  ]);
  const bounds = parsed.data.cursor
    ? decodeAgentActivityCursor(cursorScope, parsed.data.cursor)
    : {
        upper: (
          await db.execute<{ at: string }>(
            sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`,
          )
        ).rows[0].at,
        at: null,
        id: null,
      };
  const total = await db.execute<{
    total: number;
  }>(sql`SELECT count(*)::integer AS total FROM runs
    WHERE project_id=${scope.projectId} AND coalesce(source_agent_id,agent_id)=${scope.agentId}
      AND run_kind='agent' AND status IN ('Failed','Crashed')`);
  const rows = parsed.data.runIds
    ? await selectedSources(db, scope, parsed.data.runIds)
    : (
        await db.execute<SourceRow>(sql`SELECT r.id AS "runId",r.task_id AS "taskId",coalesce(t.title,r.id) AS title,
        to_char(coalesce(r.activity_sort_at,r.started_at,'epoch'::timestamptz) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "sortAt"
      FROM runs r LEFT JOIN tasks t ON t.id=r.task_id AND t.project_id=r.project_id
      WHERE r.project_id=${scope.projectId} AND coalesce(r.source_agent_id,r.agent_id)=${scope.agentId}
        AND r.run_kind='agent' AND r.status IN ('Failed','Crashed')
        AND coalesce(r.activity_sort_at,r.started_at,'epoch'::timestamptz)<=${bounds.upper}::timestamptz
        ${bounds.at ? sql`AND (coalesce(r.activity_sort_at,r.started_at,'epoch'::timestamptz),r.id)<(${bounds.at}::timestamptz,${bounds.id})` : sql``}
      ORDER BY coalesce(r.activity_sort_at,r.started_at,'epoch'::timestamptz) DESC,r.id DESC LIMIT ${PAGE_SIZE + 1}`)
      ).rows;
  const hasMore = !parsed.data.runIds && rows.length > PAGE_SIZE;
  const page = parsed.data.runIds ? rows : rows.slice(0, PAGE_SIZE);
  const items: AgentRetryBatchItem[] = [];
  const selectedTasks = new Set<string>();

  for (const row of page) {
    try {
      const options = await getAgentRetryOptions(
        db,
        row.runId,
        scope.userId,
        parsed.data.runnerId,
      );
      const duplicate =
        options.eligible &&
        row.taskId !== null &&
        selectedTasks.has(row.taskId);

      if (options.eligible && row.taskId !== null)
        selectedTasks.add(row.taskId);
      items.push({
        runId: row.runId,
        taskId: row.taskId,
        title: row.title,
        options: duplicate
          ? { ...options, eligible: false, reason: "retry_duplicate_task" }
          : options,
        reason: duplicate ? "retry_duplicate_task" : options.reason,
      });
    } catch (error) {
      if (!isMaisterError(error)) throw error;
      if (error.code === "UNAUTHORIZED" || error.code === "UNAUTHENTICATED")
        throw error;
      items.push({
        runId: row.runId,
        taskId: row.taskId,
        title: row.title,
        options: null,
        reason: refusalReason(error),
      });
    }
  }
  const eligible = items.filter((item) => item.options?.eligible);
  const first =
    eligible[0]?.options ?? items.find((item) => item.options)?.options;
  const runners = (first?.runners ?? []).map((runner) => ({
    ...runner,
    ready:
      runner.ready &&
      eligible.every((item) =>
        item.options!.runners.some(
          (candidate) => candidate.id === runner.id && candidate.ready,
        ),
      ),
  }));
  const preferred = first?.selectedRunnerId ?? null;
  const last = page.at(-1);

  return {
    items,
    runners,
    selectedRunnerId: runners.some(
      (runner) => runner.id === preferred && runner.ready,
    )
      ? preferred
      : null,
    totalFailed: total.rows[0].total,
    hasMore,
    nextCursor:
      hasMore && last
        ? encodeAgentActivityCursor(cursorScope, {
            upper: bounds.upper,
            at: last.sortAt,
            id: last.runId,
          })
        : null,
  };
}

export async function acceptAgentRetryBatch(
  db: Db,
  scope: AgentRetryBatchScope,
  body: unknown,
  principal?: InteractiveTaskLaunchPrincipal,
): Promise<AgentRetryBatchResult> {
  await assertRetryAuthority(db, scope.projectId, scope.userId);
  const parsed = requestSchema.safeParse(body);

  if (!parsed.success)
    throw new MaisterError("CONFIG", "Invalid batch retry request");
  const request = parsed.data;

  const sources = await selectedSources(
    db,
    scope,
    request.items.map((item) => item.runId),
  );
  const tasksByRun = new Map(sources.map((item) => [item.runId, item.taskId]));
  const acceptedTasks = new Set<string>();
  const items: AgentRetryBatchResult["items"] = [];

  for (const item of request.items) {
    const taskId = tasksByRun.get(item.runId);

    if (taskId && acceptedTasks.has(taskId)) {
      items.push({
        runId: item.runId,
        receipt: null,
        reason: "retry_duplicate_task",
        state: "refused",
      });
      continue;
    }
    try {
      const { runId, ...acceptance } = item;
      const receipt = await acceptAgentRetry(
        db,
        runId,
        scope.userId,
        {
          ...acceptance,
          runnerId: request.runnerId,
        },
        principal,
      );

      if (taskId && receipt.intentState !== "refused")
        acceptedTasks.add(taskId);
      items.push({
        runId,
        receipt,
        reason: receipt.refusalReason,
        state: receipt.intentState === "refused" ? "refused" : "accepted",
      });
    } catch (error) {
      const known = isMaisterError(error);
      const reason = known ? refusalReason(error) : "retry_unknown";

      log.warn(
        {
          projectId: scope.projectId,
          agentId: scope.agentId,
          runId: item.runId,
          reason,
          known,
        },
        "[FIX:agent-retry] batch item was not confirmed",
      );
      items.push({
        runId: item.runId,
        receipt: null,
        reason,
        state: known ? "refused" : "unknown",
      });
    }
  }
  log.info(
    {
      projectId: scope.projectId,
      agentId: scope.agentId,
      count: items.length,
      accepted: items.filter((item) => item.state === "accepted").length,
    },
    "[FIX:agent-retry] batch acceptance recorded",
  );

  return { items };
}
