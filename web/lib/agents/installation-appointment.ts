import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";
import type { AssignmentOrigin } from "@/lib/specialist-assignments/types";
import type { CompanyTriggerReservation } from "./company-trigger-reservation";

import { sql } from "drizzle-orm";
import pino from "pino";
import { z } from "zod";

import { companyAgentExecutionSnapshotSchema } from "./company-agent-execution-types";
import { installationAgentGrantSchema } from "./installation-access-types";
import { companyConfigurationReferenceSchema } from "./trigger-attempt-types";

import { contentDigest } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "agents:installation-appointment",
  level: process.env.LOG_LEVEL ?? "info",
});

export const installationScheduleReviewSchema = z.strictObject({
  schemaVersion: z.literal(1),
  binding: companyConfigurationReferenceSchema,
  reviewer: companyAgentExecutionSnapshotSchema.shape.authority,
});

const retainedInstallationAppointment = Symbol(
  "retainedInstallationAppointment",
);
export type InstallationAppointment = Readonly<{
  [retainedInstallationAppointment]: SqlTransaction;
  companyId: string;
  runId: string;
  agentId: string;
  scopes: z.infer<typeof installationAgentGrantSchema>["scopes"];
  origin: Extract<AssignmentOrigin, { kind: "schedule" | "event" }>;
  review: z.infer<typeof installationScheduleReviewSchema>;
}>;
export type SpecialistIntakePrincipal = string | InstallationAppointment;

function appointmentUnavailable() {
  return new MaisterError(
    "PRECONDITION",
    "The reviewed installation source appointment is unavailable",
  );
}

/** Only the existing reserved source can create this transaction-local internal principal. */
export async function resolveInstallationAppointment(
  tx: SqlTransaction,
  invocation: CompanyTriggerReservation,
) {
  const result = await tx.execute(sql`
    SELECT source.installation_review,source.created_by,source.enabled,source.company_config_revision,source.stand_inspection,
      source.id AS schedule_id,head.id AS binding_id,revision.revision,revision.snapshot_digest,
      revision.snapshot->'installationGrant' AS grant,attempt.company_id,attempt.source_agent_id,
      attempt.trigger_source,attempt.trigger_event_id::text,attempt.outcome,attempt.binding_snapshot->'specialistBinding' AS captured_binding,
      attempt.binding_snapshot->'sourceRevision' AS captured_source_revision
    FROM agent_trigger_attempts attempt
    JOIN agent_schedules source ON source.id=attempt.schedule_id AND source.company_id=attempt.company_id AND source.project_id IS NULL
    JOIN company_specialist_bindings head ON head.id=source.company_specialist_binding_id AND (head.company_id,head.agent_id)=(attempt.company_id,attempt.source_agent_id)
    JOIN company_specialist_binding_revisions revision ON (revision.binding_id,revision.revision)=(head.id,head.revision)
    WHERE attempt.id=${invocation.attemptId} AND attempt.reserved_run_id=${invocation.runId}
      AND attempt.project_id IS NULL
    FOR SHARE OF source,head,revision,attempt
  `);
  const row = result.rows[0];
  if (!row || (row.grant === null && row.installation_review === null))
    return null;
  const parsed = z
    .object({
      installation_review: installationScheduleReviewSchema,
      created_by: z.string(),
      enabled: z.literal(true),
      company_config_revision: z.number().int().positive(),
      stand_inspection: z.null(),
      schedule_id: z.string(),
      binding_id: z.string(),
      revision: z.number().int().positive(),
      snapshot_digest: z.string(),
      grant: installationAgentGrantSchema,
      company_id: z.string(),
      source_agent_id: z.string(),
      trigger_source: z.enum(["cron", "domain_event"]),
      trigger_event_id: z
        .string()
        .regex(/^[1-9][0-9]*$/)
        .nullable(),
      outcome: z.string().nullable(),
      captured_binding: companyConfigurationReferenceSchema,
      captured_source_revision: z.number(),
    })
    .safeParse(row);
  if (!parsed.success) throw appointmentUnavailable();
  const source = parsed.data;
  const review = source.installation_review;
  const binding = {
    id: source.binding_id,
    revision: source.revision,
    snapshotSha256: source.snapshot_digest,
  };
  if (
    contentDigest(binding) !== contentDigest(review.binding) ||
    contentDigest(binding) !== contentDigest(source.captured_binding) ||
    source.company_config_revision !== source.captured_source_revision ||
    source.created_by !== review.reviewer.actor.id ||
    source.company_id !== review.reviewer.witness.owner.companyId ||
    (source.trigger_source === "domain_event") !==
      (source.trigger_event_id !== null)
  )
    throw appointmentUnavailable();
  const origin: InstallationAppointment["origin"] = source.trigger_event_id
    ? {
        kind: "event",
        eventId: source.trigger_event_id,
        subscriptionId: source.schedule_id,
      }
    : {
        kind: "schedule",
        scheduleId: source.schedule_id,
        triggerAttemptId: invocation.attemptId,
      };

  log.debug(
    {
      attemptId: invocation.attemptId,
      runId: invocation.runId,
      bindingId: binding.id,
      bindingRevision: binding.revision,
      trigger: source.trigger_source,
    },
    "installation appointment authorized",
  );

  return {
    [retainedInstallationAppointment]: tx,
    agentId: source.source_agent_id,
    companyId: source.company_id,
    runId: invocation.runId,
    origin,
    review,
    scopes: source.grant.scopes,
  } satisfies InstallationAppointment;
}

export function assertInstallationAppointment(
  tx: SqlTransaction,
  appointment: InstallationAppointment,
  target: {
    companyId: unknown;
    bindingId: unknown;
    origin?: unknown;
    runId?: string;
  },
) {
  if (
    appointment[retainedInstallationAppointment] !== tx ||
    appointment.companyId !== target.companyId ||
    appointment.review.binding.id !== target.bindingId ||
    (target.origin !== undefined &&
      contentDigest(target.origin) !== contentDigest(appointment.origin)) ||
    (target.runId !== undefined && target.runId !== appointment.runId)
  )
    throw appointmentUnavailable();
}

export function specialistIntakeActor(principal: SpecialistIntakePrincipal) {
  return typeof principal === "string"
    ? { kind: "user" as const, id: principal, runId: null, attemptId: null }
    : {
        kind: "agent" as const,
        id: principal.agentId,
        runId: principal.runId,
        attemptId: null,
      };
}
