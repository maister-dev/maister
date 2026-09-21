import "server-only";

import type { Logger } from "pino";
import type { Db } from "@/lib/execution-host/db";

import { and, eq, inArray, lt, sql } from "drizzle-orm";

import {
  executionCommands,
  executionEventConsumers,
  executionEventStreams,
  executionHosts,
} from "@/lib/db/schema";
import { getDb } from "@/lib/db/client";
import { eventStreamStallSeconds } from "@/lib/instance-config";

export type StalledStream = {
  streamRowId: string;
  streamId: string;
  executionHostId: string;
  lastSeenAt: Date | null;
  openCommands: number;
};

// There is NO heartbeat event type: every runtime event is session- or
// runtime_object-scoped, and one stream row serves a whole host. A quiet host is
// therefore normal and "last_seen_at is old" alone means nothing. What is never
// normal is open work that should be producing events while none arrive — that
// conjunction is the stall, and it is the same predicate the command-impasse
// signal needs.
export async function findStalledEventStreams(input: {
  db: Db;
  now?: Date;
  stallSeconds?: number;
}): Promise<StalledStream[]> {
  const now = input.now ?? new Date();
  const stallSeconds = input.stallSeconds ?? eventStreamStallSeconds();
  const cutoff = new Date(now.getTime() - stallSeconds * 1000);

  const rows = await input.db
    .select({
      streamRowId: executionEventStreams.id,
      streamId: executionEventStreams.streamId,
      executionHostId: executionEventStreams.executionHostId,
      lastSeenAt: executionEventStreams.lastSeenAt,
      openCommands: sql<number>`(
        select count(*)::int from ${executionCommands}
         where ${executionCommands.executionHostId} = ${executionEventStreams.executionHostId}
           and ${executionCommands.state} in ('delivering', 'accepted')
      )`,
    })
    .from(executionEventStreams)
    .innerJoin(
      executionHosts,
      eq(executionHosts.id, executionEventStreams.executionHostId),
    )
    .where(
      and(
        eq(executionEventStreams.state, "active"),
        eq(executionHosts.readiness, "ready"),
        lt(executionEventStreams.lastSeenAt, cutoff),
      ),
    );

  return rows.filter((row) => row.openCommands > 0);
}

export type StreamHealthSweepSummary = {
  checked: number;
  stalled: number;
  degraded: number;
  /** Projection consumers parked on an event they cannot apply. A poisoned row
   * never advances its cursor, so that run's read model is frozen until an
   * operator rearms it — which nothing surfaced before. */
  poisonedConsumers: number;
  errors: string[];
};

/** Report every poisoned projector cursor. Poison is deliberately terminal
 * (`execution-event-plane.md`: it never advances the cursor or skips evidence),
 * so the only thing missing was somebody saying so out loud. */
export async function reportPoisonedConsumers(input: {
  db: Db;
  logger?: Logger;
}): Promise<{ count: number; errors: string[] }> {
  const rows = await input.db
    .select({
      consumerName: executionEventConsumers.consumerName,
      runId: executionEventConsumers.runId,
      poisonEventId: executionEventConsumers.poisonEventId,
      lastRunSequence: executionEventConsumers.lastRunSequence,
      lastError: executionEventConsumers.lastError,
    })
    .from(executionEventConsumers)
    .where(eq(executionEventConsumers.state, "poisoned"));

  for (const row of rows)
    input.logger?.warn(
      {
        consumerName: row.consumerName,
        runId: row.runId,
        poisonEventId: row.poisonEventId,
        cursor: row.lastRunSequence?.toString() ?? null,
        reason:
          typeof row.lastError?.reason === "string"
            ? row.lastError.reason
            : null,
      },
      "execution-projection-consumer-poisoned",
    );

  return {
    count: rows.length,
    errors: rows.map(
      (row) =>
        `projection consumer ${row.consumerName} is poisoned for run ${row.runId}`,
    ),
  };
}

/**
 * Degrade a stalled stream to `lost`. This is the LAST move, not the first: the
 * caller restarts the consumer loop and only degrades a stream that a restarted
 * loop still cannot advance, so `lost` always means automatic repair failed.
 */
export async function degradeStalledStream(input: {
  db: Db;
  stream: StalledStream;
  now?: Date;
  logger?: Logger;
}): Promise<boolean> {
  const updated = await input.db
    .update(executionEventStreams)
    .set({
      state: "lost",
      lastError: {
        reason: "stream_stalled",
        openCommands: input.stream.openCommands,
        lastSeenAt: input.stream.lastSeenAt?.toISOString() ?? null,
      },
    })
    .where(
      and(
        eq(executionEventStreams.id, input.stream.streamRowId),
        eq(executionEventStreams.state, "active"),
      ),
    )
    .returning({ id: executionEventStreams.id });

  if (!updated[0]) return false;
  input.logger?.warn(
    {
      hostId: input.stream.executionHostId,
      streamId: input.stream.streamId,
      lastSeenAt: input.stream.lastSeenAt,
      openCommands: input.stream.openCommands,
    },
    "runtime-event-stream-lost",
  );

  return true;
}

