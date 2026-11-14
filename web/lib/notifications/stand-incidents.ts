import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";

import { sql } from "drizzle-orm";

/** The private Inbox receipt commits with the observation and its incident transition. */
export async function retainStandIncidentNotification(
  tx: SqlTransaction,
  incidentId: string,
  operationId: string,
  transition: "opened" | "resolved",
): Promise<void> {
  const eventKind =
    transition === "opened"
      ? "stand_incident_opened"
      : "stand_incident_resolved";

  await tx.execute(sql`
    INSERT INTO inbox_items(id,recipient_type,recipient_id,company_id,project_id,stand_incident_id,event_kind,source_ref)
    SELECT gen_random_uuid()::text,'user',recipient.id,subject.company_id,subject.project_id,episode.id,
      ${eventKind},jsonb_build_object('kind','stand_incident','incidentId',episode.id,
        'operationId',operation.id,'assignmentId',subject.id)
    FROM stand_incident_episodes episode
    JOIN stand_operations operation ON operation.id=${operationId} AND operation.resource_key=episode.resource_key
    JOIN stand_targets target ON target.id=operation.target_id
    JOIN specialist_assignments subject ON subject.id=operation.assignment_id
    JOIN users recipient ON recipient.id=subject.requester->>'id' AND subject.requester->>'kind'='user'
      AND recipient.account_status='active' AND NOT recipient.must_change_password
    WHERE episode.id=${incidentId} AND EXISTS (
      SELECT 1 FROM company_grants authority
      WHERE authority.company_id=target.company_id AND authority.principal_type='user' AND authority.principal_id=recipient.id
        AND authority.action='targets:read' AND authority.revoked_at IS NULL
    )
    ON CONFLICT(stand_incident_id,recipient_id,event_kind) DO NOTHING
  `);
}
