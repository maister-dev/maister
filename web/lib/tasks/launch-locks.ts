import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { sql } from "drizzle-orm";

/** Capacity lock, when needed, precedes this reservation lock; run/intent/task row locks follow it. */
export async function lockTaskLaunchReservation(
  db: Db,
  taskId: string,
): Promise<void> {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(1818326383, hashtext(${taskId}))`,
  );
}
