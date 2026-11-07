import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { SqlTransaction } from "@/lib/db/sql-types";
import type {
  PreparedSpecialistAssignment,
  AssignmentOrigin,
  AssignmentDestination,
} from "./types";
import type { ProjectSpecialistIntakeRequest } from "./intake-types";
import type { ProjectSourceAppointment } from "./project-source-types";
import type { LaunchAgentRunInput } from "@/lib/agents/launch";
import type { SpecialistIntakeReceipt } from "./intake-types";

import { sql } from "drizzle-orm";
import { z } from "zod";
import pino from "pino";

import { authorizeAssignment } from "./access";
import {
  inspectSpecialistIntakeReplayInTransaction,
  intakeSpecialistAssignmentInTransaction,
} from "./intake";
import { getSpecialistAssignment } from "./store";
import { wakePendingSpecialistAssignment } from "./admission-wake";
import { loadProjectCoordinatorProvider } from "./project-flow-provider";

import { agentDefinitionSha256 } from "@/lib/agents/activity-snapshot";
import { resolveAgentConfig } from "@/lib/agents/config";
import {
  launchAgentRun,
  loadAgentContext,
  resolveAgentContextExecutionPolicy,
} from "@/lib/agents/launch";
import { buildOperationalContract } from "@/lib/agents/launch-contract";
import { redactQueryError, queryErrorDiagnostics } from "@/lib/db/pg-error";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { assertUpgradeMaintenanceAllows } from "@/lib/maintenance/upgrade-fence";

export type ProjectRequestInvocation = Readonly<{
  origin: AssignmentOrigin;
  destination: AssignmentDestination;
  trigger: LaunchAgentRunInput["trigger"];
  scheduledRequest: PreparedSpecialistAssignment["scheduledRequest"];
  taskId: string | null;
  source?: ProjectSourceAppointment;
}>;
const log = pino({
  name: "project-request-intake",
  level: process.env.LOG_LEVEL ?? "info",
});

async function prepareProjectSpecialistAssignment(
  tx: SqlTransaction,
  userId: string,
  request: ProjectSpecialistIntakeRequest,
  invocation: ProjectRequestInvocation,
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
    trigger: invocation.trigger,
  });
  const effective = context.effective;

  if (
    !effective.parsed.specialist ||
    (effective.parsed.flow === null && effective.parsed.kind !== "operational")
  )
    throw new MaisterError(
      "PRECONDITION",
      "Project standalone assignments require a declared operational specialist; coordinator admission requires its declared Flow",
    );
  if (typeof effective.resolvedRevision !== "string")
    throw new MaisterError(
      "PRECONDITION",
      "The specialist's exact package revision is unavailable",
    );
  const coordinator =
    effective.parsed.flow === null
      ? null
      : await loadProjectCoordinatorProvider(
          tx,
          request.owner.projectId,
          effective.parsed.flow,
        );
  const contract =
    coordinator?.resultContract ?? buildOperationalContract(effective);
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
  const { owner, specialistBindingId, ...objective } = request;

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
      ...(coordinator
        ? { schemaVersion: 2 as const, coordinatorFlow: coordinator.snapshot }
        : { schemaVersion: 1 as const }),
      agentId: effective.parsed.id,
      packageInstallId: effective.packageInstallId,
      packageName: effective.packageName,
      packageRevision: effective.resolvedRevision,
      definitionSha256: agentDefinitionSha256(effective.parsed),
      definition: effective.parsed,
      configuration:
        Object.keys(configuration).length === 0 ? null : configuration,
    },
    scheduledRequest: invocation.scheduledRequest,
    sourceRestrictions: [
      { kind: "project_context", projectId: owner.projectId },
    ],
    executionPolicy: resolveAgentContextExecutionPolicy(context),
    origin: invocation.origin,
    destination: invocation.destination,
  };
}

/** Preserve one canonical project request and enter only the existing native Run/Flow admission. */
export async function submitProjectUserRequest(
  db: Db,
  userId: string,
  request: ProjectSpecialistIntakeRequest,
  invocation: ProjectRequestInvocation,
): Promise<SpecialistIntakeReceipt> {
  const originalRequest = request;
  const origin = invocation.origin;

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
        "project request delivery adopted its retained execution",
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
            prepareProjectSpecialistAssignment(
              sourceTx,
              userId,
              request,
              invocation,
            ),
        ),
      ));

    if (receipt.assignment.runIds.length > 0) {
      await wakePendingSpecialistAssignment(db, receipt);
      log.debug(
        {
          assignmentId: receipt.assignment.id,
          receiptId: receipt.receiptId,
          projectId: request.owner.projectId,
        },
        "project request atomic intake adopted retained execution",
      );

      return receipt;
    }
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
      "project request work entering existing admission",
    );
    try {
      await launchAgentRun({
        db,
        projectId: request.owner.projectId,
        agentId,
        trigger: invocation.trigger,
        taskId: invocation.taskId,
        runId: invocation.source?.runId,
        agentScheduleId: invocation.source?.scheduleId,
        scheduledRequestSnapshot: invocation.scheduledRequest,
        ...(invocation.source?.kind === "cron"
          ? {
              agentTriggerReservation: {
                attemptId: invocation.source.attemptId,
                runId: invocation.source.runId,
              },
            }
          : {}),
        specialistAssignment: {
          assignmentId: receipt.assignment.id,
          inputRevision: receipt.inputRevision,
          expectedRevision: receipt.assignment.revision,
          userId,
          ...(invocation.source ? { source: invocation.source } : {}),
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

      if (winner.runIds.length === 0) {
        const retainedCarrier = (
          await db.execute(sql`
          SELECT id FROM specialist_assignments
          WHERE id=${receipt.assignment.id} AND project_id=${request.owner.projectId}
            AND status='queued' AND input_revision=${receipt.inputRevision}
            AND revision=${receipt.assignment.revision + 1} AND project_task_id IS NOT NULL
        `)
        ).rows[0];

        if (!retainedCarrier) throw error;
      }
      log.info(
        {
          assignmentId: winner.id,
          receiptId: receipt.receiptId,
          projectId: request.owner.projectId,
        },
        "project request delivery adopted concurrent admission",
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
      "project request work retained its existing execution links",
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
      "project request admission refused",
    );
    throw redactQueryError(error);
  }
}
