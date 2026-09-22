import "server-only";

import type { Logger } from "pino";
import type { SQL } from "drizzle-orm";
import type { Db } from "@/lib/execution-host/db";
import type { PlatformStatus } from "@/types/platform-status";
import type {
  ConsumerLagHostAggregate,
  ExecutionConsumerLag,
  ExecutionEventLagReadModel,
  ExecutionEventStreamLag,
  PoisonedExecutionConsumer,
  StreamLagArithmetic,
} from "@/types/execution-host-observability";

import { performance } from "node:perf_hooks";

import { sql } from "drizzle-orm";
import pino from "pino";

import { calculateStreamLag } from "./lag";

import { TERMINAL_RUN_STATUSES } from "@/lib/runs/run-status-sets";

const STREAM_LIMIT = 20;
const CONSUMER_LIMIT = 20;
const POISON_LIMIT = 20;
const defaultLogger = pino({ name: "execution-event-lag" });

type ConsumerQueryRow = {
  eligible_population: number;
  total_consumers: number;
  maximum_backlog: string;
  diagnostic_count: number;
  top_rows: ConsumerJsonRow[];
  diagnostic_rows: ConsumerJsonRow[];
  by_host: ConsumerHostJsonRow[];
};

type ConsumerJsonRow = {
  consumerName: string;
  runId: string;
  runStatus: string;
  executionHostId: string | null;
  runHorizonSequence: string | null;
  lastRunSequence: string | null;
  backlog: string | null;
  diagnostic: ExecutionConsumerLag["diagnostic"];
  lastServedAt: string | null;
  state: ExecutionConsumerLag["state"];
  nextRetryAt: string | null;
  latestNodeErrorCode: string | null;
};

type ConsumerHostJsonRow = {
  executionHostId: string | null;
  consumerCount: number;
  maximumBacklog: string;
  diagnosticCount: number;
};

type StreamQueryRow = {
  total_count: number;
  stream_row_id: string;
  execution_host_id: string;
  host_key: string;
  display_name: string;
  readiness: string;
  readiness_reason: string | null;
  host_last_seen_at: Date | null;
  host_boot_id: string | null;
  stream_id: string;
  stream_state: ExecutionEventStreamLag["streamState"];
  last_received_sequence: string | null;
  last_contiguous_sequence: string | null;
  last_ack_confirmed_sequence: string | null;
  stream_last_seen_at: Date | null;
  last_error: Record<string, unknown> | null;
  claim_owner: string | null;
  claim_expires_at: Date | null;
  last_boot_id: string | null;
};

type PoisonQueryRow = {
  total_count: number;
  rows: PoisonJsonRow[];
};

type PoisonJsonRow = {
  consumerName: string;
  runId: string;
  runStatus: string;
  poisonEventId: string | null;
  lastRunSequence: string | null;
  errorEventId: string | null;
  errorGeneration: string | null;
  lastErrorReason: string | null;
};

type CommandQueryRow = {
  total: number;
  queued: number;
  delivering: number;
  accepted: number;
  accepted_without_timestamp: number;
  oldest_accepted_at: Date | null;
};

function terminalRunStatusSql(): SQL {
  return sql.join(
    TERMINAL_RUN_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  );
}

