import "server-only";

import type { DomainEventConsumer } from "@/lib/domain-events/consumers";
import type { DomainEventRow } from "@/lib/db/schema";

import { sql, type SQL } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import { isRunTerminalEventKind } from "@/lib/domain-events/taxonomy";
import { isBrainSchemaApplied } from "@/lib/brain/guard";
import { isGraphOnlyCutoverFailure } from "@/lib/domain-events/cutover";

const log = pino({
  name: "brain:index-triggers",
  level: process.env.LOG_LEVEL ?? "info",
});

type TriggerDb = {
  execute(query: SQL): Promise<{ rows: Array<Record<string, unknown>> }>;
};

export function isSourceReindexTrigger(kind: string): boolean {
  return isRunTerminalEventKind(kind);
}

export async function enqueueSourceReindexForEvents(
  events: DomainEventRow[],
  opts: { db?: TriggerDb } = {},
): Promise<number> {
  const db = opts.db ?? (getDb() as unknown as TriggerDb);
  let inserted = 0;

  for (const event of events) {
    if (isGraphOnlyCutoverFailure(event)) {
      log.debug(
        { eventId: event.id, runId: event.runId, reason: "graph-cutover" },
        "Brain source reindex skipped terminal upgrade cut-over",
      );
      continue;
    }
    if (!isSourceReindexTrigger(event.kind)) continue;

    const domainEventId = String(event.id);
    const cursor = JSON.stringify({
      domainEventId,
      kind: event.kind,
    });
    const rows = await db.execute(sql`
      INSERT INTO brain_index_jobs
        (id, project_id, source_id, reason, status, resumable_cursor)
      SELECT gen_random_uuid()::text,
             s.project_id,
             s.id,
             'event',
             'queued',
             ${cursor}::jsonb
      FROM brain_sources s
      JOIN projects p ON p.id = s.project_id AND p.brain_enabled = true
      WHERE s.project_id = ${event.projectId}
        AND s.enabled = true
        AND NOT EXISTS (
          SELECT 1 FROM brain_index_jobs j
          WHERE j.source_id = s.id
            AND (
              j.status IN ('queued', 'running')
              OR j.resumable_cursor->>'domainEventId' = ${domainEventId}
            )
        )
      RETURNING id
    `);

    inserted += rows.rows.length;
  }

  if (inserted > 0) {
    log.info(
      { jobs: inserted },
      "brain source reindex jobs enqueued from events",
    );
  }

  return inserted;
}

export const sourceReindexConsumer: DomainEventConsumer = {
  id: "brain_source_reindex",
  startFrom: "now",
  async handle(events: DomainEventRow[]): Promise<void> {
    const db = getDb() as unknown as TriggerDb;

    if (!(await isBrainSchemaApplied(db))) return;

    await enqueueSourceReindexForEvents(events);
  },
};
