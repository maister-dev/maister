import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";
import type {
  CompanyAgentContextInput,
  CompanySpecialistContext,
} from "./company-agent-context";
import type { CompanyFlowBindingRevision } from "./company-flow-binding-types";
import type { Run } from "@/lib/db/schema";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { companyTriggerBindingSnapshotSchema } from "./trigger-attempt-types";
import { parseScheduledRequestSnapshot } from "./scheduled-request";
import { assertScheduledRequestMatches } from "./scheduled-request-store";
import { resolveCompanyEventChainDepth } from "./chain-depth";
import { retryRefusal } from "./retry-guards";
import { assertCompanyRunReadAccessInTransaction } from "./company-run-read-access";

import { authorizeCompanyUserAction } from "@/lib/company/authority";
import { MaisterError } from "@/lib/errors";
import { contentDigest } from "@/lib/evaluations/digest";

export type CompanyTriggerReservation = Readonly<{
  attemptId: string;
  runId: string;
}>;

/** A cron continuation keeps the original invocation identity and freezes the original input. */
export async function authorizeCompanyCronReplacementSource(
  tx: SqlTransaction,
  sourceRunId: string,
  userId: string,
): Promise<{ scheduleId: string; triggerEventId: null; agentChainDepth: 0 }> {
  const [witness] = (
    await tx.execute(sql`
    SELECT company_cron_retry_source_schedule(${sourceRunId},${userId}) AS id
  `)
  ).rows;

  if (typeof witness?.id !== "string")
    throw retryRefusal("retry_context_changed");

  return { scheduleId: witness.id, triggerEventId: null, agentChainDepth: 0 };
}

export async function authorizeCompanyEventReplacementSource(
  tx: SqlTransaction,
  sourceRunId: string,
  userId: string,
): Promise<{
  scheduleId: string;
  triggerEventId: number;
  agentChainDepth: number;
}> {
  const [row] = (
    await tx.execute(
      sql`SELECT * FROM company_event_retry_source(${sourceRunId},${userId})`,
    )
  ).rows;
  const eventId = Number(row?.event_id);

  if (
    typeof row?.schedule_id !== "string" ||
    typeof row.producing_run_id !== "string" ||
    !Number.isSafeInteger(eventId) ||
    eventId < 1 ||
    typeof row.chain_depth !== "number"
  )
    throw retryRefusal("retry_context_changed");
  await assertCompanyRunReadAccessInTransaction(
    tx,
    userId,
    row.producing_run_id,
  );
  const chain = await resolveCompanyEventChainDepth(tx, eventId);

  if (chain.atCap || chain.depth !== row.chain_depth)
    throw retryRefusal("retry_context_changed");

  return {
    scheduleId: row.schedule_id,
    triggerEventId: eventId,
    agentChainDepth: chain.depth,
  };
}

export async function companyReplacementTriggerSource(
  tx: SqlTransaction,
  sourceRunId: string,
  userId: string,
  triggerSource: Run["triggerSource"],
): Promise<Omit<
  Awaited<ReturnType<typeof assertCompanyTriggerReservation>>,
  "runId"
> | null> {
  if (triggerSource === "cron")
    return authorizeCompanyCronReplacementSource(tx, sourceRunId, userId);
  if (triggerSource === "domain_event")
    return authorizeCompanyEventReplacementSource(tx, sourceRunId, userId);
  if (triggerSource === "webhook") {
    const [witness] = (
      await tx.execute(
        sql`SELECT company_webhook_retry_source_owner(${sourceRunId},${userId}) AS company_id`,
      )
    ).rows;

    if (typeof witness?.company_id !== "string")
      throw retryRefusal("retry_context_changed");
    await authorizeCompanyUserAction(
      tx,
      userId,
      witness.company_id,
      "assignments:submit",
    );

    return null;
  }
  if (triggerSource !== "manual")
    throw retryRefusal("retry_source_unsupported");

  return null;
}

