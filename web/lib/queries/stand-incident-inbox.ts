import "server-only";

import type { SQL } from "drizzle-orm";
import type { Db } from "@/lib/execution-host/db";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { databaseTimestamp } from "@/lib/db/timestamp";
import { readStandIncidentEpisodes } from "@/lib/stand-operations/incidents";

const inboxRow = z.object({
  id: z.string(),
  event_kind: z.enum(["stand_incident_opened", "stand_incident_resolved"]),
  incident_id: z.string(),
  assignment_id: z.string(),
  project_id: z.string().nullable(),
  project_name: z.string().nullable(),
  component: z.string(),
  read: z.boolean(),
  created_at: z
    .union([z.string(), z.date()])
    .transform(databaseTimestamp)
    .pipe(z.string()),
});

export type StandIncidentInboxItemView = Readonly<{
  id: string;
  incidentId: string;
  assignmentId: string;
  projectId: string | null;
  projectName: string | null;
  taskTitle: string;
  keyRef: null;
  eventKind: z.infer<typeof inboxRow>["event_kind"];
  read: boolean;
  createdAt: Date;
}>;

/** Counts and cards use the same currently authorized stand incident population. */
export async function readStandIncidentInboxItems(
  db: Db,
  userId: string,
  predicate: SQL,
): Promise<StandIncidentInboxItemView[]> {
  const result = await db.execute(sql`
    SELECT inbox_items.id,inbox_items.event_kind,inbox_items.stand_incident_id AS incident_id,
      operation.assignment_id,inbox_items.project_id,project.name AS project_name,
      operation.component_id AS component,inbox_items.read_at IS NOT NULL AS read,inbox_items.created_at
    FROM inbox_items
    JOIN stand_operations operation ON operation.id=inbox_items.source_ref->>'operationId'
    LEFT JOIN projects project ON project.id=inbox_items.project_id
    WHERE inbox_items.recipient_type='user' AND inbox_items.recipient_id=${userId}
      AND inbox_items.stand_incident_id IS NOT NULL AND project.archived_at IS NULL AND ${predicate}
    ORDER BY inbox_items.created_at DESC,inbox_items.id
  `);
  const visible: StandIncidentInboxItemView[] = [];
  const inspected = new Map<string, ReadonlySet<string>>();

  for (const row of result.rows.map((value) => inboxRow.parse(value))) {
    let authorized = inspected.get(row.assignment_id);

    if (!authorized) {
      const episodes = await readStandIncidentEpisodes(
        db,
        userId,
        row.assignment_id,
      );

      authorized = new Set(episodes.map(({ id }) => id));
      inspected.set(row.assignment_id, authorized);
    }
    if (!authorized.has(row.incident_id)) continue;
    visible.push({
      id: row.id,
      incidentId: row.incident_id,
      assignmentId: row.assignment_id,
      projectId: row.project_id,
      projectName: row.project_name,
      taskTitle: row.component,
      keyRef: null,
      eventKind: row.event_kind,
      read: row.read,
      createdAt: new Date(row.created_at),
    });
  }

  return visible;
}
