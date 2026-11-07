import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { SqlTransaction } from "@/lib/db/sql-types";
import type { AssignmentOrigin, PreparedSpecialistAssignment } from "./types";
import type { SpecialistIntakeReceipt } from "./intake-types";

import { sql } from "drizzle-orm";
import { z } from "zod";
import pino from "pino";

import { manualSpecialistAssignmentRequestSchema } from "./intake-types";
import { authorizeAssignment } from "./access";
import {
  inspectSpecialistIntakeReplayInTransaction,
  intakeSpecialistAssignmentInTransaction,
} from "./intake";
import { getSpecialistAssignment } from "./store";
import { wakePendingSpecialistAssignment } from "./admission-wake";

import { agentDefinitionSha256 } from "@/lib/agents/activity-snapshot";
import { resolveAgentConfig } from "@/lib/agents/config";
import {
  launchAgentRun,
  loadAgentContext,
  resolveAgentContextExecutionPolicy,
} from "@/lib/agents/launch";
import { buildOperationalContract } from "@/lib/agents/launch-contract";
import { ownerSchema } from "@/lib/company/types";
import { redactQueryError, queryErrorDiagnostics } from "@/lib/db/pg-error";
import { contentDigest } from "@/lib/evaluations/digest";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { assertUpgradeMaintenanceAllows } from "@/lib/maintenance/upgrade-fence";

export const projectManualAssignmentRequestSchema =
  manualSpecialistAssignmentRequestSchema
    .extend({
      owner: ownerSchema.options[1],
    })
    .strict();
type ProjectManualAssignmentRequest = z.infer<
  typeof projectManualAssignmentRequestSchema
>;
const log = pino({
  name: "project-manual-intake",
  level: process.env.LOG_LEVEL ?? "info",
});

async function prepareProjectManualAssignment(
  tx: SqlTransaction,
  userId: string,
  request: ProjectManualAssignmentRequest,
  origin: AssignmentOrigin,
): Promise<PreparedSpecialistAssignment> {
  for (const action of [
    "assignments:read",
    "assignments:submit",
    "assignments:update",
  ] as const)
    await authorizeAssignment(tx, userId, request.owner, action, {
      preset: "supervised",
    });
  const link = (
    await tx.execute(
      sql`SELECT agent_id FROM agent_project_links WHERE id=${request.specialistBindingId} AND project_id=${request.owner.projectId} FOR SHARE`,
    )
  ).rows[0];

  if (typeof link?.agent_id !== "string")
    throw new MaisterError(
      "PRECONDITION",
      "The selected project specialist attachment is unavailable",
    );
  const context = await loadAgentContext(tx, {
    projectId: request.owner.projectId,
    agentId: link.agent_id,
    trigger: { source: "manual" },
  });
  const effective = context.effective;

  if (
    !effective.parsed.specialist ||
    effective.parsed.flow !== null ||
    effective.parsed.kind !== "operational"
  )
    throw new MaisterError(
      "PRECONDITION",
      "Project manual standalone assignments require a declared operational specialist; coordinator admission requires its declared Flow",
    );
  const contract = buildOperationalContract(effective);
  const resolvedConfiguration = z
    .record(z.string(), z.json())
    .safeParse(
      resolveAgentConfig(effective.parsed.config, context.link.config ?? null),
    );

  if (!resolvedConfiguration.success)
    throw new MaisterError(
      "CONFIG",
      "Project specialist configuration must contain serializable JSON values",
    );
  const configuration = resolvedConfiguration.data;
  const {
    owner,
    specialistBindingId,
    idempotencyKey: _key,
    ...objective
  } = request;

  return {
    owner,
    specialistBindingId,
    responsibleAgentId: effective.parsed.id,
    objectiveInput: {
      ...objective,
      expectedResult: {
        schemaRef: contract.schemaRef,
        schemaVersion: contract.schemaVersion,
        sha256: contract.sha256,
        required: true,
      },
    },
    standingDefinition: {
      schemaVersion: 1,
      agentId: effective.parsed.id,
      packageInstallId: effective.packageInstallId,
      packageName: effective.packageName,
      packageRevision: contract.provenance.resolvedRevision,
      definitionSha256: agentDefinitionSha256(effective.parsed),
      definition: effective.parsed,
      configuration:
        Object.keys(configuration).length === 0 ? null : configuration,
    },
    scheduledRequest: null,
    sourceRestrictions: [
      { kind: "project_context", projectId: owner.projectId },
    ],
    executionPolicy: resolveAgentContextExecutionPolicy(context),
    origin,
    destination: { kind: "inbox", userId },
  };
}

