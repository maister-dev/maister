import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";
import type {
  CompanyAgentContextInput,
  CompanySpecialistContext,
} from "./company-agent-context";
import type { CompanyFlowBindingRevision } from "./company-flow-binding-types";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { companyTriggerBindingSnapshotSchema } from "./trigger-attempt-types";
import { parseScheduledRequestSnapshot } from "./scheduled-request";
import { assertScheduledRequestMatches } from "./scheduled-request-store";

import { MaisterError } from "@/lib/errors";
import { contentDigest } from "@/lib/evaluations/digest";

export type CompanyTriggerReservation = Readonly<{
  attemptId: string;
  runId: string;
}>;

/** Cron admission must retain its durable source appointment before allocating execution. */
export function assertCompanyTriggerAppointment(
  triggerSource: CompanyAgentContextInput["triggerSource"],
  invocation: CompanyTriggerReservation | undefined,
): void {
  if (triggerSource === "cron" && !invocation)
    throw new MaisterError(
      "CONFIG",
      "Company cron admission requires its existing source reservation",
      { details: { reason: "company_trigger_reservation_required" } },
    );
  if (triggerSource !== "cron" && invocation)
    throw new MaisterError(
      "CONFIG",
      "A company cron reservation cannot authorize another invocation trigger",
      { details: { reason: "company_trigger_reservation_trigger_mismatch" } },
    );
}
const identity = z.string().min(1).max(128);
const attemptSchema = z.object({
  id: identity,
  company_id: identity,
  project_id: z.null(),
  source_agent_id: identity,
  schedule_id: identity,
  binding_snapshot: companyTriggerBindingSnapshotSchema,
  reserved_run_id: identity,
  trigger_source: z.literal("cron"),
  outcome: z.null(),
  scheduled_request_snapshot: z.unknown(),
});

/** A source adapter may use only the existing immutable cron reservation, never a caller-chosen Run ID. */
export async function assertCompanyTriggerReservation(
  tx: SqlTransaction,
  userId: string,
  context: CompanySpecialistContext,
  invocation: CompanyTriggerReservation,
  coordinator: CompanyFlowBindingRevision | null,
): Promise<Readonly<{ runId: string; scheduleId: string }>> {
  const parsed = attemptSchema.safeParse(
    (
      await tx.execute(sql`
    SELECT id,company_id,project_id,source_agent_id,schedule_id,binding_snapshot,reserved_run_id,trigger_source,outcome,scheduled_request_snapshot
    FROM agent_trigger_attempts WHERE id=${invocation.attemptId} FOR SHARE
  `)
    ).rows[0],
  );

  if (!parsed.success)
    throw new MaisterError(
      "CONFLICT",
      "The unsettled company cron invocation is unavailable",
      { details: { reason: "company_trigger_reservation_unavailable" } },
    );
  const attempt = parsed.data;
  const source = (
    await tx.execute(sql`
    SELECT id FROM agent_schedules WHERE id=${attempt.schedule_id} AND company_id=${context.owner.companyId} AND project_id IS NULL
      AND created_by=${userId} AND enabled AND trigger_type='cron' AND agent_id=${context.effective.parsed.id}
      AND company_config_revision=${attempt.binding_snapshot.sourceRevision}
      AND company_specialist_binding_id=${context.binding.bindingId} FOR SHARE
  `)
  ).rows[0];
  const origin = context.assignment.origin;
  const role = attempt.binding_snapshot.specialistBinding;
  const expectedCoordinator =
    coordinator === null
      ? null
      : {
          id: coordinator.bindingId,
          revision: coordinator.revision,
          snapshotSha256: coordinator.snapshotDigest,
        };

  if (
    !source ||
    attempt.company_id !== context.owner.companyId ||
    attempt.source_agent_id !== context.effective.parsed.id ||
    attempt.reserved_run_id !== invocation.runId ||
    origin.kind !== "schedule" ||
    origin.scheduleId !== attempt.schedule_id ||
    origin.triggerAttemptId !== attempt.id ||
    role.id !== context.binding.bindingId ||
    role.revision !== context.binding.revision ||
    role.snapshotSha256 !== context.binding.snapshotDigest ||
    contentDigest(attempt.binding_snapshot.coordinatorFlowBinding) !==
      contentDigest(expectedCoordinator)
  )
    throw new MaisterError(
      "CONFLICT",
      "Company admission differs from its exact owned source, professional, configuration or Run reservation",
      { details: { reason: "company_trigger_reservation_mismatch" } },
    );
  assertScheduledRequestMatches(
    context.input.snapshot.scheduledRequest,
    parseScheduledRequestSnapshot(attempt.scheduled_request_snapshot),
  );

  return { runId: attempt.reserved_run_id, scheduleId: attempt.schedule_id };
}
