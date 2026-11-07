import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { LaunchAgentRunInput } from "@/lib/agents/launch";

import { sql } from "drizzle-orm";
import pino from "pino";

import { getSpecialistAssignment, getSpecialistAssignmentInput } from "./store";
import { projectSourceHandoffSchema } from "./project-source-types";
import { loadProjectEventAppointment } from "./project-event-appointment";
import { acceptProjectCoordinatorAssignmentLaunch } from "./project-flow-launch";

import { dispatchTaskLaunchIntent } from "@/lib/tasks/launch-dispatch";
import { isMaisterError, MaisterError } from "@/lib/errors";

const log = pino({
  name: "project-assignment-resume",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Reuse one bounded page on the existing event/scheduler paths; no ambient session or new execution ledger. */
export async function resumeQualifiedProjectAssignments(
  db: Db,
  projectId?: string,
  taskId?: string,
): Promise<number> {
  const candidates = (
    await db.execute(sql`
    SELECT head.id,head.requester->>'id' AS user_id
    FROM specialist_assignments head
    JOIN specialist_input_revisions input ON input.assignment_id=head.id AND input.revision=head.input_revision
    JOIN tasks carrier ON carrier.id=head.project_task_id AND carrier.project_id=head.project_id
    JOIN task_qualifications assessment ON assessment.id=carrier.current_qualification_id
      AND assessment.task_id=carrier.id AND assessment.project_id=carrier.project_id
      AND assessment.revision=carrier.current_qualification_revision
      AND assessment.input_revision=carrier.qualification_input_revision
      AND assessment.publication_state='accepted' AND assessment.value->>'decision'='ready'
    WHERE head.project_id IS NOT NULL AND head.company_id IS NULL AND head.status='queued'
      AND head.project_task_id IS NOT NULL AND input.standing_definition->'schemaVersion'='2'::jsonb
      AND NOT EXISTS(SELECT 1 FROM task_launch_intents owned_intent WHERE owned_intent.task_id=head.project_task_id)
      ${projectId ? sql`AND head.project_id=${projectId}` : sql``}
      ${taskId ? sql`AND head.project_task_id=${taskId}` : sql``}
    ORDER BY head.updated_at,head.id LIMIT 100
  `)
  ).rows;
  let accepted = 0;

  for (const candidate of candidates) {
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.user_id !== "string"
    )
      throw new MaisterError(
        "CONFIG",
        "Queued project assignment attribution is malformed",
      );
    try {
      const assignment = await getSpecialistAssignment(
        db,
        candidate.user_id,
        candidate.id,
      );
      const input = await getSpecialistAssignmentInput(
        db,
        candidate.user_id,
        candidate.id,
        assignment.inputRevision,
      );

      if (
        assignment.owner.kind !== "project" ||
        input.snapshot.standingDefinition.schemaVersion !== 2
      )
        continue;
      const origin = assignment.origin;
      const row = (
        await db.execute(sql`
        SELECT specialist_assignment FROM agent_trigger_attempts
        WHERE specialist_assignment->'assignment'->>'id'=${assignment.id}
          AND specialist_assignment->'assignment'->'inputRevision'=to_jsonb(${assignment.inputRevision}::integer)
      `)
      ).rows[0];
      const handoff = row
        ? projectSourceHandoffSchema.parse(row.specialist_assignment)
        : null;

      if (handoff && handoff.assignment.inputSha256 !== input.digest)
        throw new MaisterError(
          "CONFLICT",
          "The retained source input no longer matches its assignment",
        );
      if (!handoff && origin.kind !== "manual" && origin.kind !== "webhook")
        continue;
      const source = handoff?.source;
      let trigger: LaunchAgentRunInput["trigger"];

      if (source?.kind === "task_comment" && origin.kind === "task_comment")
        trigger = {
          source: "domain_event",
          eventId: source.eventId,
          payload: {
            kind: "task.comment_added",
            payload: { commentId: origin.commentId },
          },
        };
      else if (source?.kind === "event" && origin.kind === "event") {
        const current = await db.transaction((tx) =>
          loadProjectEventAppointment(tx, source),
        );

        trigger = {
          source: "domain_event",
          eventId: source.eventId,
          payload: { schemaVersion: 1, event: current.event },
        };
      } else if (source?.kind === "cron" && origin.kind === "schedule")
        trigger = { source: "cron" };
      else if (!source && origin.kind === "manual")
        trigger = { source: "manual" };
      else if (!source && origin.kind === "webhook")
        trigger = { source: "webhook", payload: { schemaVersion: 1, origin } };
      else
        throw new MaisterError(
          "CONFLICT",
          "The retained source and assignment origin disagree",
        );
      const result = await acceptProjectCoordinatorAssignmentLaunch(
        db,
        {
          db,
          projectId: assignment.owner.projectId,
          agentId: input.snapshot.standingDefinition.agentId,
          trigger,
          scheduledRequestSnapshot: input.snapshot.scheduledRequest,
          runId: source?.runId,
          agentScheduleId: source?.scheduleId,
          ...(source?.kind === "cron"
            ? {
                agentTriggerReservation: {
                  attemptId: source.attemptId,
                  runId: source.runId,
                },
              }
            : {}),
          specialistAssignment: {
            assignmentId: assignment.id,
            inputRevision: assignment.inputRevision,
            expectedRevision: assignment.revision,
            userId: candidate.user_id,
            ...(source ? { source } : {}),
          },
        },
        input.snapshot.standingDefinition.coordinatorFlow,
      );

      if (result.kind === "accepted") {
        await dispatchTaskLaunchIntent(db, result.receipt.intentId);
        accepted++;
      }
    } catch (error) {
      if (
        !isMaisterError(error) ||
        ![
          "PRECONDITION",
          "CONFLICT",
          "UNAUTHORIZED",
          "UNAUTHENTICATED",
          "ACCOUNT_INACTIVE",
          "PASSWORD_CHANGE_REQUIRED",
          "NEEDS_INPUT",
          "EXECUTOR_UNAVAILABLE",
        ].includes(error.code)
      )
        throw error;
      log.warn(
        {
          assignmentId: candidate.id,
          code: error.code,
          reason: error.details?.reason ?? null,
        },
        "retained project assignment awaits current admission or source authority",
      );
    }
  }

  return accepted;
}
