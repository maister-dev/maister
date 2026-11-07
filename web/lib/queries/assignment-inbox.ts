import "server-only";

import type { SQL } from "drizzle-orm";
import type { SqlDatabase } from "@/lib/db/sql-types";

import { sql } from "drizzle-orm";
import { z } from "zod";

import {
  readableKnowledgeRunIds,
  assertRunsKnowledgeDisclosure,
} from "@/lib/brain/knowledge-run-disclosure";
import { databaseTimestamp } from "@/lib/db/timestamp";
import { assignmentResultWitnessSchema } from "@/lib/specialist-assignments/delivery-types";

export type AssignmentInboxItemView = Readonly<{
  id: string;
  assignmentId: string;
  runId: string;
  resultRevision: number;
  projectId: string | null;
  projectSlug: string | null;
  projectName: string | null;
  taskNumber: number | null;
  taskTitle: string;
  keyRef: null;
  eventKind: "assignment_result_available";
  read: boolean;
  createdAt: Date;
}>;

const databaseDate = z
  .union([z.date(), z.string()])
  .transform(databaseTimestamp)
  .pipe(z.string())
  .transform((value) => new Date(value));

const rowSchema = z.object({
  id: z.string(),
  project_id: z.string().nullable(),
  project_slug: z.string().nullable(),
  project_name: z.string().nullable(),
  task_number: z.number().int().nullable(),
  title: z.string(),
  read_at: databaseDate.nullable(),
  created_at: databaseDate,
  snapshot: assignmentResultWitnessSchema,
});

/** Native content/counts share this recipient, current-owner and complete-source population. */
export async function readAssignmentInboxItems(
  db: SqlDatabase,
  userId: string,
  predicate: SQL,
): Promise<AssignmentInboxItemView[]> {
  const result = await db.execute(sql`
    SELECT inbox_items.id,inbox_items.project_id,project.slug AS project_slug,project.name AS project_name,
      task.number AS task_number,input.objective_input->>'objective' AS title,inbox_items.read_at,inbox_items.created_at,receipt.snapshot
    FROM inbox_items JOIN specialist_delivery_receipts receipt ON receipt.id=inbox_items.assignment_delivery_id
    JOIN specialist_input_revisions input ON input.assignment_id=receipt.assignment_id AND input.revision=receipt.input_revision
    JOIN users reader ON reader.id=${userId} AND reader.account_status='active' AND NOT reader.must_change_password
    LEFT JOIN projects project ON project.id=inbox_items.project_id LEFT JOIN tasks task ON task.id=inbox_items.task_id
    WHERE inbox_items.recipient_type='user' AND inbox_items.recipient_id=${userId} AND ${predicate}
      AND ((inbox_items.company_id IS NOT NULL AND EXISTS(SELECT 1 FROM company_grants authority
        WHERE authority.company_id=inbox_items.company_id AND authority.principal_type='user' AND authority.principal_id=${userId}
          AND authority.action='assignments:read' AND authority.revoked_at IS NULL))
      OR (inbox_items.project_id IS NOT NULL AND project.archived_at IS NULL AND (reader.role='admin' OR EXISTS(
        SELECT 1 FROM project_members membership WHERE membership.project_id=inbox_items.project_id AND membership.user_id=${userId}))))
    ORDER BY inbox_items.created_at DESC,inbox_items.id
  `);
  const rows = result.rows.map((row) => rowSchema.parse(row));
  const recipient = { kind: "user" as const, userId };
  const readable = await readableKnowledgeRunIds(
    db,
    recipient,
    rows.map((row) => row.snapshot.runId),
  );
  const visible = rows.filter((row) => readable.has(row.snapshot.runId));

  for (let offset = 0; offset < visible.length; offset += 256)
    await assertRunsKnowledgeDisclosure(
      db,
      recipient,
      visible.slice(offset, offset + 256).map((row) => row.snapshot.runId),
    );

  return visible.map((row) => ({
    id: row.id,
    assignmentId: row.snapshot.assignmentId,
    runId: row.snapshot.runId,
    resultRevision: row.snapshot.resultRevision,
    projectId: row.project_id,
    projectSlug: row.project_slug,
    projectName: row.project_name,
    taskNumber: row.task_number,
    taskTitle: row.title,
    keyRef: null,
    eventKind: "assignment_result_available",
    read: row.read_at !== null,
    createdAt: row.created_at,
  }));
}