/** Persist requested work before repository admission; failed admission leaves the original queued request retryable. */
export async function submitProjectManualAssignment(
  db: Db,
  userId: string,
  value: unknown,
): Promise<SpecialistIntakeReceipt> {
  const parsed = projectManualAssignmentRequestSchema.safeParse(value);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Project specialist work requires a bounded original request and idempotency key",
    );
  const request = parsed.data;
  const origin: AssignmentOrigin = {
    kind: "manual",
    interactionId: contentDigest({
      schemaVersion: 1,
      kind: "project_manual_assignment",
      userId,
      idempotencyKey: request.idempotencyKey,
    }),
  };
  const { idempotencyKey: _key, ...originalRequest } = request;

  try {
    const replay = await db.transaction(async (tx) => {
      for (const action of ["assignments:read", "assignments:submit"] as const)
        await authorizeAssignment(tx, userId, request.owner, action, {
          preset: "supervised",
        });

      return inspectSpecialistIntakeReplayInTransaction(
        tx,
        userId,
        origin,
        originalRequest,
      );
    });

    if (replay && replay.assignment.runIds.length > 0) {
      await wakePendingSpecialistAssignment(db, replay);
      log.debug(
        {
          assignmentId: replay.assignment.id,
          receiptId: replay.receiptId,
          projectId: request.owner.projectId,
        },
        "project manual delivery adopted its retained execution",
      );

      return replay;
    }
    assertUpgradeMaintenanceAllows("run_admission");
    const receipt =
      replay ??
      (await db.transaction((tx) =>
        intakeSpecialistAssignmentInTransaction(
          tx,
          userId,
          origin,
          originalRequest,
          (sourceTx) =>
            prepareProjectManualAssignment(sourceTx, userId, request, origin),
        ),
      ));
    const agentId = receipt.assignment.responsible.id;

    if (
      receipt.assignment.responsible.kind !== "agent" ||
      typeof agentId !== "string"
    )
      throw new MaisterError(
        "CONFIG",
        "The retained assignment has no responsible specialist identity",
      );

    log.debug(
      {
        assignmentId: receipt.assignment.id,
        inputRevision: receipt.inputRevision,
        projectId: request.owner.projectId,
      },
      "project manual work entering existing admission",
    );
    try {
      await launchAgentRun({
        db,
        projectId: request.owner.projectId,
        agentId,
        trigger: { source: "manual" },
        specialistAssignment: {
          assignmentId: receipt.assignment.id,
          inputRevision: receipt.inputRevision,
          expectedRevision: receipt.assignment.revision,
          userId,
        },
      });
    } catch (error) {
      if (
        !isMaisterError(error) ||
        error.code !== "CONFLICT" ||
        error.details?.reason !== "assignment_revision_conflict"
      )
        throw error;
      const winner = await getSpecialistAssignment(
        db,
        userId,
        receipt.assignment.id,
      );

      if (winner.runIds.length === 0) throw error;
      log.info(
        {
          assignmentId: winner.id,
          receiptId: receipt.receiptId,
          projectId: request.owner.projectId,
        },
        "project manual delivery adopted concurrent admission",
      );

      const adopted = { ...receipt, assignment: winner };

      await wakePendingSpecialistAssignment(db, adopted);

      return adopted;
    }
    const assignment = await getSpecialistAssignment(
      db,
      userId,
      receipt.assignment.id,
    );

    if (assignment.runIds.length === 0)
      throw new MaisterError(
        "CRASH",
        "Project admission returned without retaining its assignment execution link",
      );
    log.info(
      {
        assignmentId: assignment.id,
        receiptId: receipt.receiptId,
        projectId: request.owner.projectId,
        runIds: assignment.runIds,
      },
      "project manual work retained its existing execution links",
    );

    return { ...receipt, assignment };
  } catch (error) {
    log.warn(
      {
        projectId: request.owner.projectId,
        specialistBindingId: request.specialistBindingId,
        code: isMaisterError(error) ? error.code : undefined,
        reason:
          isMaisterError(error) && typeof error.details?.reason === "string"
            ? error.details.reason
            : undefined,
        ...queryErrorDiagnostics(error),
      },
      "project manual admission refused",
    );
    throw redactQueryError(error);
  }
}
