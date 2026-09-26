import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { and, asc, eq, gt, isNotNull, lt, sql } from "drizzle-orm";
import pino from "pino";

import { librarianConfig } from "./config";

import { getDb } from "@/lib/db/client";
import {
  executionEvents,
  librarianContextSnapshots,
  librarianMessages,
  librarianSegmentSummaries,
  librarianTurns,
  runs,
} from "@/lib/db/schema";
import { DEFAULT_SYSTEM_SWEEP_JOB_ID } from "@/lib/scheduler/jobs";

const log = pino({
  name: "librarian.retention",
  level: process.env.LOG_LEVEL ?? "info",
});
const BATCH = 500;

type CursorKind = "messages" | "snapshots" | "events";

async function readCursor(db: Db, kind: CursorKind): Promise<string | null> {
  const result =
    await db.execute(sql`SELECT target -> 'librarianRetention' ->> ${kind} AS cursor
    FROM scheduler_jobs WHERE id = ${DEFAULT_SYSTEM_SWEEP_JOB_ID}`);
  const value = (result.rows[0] as { cursor?: unknown } | undefined)?.cursor;

  return typeof value === "string" ? value : null;
}

async function writeCursor(
  db: Db,
  kind: CursorKind,
  cursor: string | null,
): Promise<void> {
  await db.execute(sql`UPDATE scheduler_jobs SET target = coalesce(target, '{}'::jsonb)
    || jsonb_build_object('librarianRetention',
      coalesce(target -> 'librarianRetention', '{}'::jsonb)
      || jsonb_build_object(${kind}::text, ${cursor}::text))
    WHERE id = ${DEFAULT_SYSTEM_SWEEP_JOB_ID}`);
}

export type LibrarianRetentionSummary = {
  messages: number;
  snapshots: number;
  summaries: number;
  eventPayloads: number;
};

/** One bounded keyset window per table on each system sweep tick. */
export async function runLibrarianRetention(
  db: Db = getDb() as unknown as Db,
  now: Date = new Date(),
): Promise<LibrarianRetentionSummary> {
  const config = librarianConfig();
  const messageCutoff = new Date(
    now.getTime() - config.historyRetentionDays * 86_400_000,
  );
  const snapshotCutoff = new Date(
    now.getTime() - config.snapshotRetentionDays * 86_400_000,
  );
  const totals: LibrarianRetentionSummary = {
    messages: 0,
    snapshots: 0,
    summaries: 0,
    eventPayloads: 0,
  };
  const messageCursor = await readCursor(db, "messages");
  const messages = await db
    .select({ id: librarianMessages.id })
    .from(librarianMessages)
    .where(
      and(
        lt(librarianMessages.createdAt, messageCutoff),
        messageCursor ? gt(librarianMessages.id, messageCursor) : undefined,
      ),
    )
    .orderBy(asc(librarianMessages.id))
    .limit(BATCH);

  for (const row of messages) {
    try {
      await db
        .delete(librarianMessages)
        .where(eq(librarianMessages.id, row.id));
      totals.messages += 1;
    } catch (error) {
      log.warn(
        { messageId: row.id, error },
        "librarian message retention failed",
      );
    }
  }
  await writeCursor(
    db,
    "messages",
    messages.length === BATCH ? messages[BATCH - 1].id : null,
  );
  const snapshotCursor = await readCursor(db, "snapshots");
  const snapshots = await db
    .select({
      id: librarianContextSnapshots.id,
      turnId: librarianContextSnapshots.turnId,
    })
    .from(librarianContextSnapshots)
    .innerJoin(
      librarianTurns,
      eq(librarianTurns.id, librarianContextSnapshots.turnId),
    )
    .where(
      and(
        lt(librarianContextSnapshots.createdAt, snapshotCutoff),
        sql`${librarianTurns.status} NOT IN ('admitted', 'running')`,
        snapshotCursor
          ? gt(librarianContextSnapshots.id, snapshotCursor)
          : undefined,
      ),
    )
    .orderBy(asc(librarianContextSnapshots.id))
    .limit(BATCH);

  for (const row of snapshots) {
    try {
      await db
        .update(librarianTurns)
        .set({ contextSnapshotId: null })
        .where(eq(librarianTurns.id, row.turnId));
      await db
        .delete(librarianContextSnapshots)
        .where(eq(librarianContextSnapshots.id, row.id));
      totals.snapshots += 1;
    } catch (error) {
      log.warn(
        { snapshotId: row.id, error },
        "librarian snapshot retention failed",
      );
    }
  }
  await writeCursor(
    db,
    "snapshots",
    snapshots.length === BATCH ? snapshots[BATCH - 1].id : null,
  );
  const staleSummaries = await db
    .select({ id: librarianSegmentSummaries.id })
    .from(librarianSegmentSummaries)
    .where(
      sql`NOT EXISTS (SELECT 1 FROM librarian_messages m WHERE m.segment_id = ${librarianSegmentSummaries.segmentId}
      AND m.seq BETWEEN ${librarianSegmentSummaries.fromSeq} AND ${librarianSegmentSummaries.toSeq})`,
    )
    .limit(BATCH);

  for (const row of staleSummaries) {
    try {
      await db
        .delete(librarianSegmentSummaries)
        .where(eq(librarianSegmentSummaries.id, row.id));
      totals.summaries += 1;
    } catch (error) {
      log.warn(
        { summaryId: row.id, error },
        "librarian summary retention failed",
      );
    }
  }
  const eventCursor = await readCursor(db, "events");
  const events = await db
    .select({ id: executionEvents.id })
    .from(executionEvents)
    .innerJoin(runs, eq(runs.id, executionEvents.runId))
    .where(
      and(
        eq(runs.runKind, "librarian"),
        isNotNull(executionEvents.payload),
        sql`NOT EXISTS (SELECT 1 FROM execution_commands c WHERE c.run_id = ${runs.id} AND c.retired_at IS NULL)`,
        eventCursor ? gt(executionEvents.id, eventCursor) : undefined,
      ),
    )
    .orderBy(asc(executionEvents.id))
    .limit(BATCH);

  for (const row of events) {
    try {
      await db
        .update(executionEvents)
        .set({ payload: null })
        .where(eq(executionEvents.id, row.id));
      totals.eventPayloads += 1;
    } catch (error) {
      log.warn(
        { eventId: row.id, error },
        "librarian event payload retention failed",
      );
    }
  }
  await writeCursor(
    db,
    "events",
    events.length === BATCH ? events[BATCH - 1].id : null,
  );
  if (Object.values(totals).some((value) => value > 0))
    log.info(totals, "librarian retention batch");

  return totals;
}
