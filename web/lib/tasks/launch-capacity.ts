import "server-only";

import type { taskLaunchIntents } from "@/lib/db/schema";
import type { Db } from "@/lib/execution-host/db";

import { sql } from "drizzle-orm";

/** A bound Pending intent retains its slot until the Running transition takes it over. */
export async function countTaskLaunchPreparationSlots(
  db: Db,
  pool: "flow" | "agent",
): Promise<number> {
  const rows = await db.execute<{
    n: string;
  }>(sql`SELECT count(*)::text n FROM task_launch_intents intent
    LEFT JOIN runs bound ON bound.id=intent.run_id
    WHERE intent.preparation_identity IS NOT NULL AND intent.settings_snapshot->>'kind'=${pool}
      AND (intent.state='preparing' OR intent.state='run_bound' AND intent.dispatch_committed_at IS NULL AND bound.status='Pending')`);

  return Number(rows.rows[0]?.n ?? 0);
}

/** Qualification basis and the C2 auto-drain capacity policy are separate axes. */
export function isAutomaticTaskLaunchDrain(
  intent: Pick<
    typeof taskLaunchIntents.$inferSelect,
    "basis" | "settingsSnapshot"
  >,
): boolean {
  return (
    intent.settingsSnapshot.kind === "flow" &&
    intent.basis.kind === "automatic" &&
    !(
      intent.settingsSnapshot.version === 2 &&
      intent.settingsSnapshot.serverExecution
    )
  );
}