export function executionConsumerLagQuery(): SQL {
  return sql`
    WITH eligible_runs AS MATERIALIZED (
      SELECT
        r.id AS run_id,
        r.status AS run_status,
        active_assignment.execution_host_id
      FROM runs r
      LEFT JOIN LATERAL (
        SELECT a.execution_host_id
        FROM execution_assignments a
        WHERE a.run_id = r.id AND a.state = 'active'
        LIMIT 1
      ) active_assignment ON true
      WHERE r.status NOT IN (${terminalRunStatusSql()})
    ), run_horizons AS MATERIALIZED (
      SELECT
        eligible_runs.*,
        horizon.run_horizon_sequence
      FROM eligible_runs
      LEFT JOIN LATERAL (
        SELECT e.run_sequence AS run_horizon_sequence
        FROM execution_events e
        WHERE e.run_id = eligible_runs.run_id
          AND e.ingest_disposition = 'accepted'
          AND e.run_sequence IS NOT NULL
        ORDER BY e.run_sequence DESC
        LIMIT 1
      ) horizon ON true
    ), consumer_lag AS MATERIALIZED (
      SELECT
        c.consumer_name,
        c.run_id,
        h.run_status,
        h.execution_host_id,
        h.run_horizon_sequence,
        c.last_run_sequence,
        -- Cast before subtracting so the -1 empty-horizon sentinel and an
        -- extreme BIGINT cursor cannot overflow signed BIGINT arithmetic.
        CASE
          WHEN COALESCE(c.last_run_sequence, -1)::numeric
            > COALESCE(h.run_horizon_sequence, -1)::numeric THEN NULL
          ELSE COALESCE(h.run_horizon_sequence, -1)::numeric
            - COALESCE(c.last_run_sequence, -1)::numeric
        END AS backlog,
        CASE
          WHEN COALESCE(c.last_run_sequence, -1)::numeric
            > COALESCE(h.run_horizon_sequence, -1)::numeric
          THEN 'cursor_ahead_of_horizon'
          ELSE NULL
        END AS diagnostic,
        c.last_served_at,
        c.state,
        c.next_retry_at
      FROM run_horizons h
      INNER JOIN execution_event_consumers c ON c.run_id = h.run_id
    ), top_rows AS MATERIALIZED (
      SELECT
        c.*,
        latest_attempt.error_code AS latest_node_error_code
      FROM consumer_lag c
      LEFT JOIN LATERAL (
        SELECT n.error_code
        FROM node_attempts n
        WHERE n.run_id = c.run_id
        ORDER BY n.started_at DESC, n.id DESC
        LIMIT 1
      ) latest_attempt ON true
      ORDER BY c.backlog DESC NULLS LAST, c.run_id, c.consumer_name
      LIMIT ${CONSUMER_LIMIT + 1}
    ), diagnostic_rows AS MATERIALIZED (
      SELECT
        c.*,
        latest_attempt.error_code AS latest_node_error_code
      FROM consumer_lag c
      LEFT JOIN LATERAL (
        SELECT n.error_code
        FROM node_attempts n
        WHERE n.run_id = c.run_id
        ORDER BY n.started_at DESC, n.id DESC
        LIMIT 1
      ) latest_attempt ON true
      WHERE c.diagnostic IS NOT NULL
      ORDER BY c.run_id, c.consumer_name
      LIMIT ${CONSUMER_LIMIT}
    ), host_aggregates AS (
      SELECT
        execution_host_id,
        COUNT(*)::int AS consumer_count,
        COALESCE(MAX(backlog), 0)::text AS maximum_backlog,
        COUNT(*) FILTER (WHERE diagnostic IS NOT NULL)::int AS diagnostic_count
      FROM consumer_lag
      GROUP BY execution_host_id
    )
    SELECT
      (SELECT COUNT(*)::int FROM eligible_runs) AS eligible_population,
      (SELECT COUNT(*)::int FROM consumer_lag) AS total_consumers,
      COALESCE((SELECT MAX(backlog)::text FROM consumer_lag), '0') AS maximum_backlog,
      (SELECT COUNT(*)::int FROM consumer_lag WHERE diagnostic IS NOT NULL) AS diagnostic_count,
      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'consumerName', t.consumer_name,
            'runId', t.run_id,
            'runStatus', t.run_status,
            'executionHostId', t.execution_host_id,
            'runHorizonSequence', t.run_horizon_sequence::text,
            'lastRunSequence', t.last_run_sequence::text,
            'backlog', t.backlog::text,
            'diagnostic', t.diagnostic,
            'lastServedAt', t.last_served_at,
            'state', t.state,
            'nextRetryAt', t.next_retry_at,
            'latestNodeErrorCode', t.latest_node_error_code
          ) ORDER BY t.backlog DESC, t.run_id, t.consumer_name
        ) FROM top_rows t
      ), '[]'::jsonb) AS top_rows,
      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'consumerName', d.consumer_name,
            'runId', d.run_id,
            'runStatus', d.run_status,
            'executionHostId', d.execution_host_id,
            'runHorizonSequence', d.run_horizon_sequence::text,
            'lastRunSequence', d.last_run_sequence::text,
            'backlog', d.backlog::text,
            'diagnostic', d.diagnostic,
            'lastServedAt', d.last_served_at,
            'state', d.state,
            'nextRetryAt', d.next_retry_at,
            'latestNodeErrorCode', d.latest_node_error_code
          ) ORDER BY d.run_id, d.consumer_name
        ) FROM diagnostic_rows d
      ), '[]'::jsonb) AS diagnostic_rows,
      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'executionHostId', h.execution_host_id,
            'consumerCount', h.consumer_count,
            'maximumBacklog', h.maximum_backlog,
            'diagnosticCount', h.diagnostic_count
          ) ORDER BY h.execution_host_id NULLS FIRST
        ) FROM host_aggregates h
      ), '[]'::jsonb) AS by_host
  `;
}

