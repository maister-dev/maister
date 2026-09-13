import "server-only";

/**
 * The per-user read cursor behind `updates` and the activity feed's "your last
 * visit" divider (`ATN-10`, `EDGE-ATN-03`, ADR-169 D3).
 *
 * An ABSENT row means "never looked" — not "has seen nothing ever". Seeding a
 * constant default at migration time would have been the "looks populated but
 * isn't" trap that permanently excludes pre-migration rows.
 *
 * The advance is a single-row `GREATEST` upsert, so it has no backward edge: a
 * replayed POST, a slow tab that finishes after a newer one, or an out-of-order
 * retry is ABSORBED rather than applied. That is what makes the endpoint safe
 * to fire on every visit without ordering guarantees.
 */

import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { eq, sql } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import * as schema from "@/lib/db/schema";

const { userActivityCursors } = schema;

const log = pino({
  name: "queries-activity-cursor",
  level: process.env.LOG_LEVEL ?? "info",
});

// FIXME(any): dual drizzle-orm peer-dep variants — matches the injectable
// handle `getVisibleProjectIds` already threads through the read models.
type CursorClient = any;

export async function getActivityCursor(
  userId: string,
  client: CursorClient = getDb(),
): Promise<Date | null> {
  const rows = (await (client as NodePgDatabase<typeof schema>)
    .select({ seenThrough: userActivityCursors.seenThrough })
    .from(userActivityCursors)
    .where(eq(userActivityCursors.userId, userId))) as Array<{
    seenThrough: Date;
  }>;

  return rows[0]?.seenThrough ?? null;
}

/**
 * Advances the reader's own cursor. Returns the cursor AFTER the upsert, which
 * is not necessarily what was asked for — a stale request gets the newer stored
 * value back, so the caller can tell absorption from application.
 */
export async function advanceActivityCursor(
  userId: string,
  seenThrough: Date,
  now: Date = new Date(),
): Promise<Date> {
  if (Number.isNaN(seenThrough.getTime())) {
    throw new MaisterError("PRECONDITION", "seenThrough is not a timestamp");
  }
  // EDGE-ATN-03. A cursor in the future would silently swallow everything
  // written between now and then — and `GREATEST` would make it permanent.
  if (seenThrough.getTime() > now.getTime()) {
    throw new MaisterError(
      "PRECONDITION",
      "seenThrough is later than now; a read cursor cannot run ahead of the events it marks",
    );
  }

  const client = getDb() as NodePgDatabase<typeof schema>;
  const [row] = await client
    .insert(userActivityCursors)
    .values({ userId, seenThrough, updatedAt: now })
    .onConflictDoUpdate({
      target: userActivityCursors.userId,
      set: {
        seenThrough: sql`greatest(${userActivityCursors.seenThrough}, excluded.seen_through)`,
        updatedAt: now,
      },
    })
    .returning({ seenThrough: userActivityCursors.seenThrough });

  log.debug(
    {
      userId,
      requested: seenThrough.toISOString(),
      stored: row.seenThrough.toISOString(),
      absorbed: row.seenThrough.getTime() !== seenThrough.getTime(),
    },
    "advance activity cursor",
  );

  return row.seenThrough;
}
