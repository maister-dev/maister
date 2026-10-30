import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { AgentIncidentScopeKind } from "@/lib/agents/activity-types";
import type { ActivityPage } from "@/lib/agents/activity-queries";

import { createHash } from "node:crypto";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import pino from "pino";
import { z } from "zod";

import {
  agentIncidentEpisodes,
  agentIncidentReaderStates,
} from "@/lib/db/schema";
import {
  decodeAgentActivityCursor,
  encodeAgentActivityCursor,
} from "@/lib/agents/activity-cursor";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "agent-incident-projection",
  level: process.env.LOG_LEVEL ?? "info",
});

export type AgentIncidentEpisode = {
  episodeId: string;
  attentionRevision: number;
  reasonCode: string;
  scopeKind: AgentIncidentScopeKind;
  state: "open" | "resolved";
  firstAt: string;
  lastAt: string;
  occurrenceCount: number;
  acknowledged: boolean;
  representativeRunId: string | null;
  remediationCode: string | null;
};

export type AgentIncidentGroup = {
  aggregation: "agent";
  groupId: string;
  projectId: string;
  projectSlug: string;
  agentId: string;
  title: string;
  contentRevision: string;
  unreadEpisodeCount: number;
  totalCauseCount: number;
  failedRunCount: number;
  attemptCount: number;
  representativeRunId: string | null;
  episodes: AgentIncidentEpisode[];
  nextCursor: string | null;
};

export type AgentIncidentGroupRecord = AgentIncidentGroup & {
  since: Date | null;
};