function executionStreamsQuery(): SQL {
  return sql`
    SELECT
      COUNT(*) OVER ()::int AS total_count,
      s.id AS stream_row_id,
      s.execution_host_id,
      h.host_key,
      h.display_name,
      h.readiness,
      h.readiness_reason,
      h.last_seen_at AS host_last_seen_at,
      h.last_boot_id AS host_boot_id,
      s.stream_id,
      s.state AS stream_state,
      s.last_received_sequence::text,
      s.last_contiguous_sequence::text,
      s.last_ack_confirmed_sequence::text,
      s.last_seen_at AS stream_last_seen_at,
      s.last_error,
      s.claim_owner,
      s.claim_expires_at,
      s.last_boot_id
    FROM execution_event_streams s
    INNER JOIN execution_hosts h ON h.id = s.execution_host_id
    ORDER BY (s.state = 'active') DESC, s.created_at DESC, s.id DESC
    LIMIT ${STREAM_LIMIT}
  `;
}

function poisonQuery(after?: { runId: string; consumerName: string }): SQL {
  const afterPredicate = after
    ? sql`AND (c.run_id, c.consumer_name) > (${after.runId}, ${after.consumerName})`
    : sql``;

  return sql`
    WITH poison_total AS (
      SELECT COUNT(*)::int AS total_count
      FROM execution_event_consumers
      WHERE state = 'poisoned'
    ), poison_page AS (
      SELECT
        c.consumer_name,
        c.run_id,
        r.status AS run_status,
        c.poison_event_id,
        c.last_run_sequence,
        c.last_error->>'eventId' AS error_event_id,
        c.last_error->>'errorGeneration' AS error_generation,
        c.last_error->>'reason' AS last_error_reason
      FROM execution_event_consumers c
      INNER JOIN runs r ON r.id = c.run_id
      WHERE c.state = 'poisoned' ${afterPredicate}
      ORDER BY c.run_id, c.consumer_name
      LIMIT ${POISON_LIMIT + 1}
    )
    SELECT
      poison_total.total_count,
      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'consumerName', p.consumer_name,
            'runId', p.run_id,
            'runStatus', p.run_status,
            'poisonEventId', p.poison_event_id,
            'lastRunSequence', p.last_run_sequence::text,
            'errorEventId', p.error_event_id,
            'errorGeneration', p.error_generation,
            'lastErrorReason', p.last_error_reason
          ) ORDER BY p.run_id, p.consumer_name
        ) FROM poison_page p
      ), '[]'::jsonb) AS rows
    FROM poison_total
  `;
}

