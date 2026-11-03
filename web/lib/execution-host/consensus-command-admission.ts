import "server-only";

import type { Db } from "./db";

import { sql } from "drizzle-orm";

/** Acquire parent, node-attempt and child authority before a command owner locks its local generation. */
export async function lockConsensusDraftCommandAdmission(
  db: Db,
  runId: string,
): Promise<void> {
  await db.execute(
    sql`SELECT lock_consensus_draft_command_admission(${runId})`,
  );
}

/** Mutation paths lock the hierarchy first; the SQL state guard then validates only actual outbound transitions. */
export async function lockConsensusDraftCommandHierarchy(
  db: Db,
  runId: string,
): Promise<void> {
  await db.execute(
    sql`SELECT lock_consensus_draft_command_hierarchy(${runId})`,
  );
}
