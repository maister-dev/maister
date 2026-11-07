import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ProjectAgentTriggerClaim } from "@/lib/agents/trigger-attempts";
import type { SpecialistIntakeReceipt } from "./intake-types";

import { loadProjectEventAppointment } from "./project-event-appointment";
import { submitProjectUserRequest } from "./project-request-intake";
import { beginAssignmentTransaction } from "./store";

import { MaisterError } from "@/lib/errors";

/** Event delivery reuses the exact existing invocation and reserved Run, keeping raw event payload outside agent input. */
export async function submitProjectEventAssignment(
  db: Db,
  claim: ProjectAgentTriggerClaim,
): Promise<SpecialistIntakeReceipt> {
  if (
    claim.bindingSnapshot.version !== 3 ||
    claim.bindingSnapshot.review.schemaVersion !== 2 ||
    claim.triggerEventId === null
  )
    throw new MaisterError(
      "NEEDS_INPUT",
      "Native project events require a current explicit event review",
      { details: { reason: "project_event_review_required" } },
    );
  const appointment = {
    schemaVersion: 1 as const,
    kind: "event" as const,
    attemptId: claim.id,
    scheduleId: claim.scheduleId,
    runId: claim.reservedRunId,
    eventId: claim.triggerEventId,
  };
  const source = await db.transaction(async (tx) => {
    await beginAssignmentTransaction(tx);

    return loadProjectEventAppointment(tx, appointment);
  });

  return submitProjectUserRequest(
    db,
    source.userId,
    {
      owner: { kind: "project", projectId: source.projectId },
      specialistBindingId: source.bindingId,
      objective: `Handle authorized project ${source.event.kind} event ${source.event.id} for subscription ${claim.scheduleId}`,
      expectedOutcome:
        "Produce the specialist's required structured result for this exact event invocation.",
      input: JSON.stringify({ schemaVersion: 1, event: source.event }),
      targetIds: [],
      inputRefs: [],
      constraints: [],
      verification: [{ kind: "result", referenceId: null, required: true }],
    },
    {
      origin: {
        kind: "event",
        eventId: source.event.id,
        subscriptionId: claim.scheduleId,
      },
      destination: { kind: "inbox", userId: source.userId },
      trigger: {
        source: "domain_event",
        eventId: appointment.eventId,
        payload: { schemaVersion: 1, event: source.event },
      },
      scheduledRequest: null,
      taskId: null,
      source: appointment,
      sourceRestrictions: source.sourceRestrictions,
    },
  );
}
