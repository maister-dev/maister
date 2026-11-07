import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ProjectAgentTriggerClaim } from "@/lib/agents/trigger-attempts";
import type { SpecialistIntakeReceipt } from "./intake-types";

import { loadProjectCronAppointment } from "./project-cron-appointment";
import { submitProjectUserRequest } from "./project-request-intake";
import { beginAssignmentTransaction } from "./store";

import { MaisterError } from "@/lib/errors";

/** Preserve the existing claim, reserved Run and literal scheduled input when admitting professional work. */
export async function submitProjectCronAssignment(
  db: Db,
  claim: ProjectAgentTriggerClaim,
): Promise<SpecialistIntakeReceipt> {
  if (claim.bindingSnapshot.version !== 3)
    throw new MaisterError(
      "NEEDS_INPUT",
      "Native project automation requires a current operator review before a new invocation",
      { details: { reason: "project_source_review_required" } },
    );
  const appointment = {
    schemaVersion: 1 as const,
    kind: "cron" as const,
    attemptId: claim.id,
    scheduleId: claim.scheduleId,
    runId: claim.reservedRunId,
  };
  const source = await db.transaction(async (tx) => {
    await beginAssignmentTransaction(tx);

    return loadProjectCronAppointment(tx, appointment);
  });

  return submitProjectUserRequest(
    db,
    source.userId,
    {
      owner: { kind: "project", projectId: source.projectId },
      specialistBindingId: source.bindingId,
      objective: `Execute the recurring request retained for invocation ${claim.id}`,
      expectedOutcome:
        "Produce the specialist's required structured result for this exact scheduled request.",
      input: "",
      targetIds: [],
      inputRefs: [],
      constraints: [],
      verification: [{ kind: "result", referenceId: null, required: true }],
    },
    {
      origin: {
        kind: "schedule",
        scheduleId: claim.scheduleId,
        triggerAttemptId: claim.id,
      },
      destination: { kind: "inbox", userId: source.userId },
      trigger: { source: "cron" },
      scheduledRequest: source.scheduledRequest,
      taskId: null,
      source: appointment,
    },
  );
}