function commandsQuery(): SQL {
  return sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE state = 'queued')::int AS queued,
      COUNT(*) FILTER (WHERE state = 'delivering')::int AS delivering,
      COUNT(*) FILTER (WHERE state = 'accepted')::int AS accepted,
      COUNT(*) FILTER (
        WHERE state = 'accepted' AND accepted_at IS NULL
      )::int AS accepted_without_timestamp,
      MIN(accepted_at) FILTER (
        WHERE state = 'accepted' AND accepted_at IS NOT NULL
      ) AS oldest_accepted_at
    FROM execution_commands
    WHERE state IN ('queued', 'delivering', 'accepted')
  `;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;

  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function ageMs(now: Date, value: Date | string | null): number | null {
  if (value === null) return null;

  return Math.max(0, now.getTime() - new Date(value).getTime());
}

function managerOnlyLag(row: StreamQueryRow): StreamLagArithmetic {
  const arithmetic = calculateStreamLag({
    headSequence: row.last_received_sequence,
    lastReceivedSequence: row.last_received_sequence,
    lastContiguousSequence: row.last_contiguous_sequence,
    lastAckConfirmedSequence: row.last_ack_confirmed_sequence,
  });

  return { ...arithmetic, hostToManager: null };
}

function streamTelemetry(
  row: StreamQueryRow,
  health: PlatformStatus,
): Pick<
  ExecutionEventStreamLag,
  "hostTelemetry" | "hostTelemetryStatus" | "hostTelemetryReason" | "lag"
> {
  if (health.kind !== "ready") {
    return {
      hostTelemetry: null,
      hostTelemetryStatus: "unavailable",
      hostTelemetryReason: health.reason,
      lag: managerOnlyLag(row),
    };
  }
  if (health.health.host === undefined) {
    return {
      hostTelemetry: null,
      hostTelemetryStatus: "unsupported",
      hostTelemetryReason: "host_identity_absent",
      lag: managerOnlyLag(row),
    };
  }
  if (health.health.host.hostKey !== row.host_key) {
    return {
      hostTelemetry: null,
      hostTelemetryStatus: "unsupported",
      hostTelemetryReason: "historical_host",
      lag: managerOnlyLag(row),
    };
  }
  if (health.health.stream === undefined) {
    return {
      hostTelemetry: null,
      hostTelemetryStatus: "unsupported",
      hostTelemetryReason: "stream_health_absent",
      lag: managerOnlyLag(row),
    };
  }
  const telemetry = {
    ...health.health.stream,
    sampledAt: health.health.checkedAt,
    bootId: health.health.host.bootId,
  };

  if (telemetry.streamId !== row.stream_id) {
    return {
      hostTelemetry: telemetry,
      hostTelemetryStatus: "stale",
      hostTelemetryReason: "stream_identity_mismatch",
      lag: managerOnlyLag(row),
    };
  }
  if (row.last_boot_id !== null && telemetry.bootId !== row.last_boot_id) {
    return {
      hostTelemetry: telemetry,
      hostTelemetryStatus: "stale",
      hostTelemetryReason: "boot_identity_mismatch",
      lag: managerOnlyLag(row),
    };
  }

  return {
    hostTelemetry: telemetry,
    hostTelemetryStatus: "available",
    hostTelemetryReason: null,
    lag: calculateStreamLag({
      headSequence: telemetry.headSequence,
      lastReceivedSequence: row.last_received_sequence,
      lastContiguousSequence: row.last_contiguous_sequence,
      lastAckConfirmedSequence: row.last_ack_confirmed_sequence,
    }),
  };
}

function mapStream(
  row: StreamQueryRow,
  health: PlatformStatus,
): ExecutionEventStreamLag {
  return {
    streamRowId: row.stream_row_id,
    executionHostId: row.execution_host_id,
    hostKey: row.host_key,
    displayName: row.display_name,
    readiness: row.readiness,
    readinessReason: row.readiness_reason,
    hostLastSeenAt: iso(row.host_last_seen_at),
    hostBootId: row.host_boot_id,
    streamId: row.stream_id,
    streamState: row.stream_state,
    lastReceivedSequence: row.last_received_sequence,
    lastContiguousSequence: row.last_contiguous_sequence,
    lastAckConfirmedSequence: row.last_ack_confirmed_sequence,
    streamLastSeenAt: iso(row.stream_last_seen_at),
    lastError: row.last_error,
    claimOwner: row.claim_owner,
    claimExpiresAt: iso(row.claim_expires_at),
    ...streamTelemetry(row, health),
  };
}

function mapConsumer(row: ConsumerJsonRow, now: Date): ExecutionConsumerLag {
  return {
    ...row,
    lastServedAt: iso(row.lastServedAt),
    nextRetryAt: iso(row.nextRetryAt),
    serviceAgeMs: ageMs(now, row.lastServedAt),
  };
}

function mapPoison(row: PoisonJsonRow): PoisonedExecutionConsumer {
  return row;
}

export async function collectExecutionEventLag(input: {
  db: Db;
  health: PlatformStatus;
  now?: Date;
  poisonAfter?: { runId: string; consumerName: string };
  logger?: Logger;
  preferredStream?: { executionHostId: string; streamId: string } | null;
}): Promise<ExecutionEventLagReadModel> {
  const startedAt = performance.now();
  const sampledAt = input.now ?? new Date();
  const logger = input.logger ?? defaultLogger;

  try {
    const model = await input.db.transaction(async (tx) => {
      await tx.execute(
        sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`,
      );
      await tx.execute(sql`SET LOCAL statement_timeout = '2000ms'`);
      const streamResult = await tx.execute<StreamQueryRow>(
        executionStreamsQuery(),
      );
      const preferredStreamRows =
        input.preferredStream &&
        !streamResult.rows.some(
          (row) =>
            row.execution_host_id === input.preferredStream?.executionHostId &&
            row.stream_id === input.preferredStream.streamId,
        )
          ? await tx.execute<StreamQueryRow>(sql`
              SELECT
                1::int AS total_count,
                s.id AS stream_row_id,
                s.execution_host_id,
                h.host_key,
                h.display_name,
                h.readiness,
                h.readiness_reason,
                h.last_seen_at AS host_last_seen_at,
                h.last_boot_id AS host_boot_id,
                s.stream_id,
                s.state AS stream_state,
                s.last_received_sequence::text,
                s.last_contiguous_sequence::text,
                s.last_ack_confirmed_sequence::text,
                s.last_seen_at AS stream_last_seen_at,
                s.last_error,
                s.claim_owner,
                s.claim_expires_at,
                s.last_boot_id
              FROM execution_event_streams s
              INNER JOIN execution_hosts h ON h.id = s.execution_host_id
              WHERE s.execution_host_id = ${input.preferredStream.executionHostId}
                AND s.stream_id = ${input.preferredStream.streamId}
              LIMIT 1
            `)
          : null;
      const consumerResult = await tx.execute<ConsumerQueryRow>(
        executionConsumerLagQuery(),
      );
      const poisonResult = await tx.execute<PoisonQueryRow>(
        poisonQuery(input.poisonAfter),
      );
      const commandResult = await tx.execute<CommandQueryRow>(commandsQuery());
      const consumer = consumerResult.rows[0];
      const poison = poisonResult.rows[0];
      const commands = commandResult.rows[0];

      if (
        consumer === undefined ||
        poison === undefined ||
        commands === undefined
      ) {
        throw new Error("execution event lag aggregate query returned no row");
      }

      const topRows = consumer.top_rows.slice(0, CONSUMER_LIMIT);
      const poisonRows = poison.rows.slice(0, POISON_LIMIT);
      const poisonHasNext = poison.rows.length > POISON_LIMIT;
      const poisonLast = poisonRows.at(-1);

      return {
        sampledAt: sampledAt.toISOString(),
        streams: [
          ...streamResult.rows,
          ...(preferredStreamRows?.rows ?? []),
        ].map((row) => mapStream(row, input.health)),
        consumers: {
          eligiblePopulation: consumer.eligible_population,
          totalConsumers: consumer.total_consumers,
          displayed: topRows.length,
          truncated: Math.max(0, consumer.total_consumers - topRows.length),
          maximumBacklog: consumer.maximum_backlog,
          diagnosticCount: consumer.diagnostic_count,
          byHost: consumer.by_host.map((row): ConsumerLagHostAggregate => row),
          top: topRows.map((row) => mapConsumer(row, sampledAt)),
          diagnostics: consumer.diagnostic_rows.map((row) =>
            mapConsumer(row, sampledAt),
          ),
        },
        poison: {
          total: poison.total_count,
          displayed: poisonRows.length,
          nextAfter:
            poisonHasNext && poisonLast
              ? {
                  runId: poisonLast.runId,
                  consumerName: poisonLast.consumerName,
                }
              : null,
          rows: poisonRows.map(mapPoison),
        },
        commands: {
          total: commands.total,
          queued: commands.queued,
          delivering: commands.delivering,
          accepted: commands.accepted,
          acceptedWithoutTimestamp: commands.accepted_without_timestamp,
          oldestAcceptedAt: iso(commands.oldest_accepted_at),
          oldestAcceptedAgeMs: ageMs(sampledAt, commands.oldest_accepted_at),
        },
      } satisfies ExecutionEventLagReadModel;
    });

    logger.debug(
      {
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        streams: model.streams.length,
        eligibleRuns: model.consumers.eligiblePopulation,
        consumers: model.consumers.totalConsumers,
        poison: model.poison.total,
        openCommands: model.commands.total,
      },
      "execution-event-lag-collected",
    );

    return model;
  } catch (error) {
    logger.warn(
      {
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        err: error,
      },
      "execution-event-lag-collection-failed",
    );
    throw error;
  }
}