/** Automated source admission must retain its durable appointment before allocating execution. */
export function assertCompanyTriggerAppointment(
  triggerSource: CompanyAgentContextInput["triggerSource"],
  invocation: CompanyTriggerReservation | undefined,
): void {
  if (["cron", "domain_event"].includes(triggerSource) && !invocation)
    throw new MaisterError(
      "CONFIG",
      "Company source admission requires its existing reservation",
      { details: { reason: "company_trigger_reservation_required" } },
    );
  if (!["cron", "domain_event"].includes(triggerSource) && invocation)
    throw new MaisterError(
      "CONFIG",
      "A company source reservation cannot authorize another invocation trigger",
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
  trigger_source: z.enum(["cron", "domain_event"]),
  trigger_event_id: z.coerce.number().int().positive().safe().nullable(),
  outcome: z.null(),
  scheduled_request_snapshot: z.unknown(),
});

/** A source adapter may use only the existing immutable invocation reservation, never a caller-chosen Run ID. */
export async function assertCompanyTriggerReservation(
  tx: SqlTransaction,
  userId: string,
  context: CompanySpecialistContext,
  invocation: CompanyTriggerReservation,
  coordinator: CompanyFlowBindingRevision | null,
  triggerSource: CompanyAgentContextInput["triggerSource"],
): Promise<
  Readonly<{
    runId: string;
    scheduleId: string;
    triggerEventId: number | null;
    agentChainDepth: number;
  }>
> {
  const parsed = attemptSchema.safeParse(
    (
      await tx.execute(sql`
    SELECT id,company_id,project_id,source_agent_id,schedule_id,binding_snapshot,reserved_run_id,trigger_source,trigger_event_id,outcome,scheduled_request_snapshot
    FROM agent_trigger_attempts WHERE id=${invocation.attemptId} FOR SHARE
  `)
    ).rows[0],
  );

  if (!parsed.success)
    throw new MaisterError(
      "CONFLICT",
      "The unsettled company source invocation is unavailable",
      { details: { reason: "company_trigger_reservation_unavailable" } },
    );
  const attempt = parsed.data;
  const source = (
    await tx.execute(sql`
    SELECT id FROM agent_schedules WHERE id=${attempt.schedule_id} AND company_id=${context.owner.companyId} AND project_id IS NULL
      AND created_by=${userId} AND enabled AND trigger_type=${attempt.binding_snapshot.triggerType} AND agent_id=${context.effective.parsed.id}
      AND company_config_revision=${attempt.binding_snapshot.sourceRevision}
      AND company_specialist_binding_id=${context.binding.bindingId} FOR SHARE
  `)
  ).rows[0];
  const origin = context.assignment.origin;
  const originMatches =
    attempt.trigger_source === "cron"
      ? origin.kind === "schedule" &&
        origin.scheduleId === attempt.schedule_id &&
        origin.triggerAttemptId === attempt.id &&
        attempt.trigger_event_id === null
      : origin.kind === "event" &&
        origin.subscriptionId === attempt.schedule_id &&
        origin.eventId === String(attempt.trigger_event_id) &&
        attempt.trigger_event_id !== null;
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
    !originMatches ||
    attempt.trigger_source !== triggerSource ||
    (attempt.trigger_source === "cron") !==
      (attempt.binding_snapshot.triggerType === "cron") ||
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

  const chain: Awaited<ReturnType<typeof resolveCompanyEventChainDepth>> =
    attempt.trigger_event_id === null
      ? { depth: 0, atCap: false }
      : await resolveCompanyEventChainDepth(tx, attempt.trigger_event_id);

  if (chain.atCap)
    throw new MaisterError(
      "PRECONDITION",
      "The producing company event has exhausted its agent chain budget",
      {
        details: { reason: chain.reason ?? "chain_depth_exhausted" },
      },
    );

  return {
    runId: attempt.reserved_run_id,
    scheduleId: attempt.schedule_id,
    triggerEventId: attempt.trigger_event_id,
    agentChainDepth: chain.depth,
  };
}