async function markRepairAttempted(input: {
  db: Db;
  stream: StalledStream;
}): Promise<void> {
  await input.db
    .update(executionEventStreams)
    .set({
      lastError: {
        reason: STALL_REPAIR_REASON,
        openCommands: input.stream.openCommands,
        lastSeenAt: input.stream.lastSeenAt?.toISOString() ?? null,
      },
    })
    .where(eq(executionEventStreams.id, input.stream.streamRowId));
}

const STALL_REPAIR_REASON = "stream_stall_repair_attempted";

/**
 * Repair first, degrade only if repair failed.
 *
 * Pass 1 on a stalled stream restarts its consumer loop and records that it
 * tried. If the restarted loop makes progress, `last_seen_at` moves and the
 * stream never reaches pass 2 — that is the self-heal the 2026-09-16 outage
 * lacked. A stream still stalled on the next pass is one automatic repair could
 * not fix, and only then is it marked `lost`.
 */
export async function runEventStreamHealthPass(input: {
  db: Db;
  restartConsumer: (executionHostId: string) => Promise<void> | void;
  now?: Date;
  stallSeconds?: number;
  logger?: Logger;
}): Promise<StreamHealthSweepSummary> {
  const summary: StreamHealthSweepSummary = {
    checked: 0,
    stalled: 0,
    degraded: 0,
    poisonedConsumers: 0,
    errors: [],
  };
  const poisoned = await reportPoisonedConsumers({
    db: input.db,
    logger: input.logger,
  });

  summary.poisonedConsumers = poisoned.count;
  summary.errors.push(...poisoned.errors);
  const stalled = await findStalledEventStreams({
    db: input.db,
    now: input.now,
    stallSeconds: input.stallSeconds,
  });

  summary.checked = stalled.length;

  for (const stream of stalled) {
    summary.stalled += 1;
    try {
      const [row] = await input.db
        .select({ lastError: executionEventStreams.lastError })
        .from(executionEventStreams)
        .where(eq(executionEventStreams.id, stream.streamRowId))
        .limit(1);
      const repairTried = row?.lastError?.reason === STALL_REPAIR_REASON;

      if (!repairTried) {
        await markRepairAttempted({ db: input.db, stream });
        await input.restartConsumer(stream.executionHostId);
        input.logger?.warn(
          {
            hostId: stream.executionHostId,
            streamId: stream.streamId,
            lastSeenAt: stream.lastSeenAt,
            openCommands: stream.openCommands,
          },
          "runtime-event-stream-stalled-restarting",
        );
        continue;
      }
      if (
        await degradeStalledStream({
          db: input.db,
          stream,
          logger: input.logger,
        })
      )
        summary.degraded += 1;
    } catch (err) {
      summary.errors.push(
        `event stream health pass failed for ${stream.streamId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return summary;
}

/** The `system_sweep` entry point: resolves the process db and the repair action
 * itself, so it matches every other pass in that bundle. */
export async function runEventStreamHealthSweep(
  input: {
    logger?: Logger;
  } = {},
): Promise<StreamHealthSweepSummary> {
  const { abortRuntimeEventConsumer } = await import("./consumer");
  const { ensureLocalExecutionDataPlane } = await import("../event-plane");

  return runEventStreamHealthPass({
    db: getDb(),
    logger: input.logger,
    restartConsumer: async (hostId) => {
      if (abortRuntimeEventConsumer(hostId))
        await ensureLocalExecutionDataPlane();
    },
  });
}

/** True when the host holding this command has given up its event stream AND
 * has no live one. A prompt only terminalizes from an INGESTED terminal event,
 * so such a waiter is waiting for evidence that cannot arrive.
 *
 * A host can hold SEVERAL stream rows, and that is the normal shape after a
 * restart: `degradeStalledStream` marks the stalled one `lost` terminally, and
 * a host reconnecting under a NEW `stream_id` inserts a second row `active`
 * beside it (`ingest.ts` — the insert is keyed on `(host, stream_id)` and only
 * runs once no `active` row exists). This used to read ONE arbitrary row
 * (`.limit(1)`, no `ORDER BY`, no state filter) and answer from it, so for such
 * a host the result was a coin flip.
 *
 * That was survivable while the only caller yielded and retried. ADR-177 made
 * the answer terminalize a run (`crash / stream-lost`), so it has to mean what
 * it says: evidence cannot arrive only when NOTHING is flowing. An `active`
 * stream disqualifies the impasse outright.
 */
export async function commandStreamLost(input: {
  db: Db;
  commandId: string;
}): Promise<boolean> {
  const rows = await input.db
    .select({ state: executionEventStreams.state })
    .from(executionCommands)
    .innerJoin(
      executionEventStreams,
      eq(
        executionEventStreams.executionHostId,
        executionCommands.executionHostId,
      ),
    )
    .where(eq(executionCommands.id, input.commandId));

  return (
    rows.some((row: { state: string }) => row.state === "lost") &&
    !rows.some((row: { state: string }) => row.state === "active")
  );
}

/** Streams this manager has given up on. Read by the command-impasse signal. */
export async function lostStreamHostIds(input: {
  db: Db;
}): Promise<Set<string>> {
  const rows = await input.db
    .select({ executionHostId: executionEventStreams.executionHostId })
    .from(executionEventStreams)
    .where(inArray(executionEventStreams.state, ["lost"]));

  return new Set(rows.map((row) => row.executionHostId));
}
