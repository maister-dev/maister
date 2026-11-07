import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { SqlTransaction } from "@/lib/db/sql-types";
import type { ExecutionHosts } from "@/lib/execution-host";
import type { CompanyTriggerReservation } from "@/lib/agents/company-trigger-reservation";
import type { SpecialistIntakeReceipt } from "./intake-types";
import type { CompanyTriggerInvocation } from "./company-trigger-intake";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { reserveCompanyTriggerAssignment } from "./company-trigger-intake";

import { companyTriggerBindingSnapshotSchema } from "@/lib/agents/trigger-attempt-types";
import { assertCompanyRunReadAccessInTransaction } from "@/lib/agents/company-run-read-access";
import { knowledgeAccessCaptureSchema } from "@/lib/company/types";
import { isAgentTriggerEventKind } from "@/lib/domain-events/taxonomy";
import { createExecutionHosts } from "@/lib/execution-host";
import { MaisterError } from "@/lib/errors";

const identity = z.string().min(1).max(128);
const eventInvocationSchema = z.object({
  id: identity,
  company_id: identity,
  project_id: z.null(),
  schedule_id: identity,
  reserved_run_id: identity,
  outcome: z.string().nullable(),
  trigger_source: z.literal("domain_event"),
  scheduled_request_snapshot: z.null(),
  trigger_event_id: z.coerce.number().int().positive().safe(),
  created_by: identity,
  binding_snapshot: companyTriggerBindingSnapshotSchema,
  event_kind: z.string().refine(isAgentTriggerEventKind),
  source_run_id: identity,
  source_capture: knowledgeAccessCaptureSchema,
});

async function loadCompanyEventInvocation(
  tx: SqlTransaction,
  invocation: CompanyTriggerReservation,
): Promise<CompanyTriggerInvocation> {
  const parsed = eventInvocationSchema.safeParse(
    (
      await tx.execute(sql`
    SELECT attempt.id,attempt.company_id,attempt.project_id,attempt.schedule_id,attempt.reserved_run_id,attempt.outcome,
      attempt.trigger_source,attempt.scheduled_request_snapshot,attempt.trigger_event_id,attempt.binding_snapshot,source.created_by,
      event.kind AS event_kind,producing.id AS source_run_id,producing.knowledge_access AS source_capture
    FROM agent_trigger_attempts attempt
    JOIN agent_schedules source ON source.id=attempt.schedule_id AND source.company_id=attempt.company_id AND source.project_id IS NULL
    JOIN domain_events event ON event.id=attempt.trigger_event_id AND event.company_id=attempt.company_id AND event.project_id IS NULL
      AND source.created_at<=event.created_at
    JOIN runs producing ON producing.id=event.run_id AND producing.company_id=attempt.company_id AND producing.project_id IS NULL
    WHERE attempt.id=${invocation.attemptId} FOR SHARE OF attempt,source,event,producing
  `)
    ).rows[0],
  );

  if (
    !parsed.success ||
    parsed.data.reserved_run_id !== invocation.runId ||
    parsed.data.source_capture.state !== "complete"
  )
    throw new MaisterError(
      "CONFLICT",
      "The exact company event invocation and classified producing Run are unavailable",
      {
        details: { reason: "company_event_invocation_unavailable" },
      },
    );
  const source = parsed.data;

  if (!source.binding_snapshot.eventKinds.includes(source.event_kind))
    throw new MaisterError(
      "CONFLICT",
      "The retained subscription does not match this event kind",
      {
        details: { reason: "company_event_kind_mismatch" },
      },
    );
  await assertCompanyRunReadAccessInTransaction(
    tx,
    source.created_by,
    source.source_run_id,
  );

  return {
    userId: source.created_by,
    companyId: source.company_id,
    outcome: source.outcome,
    origin: {
      kind: "event",
      eventId: String(source.trigger_event_id),
      subscriptionId: source.schedule_id,
    },
    scheduledRequest: null,
    sourceRestrictions: source.source_capture.restrictions,
    triggerSource: "domain_event",
    request: {
      owner: { kind: "company", companyId: source.company_id },
      specialistBindingId: source.binding_snapshot.specialistBinding.id,
      objective: `Handle authorized company ${source.event_kind} event ${source.trigger_event_id} for subscription ${source.schedule_id}`,
      expectedOutcome:
        "Produce the specialist's required result for this exact event invocation.",
      input: JSON.stringify({
        schemaVersion: 1,
        event: {
          id: String(source.trigger_event_id),
          kind: source.event_kind,
          runId: source.source_run_id,
        },
      }),
      inputRefs: [],
      targetIds: [],
      constraints: [],
      verification: [{ kind: "result", referenceId: null, required: true }],
    },
  };
}

/** Registered event delivery retains a source-authorized assignment through the existing invocation ledger. */
export async function reserveCompanyEventAssignment(
  db: Db,
  invocation: CompanyTriggerReservation,
  hosts: ExecutionHosts = createExecutionHosts({ db }),
): Promise<SpecialistIntakeReceipt> {
  return reserveCompanyTriggerAssignment(
    db,
    invocation,
    loadCompanyEventInvocation,
    hosts,
  );
}
