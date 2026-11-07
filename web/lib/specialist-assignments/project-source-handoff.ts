import "server-only";

import type { SqlDatabase, SqlTransaction } from "@/lib/db/sql-types";
import type { ProjectAssignmentAdmission } from "./project-admission";
import type { ProjectSourceHandoff } from "./project-source-types";

import { sql } from "drizzle-orm";

import { queuedProjectSourceHandoffPredicate } from "./project-source-handoff-query";
import { projectSourceHandoffSchema } from "./project-source-types";
import { loadProjectCommentAppointment } from "./project-comment-appointment";
import { loadProjectCronAppointment } from "./project-cron-appointment";
import { loadProjectEventAppointment } from "./project-event-appointment";
import { getSpecialistAssignmentInputInTransaction } from "./store";

import { contentDigest } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";

/** Capture the exact business input and acknowledge its producer atomically before its claim can expire. */
export async function retainProjectSourceHandoff(
  db: SqlDatabase,
  projectId: string,
  reference: ProjectAssignmentAdmission,
): Promise<void> {
  const source = reference.source;

  if (!source) return;
  await db.transaction(async (tx) => {
    const input = await getSpecialistAssignmentInputInTransaction(
      tx,
      reference.userId,
      reference.assignmentId,
      reference.inputRevision,
    );
    const pointer: ProjectSourceHandoff = projectSourceHandoffSchema.parse({
      schemaVersion: 1,
      assignment: {
        id: reference.assignmentId,
        inputRevision: reference.inputRevision,
        inputSha256: input.digest,
      },
      source,
    });
    const row = (
      await tx.execute(sql`
      SELECT specialist_assignment FROM agent_trigger_attempts
      WHERE id=${source.attemptId} FOR UPDATE
    `)
    ).rows[0];

    const actual =
      source.kind === "task_comment"
        ? await loadProjectCommentAppointment(tx, source)
        : source.kind === "cron"
          ? await loadProjectCronAppointment(tx, source)
          : await loadProjectEventAppointment(tx, source);

    if (actual.projectId !== projectId || actual.userId !== reference.userId)
      throw new MaisterError(
        "UNAUTHORIZED",
        "The retained source must belong to its actual project requester",
      );
    if (
      row?.specialist_assignment !== null &&
      row?.specialist_assignment !== undefined
    ) {
      const retained = projectSourceHandoffSchema.safeParse(
        row.specialist_assignment,
      );

      if (
        !retained.success ||
        contentDigest(retained.data) !== contentDigest(pointer)
      )
        throw new MaisterError(
          "CONFLICT",
          "The source reservation already belongs to different assignment input",
          { details: { reason: "project_source_handoff_conflict" } },
        );

      return;
    }
    const changed = (
      await tx.execute(sql`
      UPDATE agent_trigger_attempts SET specialist_assignment=${JSON.stringify(pointer)}::jsonb,
        outcome='queued',settled_at=clock_timestamp(),reason_code=NULL
      WHERE id=${source.attemptId} AND project_id=${projectId} AND company_id IS NULL
        AND outcome IS NULL AND due_at>clock_timestamp() AND run_id IS NULL AND original_run_id IS NULL
      RETURNING schedule_id,fence,settled_at
    `)
    ).rows[0];

    if (!changed)
      throw new MaisterError(
        "PRECONDITION",
        "The source claim expired or was settled before its assignment handoff",
        { details: { reason: "project_source_handoff_unavailable" } },
      );
    await tx.execute(sql`
      UPDATE agent_schedules SET last_outcome='queued',last_run_id=NULL,
        last_error_code=NULL,last_error_message=NULL,updated_at=clock_timestamp()
      WHERE id=${source.scheduleId} AND last_attempt_fence=${changed.fence}
    `);
  });
}

/** Current native input may adopt only its own retained reservation, independently of qualification. */
export async function hasQueuedProjectSourceHandoff(
  db: SqlTransaction,
  attemptId: string,
  taskId: string,
  reference: ProjectAssignmentAdmission | undefined,
): Promise<boolean> {
  if (!reference?.source) return false;
  const row = (
    await db.execute(sql`
    SELECT invocation.specialist_assignment FROM agent_trigger_attempts invocation
    JOIN specialist_assignments head ON head.id=invocation.specialist_assignment->'assignment'->>'id'
    WHERE invocation.id=${attemptId} AND head.id=${reference.assignmentId} AND head.project_task_id=${taskId}
      AND head.requester->>'id'=${reference.userId}
      AND invocation.specialist_assignment->'assignment'->'inputRevision'=to_jsonb(${reference.inputRevision}::integer)
      AND invocation.specialist_assignment->'source'=${JSON.stringify(reference.source)}::jsonb
      AND ${queuedProjectSourceHandoffPredicate()}
  `)
  ).rows[0];

  return row !== undefined;
}

/** The original source task remains distinct from its private carrier after canonical Run binding. */
export async function projectCommentCarrierMatchesSource(
  db: SqlTransaction,
  taskId: string,
  sourceTaskId: string,
  reference: ProjectAssignmentAdmission | undefined,
): Promise<boolean> {
  const source = reference?.source;

  if (!reference || source?.kind !== "task_comment") return false;
  const row = (
    await db.execute(sql`
    SELECT head.id FROM specialist_assignments head
    JOIN specialist_input_revisions input ON input.assignment_id=head.id AND input.revision=${reference.inputRevision}
    JOIN agent_trigger_attempts invocation ON invocation.id=${source.attemptId}
    WHERE head.id=${reference.assignmentId} AND head.project_task_id=${taskId}
      AND head.requester->>'id'=${reference.userId} AND head.project_id=invocation.project_id
      AND head.responsible->>'id'=invocation.source_agent_id
      AND head.origin->>'kind'='task_comment' AND head.origin->>'taskId'=${sourceTaskId}
      AND invocation.specialist_assignment->'assignment'=jsonb_build_object('id',head.id,
        'inputRevision',input.revision,'inputSha256',input.digest)
      AND invocation.specialist_assignment->'source'=${JSON.stringify(source)}::jsonb
  `)
  ).rows[0];

  return row !== undefined;
}
