import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { SqlTransaction } from "@/lib/db/sql-types";
import type { ExecutionHosts } from "@/lib/execution-host";
import type { CompanyTriggerReservation } from "@/lib/agents/company-trigger-reservation";
import type { CompanyAssignmentRequest } from "./company-intake";
import type { SpecialistIntakeReceipt } from "./intake-types";
import type { AssignmentOrigin } from "./types";
import type { ScheduledAgentRequestSnapshot } from "@/lib/agents/scheduled-request";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { reserveCompanyTriggerAssignment } from "./company-trigger-intake";

import { companyTriggerBindingSnapshotSchema } from "@/lib/agents/trigger-attempt-types";
import { scheduledRequestSnapshotSchema } from "@/lib/agents/scheduled-request";
import { createExecutionHosts } from "@/lib/execution-host";
import { MaisterError } from "@/lib/errors";

const identity = z.string().min(1).max(128);
const invocationSchema = z.object({
  id: identity,
  company_id: identity,
  project_id: z.null(),
  schedule_id: identity,
  source_agent_id: identity,
  reserved_run_id: identity,
  trigger_source: z.literal("cron"),
  outcome: z.string().nullable(),
  created_by: identity,
  binding_snapshot: companyTriggerBindingSnapshotSchema,
  scheduled_request_snapshot: scheduledRequestSnapshotSchema,
});

type CompanyCronInvocation = Readonly<{
  attempt: z.infer<typeof invocationSchema>;
  request: CompanyAssignmentRequest;
  origin: Extract<AssignmentOrigin, { kind: "schedule" }>;
  scheduled: ScheduledAgentRequestSnapshot;
}>;

async function loadCompanyCronInvocation(
  tx: SqlTransaction,
  invocation: CompanyTriggerReservation,
): Promise<CompanyCronInvocation> {
  const parsed = invocationSchema.safeParse(
    (
      await tx.execute(sql`
    SELECT attempt.id,attempt.company_id,attempt.project_id,attempt.schedule_id,attempt.source_agent_id,attempt.reserved_run_id,
      attempt.trigger_source,attempt.outcome,attempt.binding_snapshot,attempt.scheduled_request_snapshot,source.created_by
    FROM agent_trigger_attempts attempt JOIN agent_schedules source ON source.id=attempt.schedule_id
      AND source.company_id=attempt.company_id AND source.project_id IS NULL
    WHERE attempt.id=${invocation.attemptId} FOR SHARE OF attempt,source
  `)
    ).rows[0],
  );

  if (!parsed.success || parsed.data.reserved_run_id !== invocation.runId)
    throw new MaisterError(
      "CONFLICT",
      "The exact owned company cron invocation is unavailable",
      { details: { reason: "company_trigger_reservation_unavailable" } },
    );
  const attempt = parsed.data;
  const scheduled = attempt.scheduled_request_snapshot;

  if (
    scheduled.scheduleId !== attempt.schedule_id ||
    scheduled.triggerAttemptId !== attempt.id ||
    scheduled.requestAtLaunch === null
  )
    throw new MaisterError(
      "NEEDS_INPUT",
      "Company scheduled work requires an explicit retained recurring request",
      { details: { reason: "company_scheduled_request_missing" } },
    );
  const origin = {
    kind: "schedule" as const,
    scheduleId: attempt.schedule_id,
    triggerAttemptId: attempt.id,
  };
  // Keep the complete Unicode request in its existing v1 plane. The objective is
  // an invocation label, not a copy that could truncate or reinterpret that text.
  const request: CompanyAssignmentRequest = {
    owner: { kind: "company", companyId: attempt.company_id },
    specialistBindingId: attempt.binding_snapshot.specialistBinding.id,
    objective: `Execute the recurring request retained for invocation ${attempt.id}`,
    expectedOutcome:
      "Produce the specialist's required structured result for this exact scheduled request.",
    input: "",
    inputRefs: [],
    targetIds: [],
    constraints: [],
    verification: [{ kind: "result", referenceId: null, required: true }],
  };

  return { attempt, request, origin, scheduled };
}

/** A claimed source creates its assignment/input and preallocated native Run in one existing transaction. */
export async function reserveCompanyCronAssignment(
  db: Db,
  invocation: CompanyTriggerReservation,
  hosts: ExecutionHosts = createExecutionHosts({ db }),
): Promise<SpecialistIntakeReceipt> {
  return reserveCompanyTriggerAssignment(
    db,
    invocation,
    async (tx, reservation) => {
      const source = await loadCompanyCronInvocation(tx, reservation);

      return {
        userId: source.attempt.created_by,
        companyId: source.attempt.company_id,
        outcome: source.attempt.outcome,
        request: source.request,
        origin: source.origin,
        scheduledRequest: source.scheduled,
        sourceRestrictions: [],
        triggerSource: "cron",
      };
    },
    hosts,
  );
}