const timestamp = (
  expression: ReturnType<typeof sql>,
): ReturnType<typeof sql<string>> =>
  sql<string>`to_char(${expression} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export function episodeReadCte(
  userId: string,
  projectIds: readonly string[],
): ReturnType<typeof sql> {
  return sql`
    SELECT e.*,
      (reader.acknowledged_at IS NOT NULL OR
        (EXISTS (SELECT 1 FROM agent_incident_occurrences o WHERE o.episode_id=e.id)
         AND NOT EXISTS (SELECT 1 FROM agent_incident_occurrences o
           WHERE o.episode_id=e.id AND NOT EXISTS (
             SELECT 1 FROM agent_incident_occurrence_readers legacy
             WHERE legacy.occurrence_id=o.id AND legacy.user_id=${userId})))) AS acknowledged,
      (SELECT count(*)::int FROM agent_incident_occurrences o WHERE o.episode_id=e.id) AS occurrence_count,
      (SELECT o.run_id FROM agent_incident_occurrences o
        JOIN runs r ON r.id=o.run_id AND r.project_id=e.project_id
        WHERE o.episode_id=e.id ORDER BY o.observed_at DESC,o.id DESC LIMIT 1) AS representative_run_id
    FROM agent_incident_episodes e
    LEFT JOIN agent_incident_reader_states reader ON reader.episode_id=e.id
      AND reader.user_id=${userId} AND reader.attention_revision=e.attention_revision
    WHERE e.project_id IN ${[...projectIds]}
  `;
}

function episodeJson(alias: string): ReturnType<typeof sql> {
  const column = (name: string): ReturnType<typeof sql> =>
    sql`${sql.identifier(alias)}.${sql.identifier(name)}`;

  return sql`jsonb_build_object(
    'episodeId',${column("id")},'attentionRevision',${column("attention_revision")},
    'reasonCode',${column("reason_code")},'scopeKind',${column("scope_kind")},'state',${column("state")},
    'firstAt',${timestamp(column("first_at"))},'lastAt',${timestamp(column("last_at"))},
    'occurrenceCount',${column("occurrence_count")},'acknowledged',${column("acknowledged")},
    'representativeRunId',${column("representative_run_id")},'remediationCode',${column("reason_code")})`;
}

function incidentCursorScope(input: {
  projectId: string;
  agentId: string;
  userId: string;
  state?: string;
  acknowledged?: boolean;
}): string {
  return JSON.stringify([
    "incidents",
    input.projectId,
    input.agentId,
    input.userId,
    input.state ?? null,
    input.acknowledged ?? null,
  ]);
}

/** Aggregate before queue sorting/counting; only the first ten unseen causes enter each wire payload. */
export async function listAgentIncidentGroups(
  db: Db,
  userId: string,
  projectIds: readonly string[],
): Promise<AgentIncidentGroupRecord[]> {
  if (!projectIds.length) return [];
  const result = await db.execute<{
    project_id: string;
    project_slug: string;
    agent_id: string;
    title: string;
    total: number;
    unread: number;
    failed_runs: number;
    attempts: number;
    representative_run_id: string | null;
    episodes: AgentIncidentEpisode[];
    since: string | null;
    upper: string;
    revision: string;
  }>(sql`
    WITH all_episodes AS (${episodeReadCte(userId, projectIds)}),
    open_episodes AS (SELECT * FROM all_episodes WHERE state='open'),
    unseen AS (
      SELECT *,row_number() OVER (PARTITION BY project_id,source_agent_id ORDER BY last_at DESC,id DESC) AS position
      FROM open_episodes WHERE NOT acknowledged
    ), totals AS (
      SELECT project_id,source_agent_id,count(*)::int AS total,
        count(*) FILTER (WHERE NOT acknowledged)::int AS unread,
        md5(string_agg(id||':'||content_revision::text||':'||acknowledged::text,',' ORDER BY id)) AS revision
      FROM open_episodes GROUP BY project_id,source_agent_id
    ), counts AS (
      SELECT e.project_id,e.source_agent_id,
        count(DISTINCT o.original_run_id) FILTER (WHERE o.channel IN ('operational_terminal','execution_failure'))::int AS failed_runs,
        count(DISTINCT o.source_fact_key) FILTER (WHERE o.channel='admission_refusal')::int AS attempts
      FROM open_episodes e JOIN agent_incident_occurrences o ON o.episode_id=e.id
      GROUP BY e.project_id,e.source_agent_id
    )
    SELECT totals.project_id,p.slug AS project_slug,totals.source_agent_id AS agent_id,
      coalesce((SELECT r.agent_activity_snapshot->>'displayName' FROM runs r
        WHERE r.project_id=totals.project_id AND r.source_agent_id=totals.source_agent_id
        ORDER BY r.activity_sort_at DESC,r.id DESC LIMIT 1),a.name,totals.source_agent_id) AS title,
      totals.total,totals.unread,totals.revision,
      coalesce(counts.failed_runs,0) AS failed_runs,coalesce(counts.attempts,0) AS attempts,
      (SELECT o.run_id FROM unseen e JOIN agent_incident_occurrences o ON o.episode_id=e.id
        JOIN runs r ON r.id=o.run_id AND r.project_id=e.project_id
        WHERE e.project_id=totals.project_id AND e.source_agent_id=totals.source_agent_id
        ORDER BY o.observed_at DESC,o.id DESC LIMIT 1) AS representative_run_id,
      min(unseen.first_at)::text AS since,
      ${timestamp(sql`greatest(clock_timestamp(),max(unseen.last_at))`)} AS upper,
      jsonb_agg(${episodeJson("unseen")} ORDER BY unseen.last_at DESC,unseen.id DESC)
        FILTER (WHERE unseen.position<=10) AS episodes
    FROM totals JOIN projects p ON p.id=totals.project_id AND p.archived_at IS NULL
    LEFT JOIN agents a ON a.id=totals.source_agent_id
    JOIN unseen ON unseen.project_id=totals.project_id AND unseen.source_agent_id=totals.source_agent_id
    LEFT JOIN counts ON counts.project_id=totals.project_id AND counts.source_agent_id=totals.source_agent_id
    WHERE totals.unread>0
    GROUP BY totals.project_id,p.slug,totals.source_agent_id,a.name,totals.total,totals.unread,
      totals.revision,counts.failed_runs,counts.attempts
    ORDER BY min(unseen.first_at),totals.project_id,totals.source_agent_id
  `);

  return result.rows.map((row) => {
    const groupId = `agent:${createHash("sha256")
      .update(JSON.stringify([row.project_id, row.agent_id]))
      .digest("hex")}`;
    const last = row.episodes.at(-1);
    const contentRevision = createHash("sha256")
      .update(
        JSON.stringify([
          row.revision,
          row.failed_runs,
          row.attempts,
          row.representative_run_id,
          row.episodes,
        ]),
      )
      .digest("hex");
    const scope = incidentCursorScope({
      projectId: row.project_id,
      agentId: row.agent_id,
      userId,
      state: "open",
      acknowledged: false,
    });

    return {
      aggregation: "agent",
      groupId,
      projectId: row.project_id,
      projectSlug: row.project_slug,
      agentId: row.agent_id,
      title: row.title.slice(0, 256),
      contentRevision,
      unreadEpisodeCount: row.unread,
      totalCauseCount: row.total,
      failedRunCount: row.failed_runs,
      attemptCount: row.attempts,
      representativeRunId: row.representative_run_id,
      episodes: row.episodes,
      since: row.since ? new Date(row.since) : null,
      nextCursor:
        row.unread > 10 && last
          ? encodeAgentActivityCursor(scope, {
              upper: row.upper,
              at: last.lastAt,
              id: last.episodeId,
            })
          : null,
    };
  });
}

const pageSchema = z
  .object({
    projectId: z.string().min(1).max(256),
    agentId: z.string().min(1).max(256),
    userId: z.string().min(1).max(256),
    limit: z.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).max(2048).optional(),
    state: z.enum(["open", "resolved"]).optional(),
    acknowledged: z.boolean().optional(),
  })
  .strict();

export async function listAgentIncidentPage(
  db: Db,
  input: z.input<typeof pageSchema>,
): Promise<ActivityPage<AgentIncidentEpisode>> {
  const parsed = pageSchema.safeParse(input);

  if (!parsed.success)
    throw new MaisterError("CONFIG", "Invalid incident history filters");
  const request = parsed.data;
  const scope = incidentCursorScope(request);
  const prior = request.cursor
    ? decodeAgentActivityCursor(scope, request.cursor)
    : null;
  const upper =
    prior?.upper ??
    (
      await db.execute<{ at: string }>(
        sql`SELECT ${timestamp(sql`greatest(clock_timestamp(),coalesce(max(last_at),clock_timestamp()))`)} AS at FROM agent_incident_episodes WHERE project_id=${request.projectId} AND source_agent_id=${request.agentId}`,
      )
    ).rows[0].at;
  const result = await db.execute<{ value: AgentIncidentEpisode }>(sql`
    WITH episodes AS (${episodeReadCte(request.userId, [request.projectId])})
    SELECT ${episodeJson("e")} AS value FROM episodes e
    WHERE e.source_agent_id=${request.agentId} AND e.last_at<=${upper}::timestamptz
      ${request.state === undefined ? sql`` : sql`AND e.state=${request.state}`}
      ${request.acknowledged === undefined ? sql`` : sql`AND e.acknowledged=${request.acknowledged}`}
      ${prior ? sql`AND (e.last_at,e.id)<(${prior.at}::timestamptz,${prior.id})` : sql``}
    ORDER BY e.last_at DESC,e.id DESC LIMIT ${request.limit + 1}
  `);
  const items = result.rows.slice(0, request.limit).map((row) => row.value);
  const last = items.at(-1);

  return {
    items,
    asOf: upper,
    nextCursor:
      result.rows.length > request.limit && last
        ? encodeAgentActivityCursor(scope, {
            upper,
            at: last.lastAt,
            id: last.episodeId,
          })
        : null,
  };
}

export const agentEpisodeAcknowledgementSchema = z
  .object({
    episodes: z
      .array(
        z
          .object({
            episodeId: z.string().uuid(),
            attentionRevision: z.number().int().min(1).max(2147483647),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.episodes.map((episode) => episode.episodeId)).size ===
      value.episodes.length,
    { message: "Episode IDs must be unique" },
  );

/** Locks only episodes, in deterministic order; never acquires a source-run lock. */
export async function acknowledgeAgentEpisodes(
  db: Db,
  input: {
    projectId: string;
    agentId: string;
    userId: string;
    episodes: Array<{ episodeId: string; attentionRevision: number }>;
  },
): Promise<{ acknowledged: number }> {
  const parsed = agentEpisodeAcknowledgementSchema.safeParse({
    episodes: input.episodes,
  });

  if (!parsed.success)
    throw new MaisterError("CONFIG", "Invalid episode acknowledgement batch");

  return db.transaction(async (tx) => {
    const ids = parsed.data.episodes.map((episode) => episode.episodeId).sort();
    const episodes = await tx
      .select()
      .from(agentIncidentEpisodes)
      .where(
        and(
          eq(agentIncidentEpisodes.projectId, input.projectId),
          eq(agentIncidentEpisodes.sourceAgentId, input.agentId),
          inArray(agentIncidentEpisodes.id, ids),
        ),
      )
      .orderBy(agentIncidentEpisodes.id)
      .for("update");
    const revisions = new Map(
      parsed.data.episodes.map((episode) => [
        episode.episodeId,
        episode.attentionRevision,
      ]),
    );

    if (
      episodes.length !== ids.length ||
      episodes.some(
        (episode) => revisions.get(episode.id) !== episode.attentionRevision,
      )
    ) {
      log.info(
        {
          projectId: input.projectId,
          agentId: input.agentId,
          userId: input.userId,
          episodeIds: ids,
        },
        "agent-episode-acknowledgement-refused",
      );
      throw new MaisterError(
        "CONFLICT",
        "Episode identity or observed attention revision is stale",
        { details: { reason: "agent_episode_stale" } },
      );
    }
    const open = episodes.filter((episode) => episode.state === "open");

    if (!open.length) return { acknowledged: 0 };
    const changed = await tx
      .insert(agentIncidentReaderStates)
      .values(
        open.map((episode) => ({
          userId: input.userId,
          episodeId: episode.id,
          attentionRevision: episode.attentionRevision,
          acknowledgedAt: new Date(),
        })),
      )
      .onConflictDoUpdate({
        target: [
          agentIncidentReaderStates.userId,
          agentIncidentReaderStates.episodeId,
          agentIncidentReaderStates.attentionRevision,
        ],
        set: { acknowledgedAt: new Date() },
        setWhere: isNull(agentIncidentReaderStates.acknowledgedAt),
      })
      .returning({ episodeId: agentIncidentReaderStates.episodeId });

    for (const receipt of changed) {
      const episode = episodes.find((row) => row.id === receipt.episodeId)!;

      await emitDomainEvent({
        db: tx,
        kind: "agent.incident_changed",
        projectId: input.projectId,
        actor: { type: "user", id: input.userId },
        payload: {
          projectId: input.projectId,
          agentId: input.agentId,
          episodeId: episode.id,
          revision: episode.contentRevision,
        },
      });
    }
    log.info(
      {
        projectId: input.projectId,
        agentId: input.agentId,
        userId: input.userId,
        episodeIds: ids,
        changed: changed.length,
      },
      "agent-episodes-acknowledged",
    );

    return { acknowledged: open.length };
  });
}

/** Explicit wire projection omits the queue-only ordering timestamp. */
export function agentIncidentGroupDto(
  group: AgentIncidentGroupRecord,
): AgentIncidentGroup {
  const { since: _since, ...value } = group;

  return value;
}
