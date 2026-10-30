import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { GlobalRole } from "@/lib/db/schema";

import { sql } from "drizzle-orm";

import { computeDecisionsQueue } from "@/lib/queries/decisions";
import { getActionableProjectIds } from "@/lib/queries/visible-projects";
import { episodeReadCte } from "@/lib/runs/agent-incident-projection";

export type AttentionDecisionSnapshot = {
  decisions: number;
  ordinaryDecisions: number;
};

export type AttentionEpisodeReceipt = {
  id: string;
  attention_revision: number;
};

export async function readAttentionDecisionSnapshot(
  db: Db,
  userId: string,
  role: GlobalRole,
): Promise<AttentionDecisionSnapshot> {
  const queue = await computeDecisionsQueue(userId, role, {}, db);
  const groups = queue.items.filter(
    (item) => item.kind === "operational" && "aggregation" in item.operational,
  ).length;

  return { decisions: queue.count, ordinaryDecisions: queue.count - groups };
}

/** Lock eligible episode revisions, then recheck receipts after any concurrent acknowledgement commits. */
export async function lockUnpublishedAttentionEpisodes(
  db: Db,
  userId: string,
  role: GlobalRole,
): Promise<AttentionEpisodeReceipt[]> {
  const projectIds = await getActionableProjectIds(userId, role, db);

  if (!projectIds.length) return [];
  const eligible = sql`WITH reader_episodes AS (${episodeReadCte(userId, projectIds)})
    SELECT e.id,e.attention_revision FROM agent_incident_episodes e
    JOIN reader_episodes visible ON visible.id=e.id
    WHERE e.state='open' AND NOT visible.acknowledged
      AND NOT EXISTS (SELECT 1 FROM agent_incident_reader_states receipt
        WHERE receipt.user_id=${userId} AND receipt.episode_id=e.id
          AND receipt.attention_revision=e.attention_revision AND receipt.notification_recorded_at IS NOT NULL)`;
  const candidates = await db.execute<AttentionEpisodeReceipt>(
    sql`${eligible} ORDER BY e.id LIMIT 100 FOR UPDATE OF e`,
  );

  if (!candidates.rows.length) return [];
  const checked = await db.execute<AttentionEpisodeReceipt>(
    sql`${eligible} AND e.id IN ${candidates.rows.map((row) => row.id)} ORDER BY e.id`,
  );

  return checked.rows;
}

export async function recordAttentionEpisodePublications(
  db: Db,
  userId: string,
  episodes: readonly AttentionEpisodeReceipt[],
  eventId: string,
): Promise<void> {
  if (!episodes.length) return;

  await db.execute(sql`INSERT INTO agent_incident_reader_states
    (user_id,episode_id,attention_revision,notification_recorded_at,notification_mode,notification_event_id)
    VALUES ${sql.join(
      episodes.map(
        (episode) =>
          sql`(${userId},${episode.id},${episode.attention_revision},clock_timestamp(),'published',${eventId})`,
      ),
      sql`, `,
    )}
    ON CONFLICT (user_id,episode_id,attention_revision) DO UPDATE SET
      notification_recorded_at=excluded.notification_recorded_at,
      notification_mode=excluded.notification_mode,notification_event_id=excluded.notification_event_id
    WHERE agent_incident_reader_states.notification_recorded_at IS NULL`);
}
