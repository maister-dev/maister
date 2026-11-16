import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ProjectAgentTriggerClaim } from "@/lib/agents/trigger-attempts";
import type { SpecialistIntakeReceipt } from "./intake-types";

import { loadProjectCommentAppointment } from "./project-comment-appointment";
import { submitProjectUserRequest } from "./project-request-intake";
import { beginAssignmentTransaction } from "./store";

/** Each human comment/recipient is independent durable work, even while another assignment is active. */
export async function submitProjectCommentAssignment(
  db: Db,
  claim: ProjectAgentTriggerClaim,
): Promise<SpecialistIntakeReceipt> {
  const appointment = {
    schemaVersion: 1 as const,
    kind: "task_comment" as const,
    attemptId: claim.id,
    scheduleId: claim.scheduleId,
    runId: claim.reservedRunId,
    eventId: Number(claim.triggerEventId),
  };
  const source = await db.transaction(async (tx) => {
    await beginAssignmentTransaction(tx);

    return loadProjectCommentAppointment(tx, appointment);
  });
  const owner = { kind: "project" as const, projectId: source.projectId };
  const origin = {
    kind: "task_comment" as const,
    projectId: source.projectId,
    taskId: source.taskId,
    commentId: source.commentId,
  };

  return submitProjectUserRequest(
    db,
    source.userId,
    {
      owner,
      specialistBindingId: source.bindingId,
      objective: source.body,
      expectedOutcome:
        "Provide the specialist's required evidence-linked result for the addressed task comment.",
      input: source.body,
      targetIds: [source.taskId],
      inputRefs: [],
      constraints: [],
      verification: [{ kind: "result", referenceId: null, required: true }],
    },
    {
      origin,
      destination: {
        kind: "task_comment",
        projectId: source.projectId,
        taskId: source.taskId,
        threadCommentId: source.commentId,
      },
      trigger: {
        source: "domain_event",
        eventId: appointment.eventId,
        payload: {
          kind: "task.comment_added",
          payload: { commentId: source.commentId },
        },
      },
      scheduledRequest: null,
      taskId: source.taskId,
      source: appointment,
    },
  );
}
