import "server-only";

import type { CompanyTriggerReservation } from "./company-trigger-reservation";
import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHost } from "@/lib/db/schema";
import type { CompanyRunReservation } from "./company-execution-types";
import type { ExecutionHosts } from "@/lib/execution-host";
import type { AssignmentInputRevision } from "@/lib/specialist-assignments/types";
import type { DelegatedWorkRequest } from "@/lib/specialist-assignments/delegated-intake";
import type {
  CompanyAgentContextInput,
  CompanySpecialistExecutionIdentityInput,
} from "./company-agent-context";

import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import pino from "pino";

import {
  assertCompanyTriggerAppointment,
  assertCompanyTriggerReservation,
} from "./company-trigger-reservation";
import {
  prepareCompanyAgentContext,
  captureCompanyAgentExecution,
  prepareCompanySpecialistRole,
} from "./company-agent-context";
import {
  agentDefinitionSha256,
  buildAgentActivitySnapshot,
  withAgentComparisonScopes,
} from "./activity-snapshot";
import { runnerCatalogEntry } from "./runner-catalog";
import { assertReadOnlySessionEvidence } from "./runner-readonly-evidence";
import { buildOperationalContract } from "./launch-contract";
import { requireCompanyRunCredentialOwner } from "./company-run-credential-owner";
import { assertStandaloneCompanyAgentDefinition } from "./company-agent-definition";

import { capabilityAgentSchema } from "@/lib/config.schema";
import {
  resolveCompanyAgentRunner,
  defaultRunSessionValues,
} from "@/lib/acp-runners/resolve";
import { inspectKnowledgeEvidenceReference } from "@/lib/brain/knowledge-reference";
import { assertNativeRunKnowledgeInputsInTransaction } from "@/lib/brain/knowledge-execution-access";
import { authorizeCompanyUserAction } from "@/lib/company/authority";
import {
  platformAcpRunners,
  platformRuntimeSettings,
  runs,
  runSessions,
} from "@/lib/db/schema";
import { redactQueryError, queryErrorDiagnostics } from "@/lib/db/pg-error";
import { MaisterError } from "@/lib/errors";
import { contentDigest } from "@/lib/evaluations/digest";
import { createExecutionHosts, mintPlacement } from "@/lib/execution-host";
import { localHost } from "@/lib/execution-host/resolver";
import { executionDataPlaneModeForHost } from "@/lib/execution-host/data-plane-capabilities";
import { assertUpgradeMaintenanceAllows } from "@/lib/maintenance/upgrade-fence";
import { admitDelegatedChild } from "@/lib/orchestrator/admission";
import { expandExecutionPolicy } from "@/lib/runs/execution-policy";
import { readAuthorizedAssignmentInput } from "@/lib/specialist-assignments/context";
import {
  bindDelegatedWorkRunInTransaction,
  retainDelegatedWorkInTransaction,
} from "@/lib/specialist-assignments/delegated-intake";
import { activateInitialSpecialistAssignmentRunInTransaction } from "@/lib/specialist-assignments/store";

const log = pino({
  name: "agents:company-launch",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Reserve native execution, session, placement and exact input atomically; dispatch uses the existing scheduler. */
export async function reserveCompanyAgentRun(
  db: Db,
  userId: string,
  input: CompanyAgentContextInput,
  hosts: ExecutionHosts = createExecutionHosts({ db }),
): Promise<CompanyRunReservation> {
  try {
    assertUpgradeMaintenanceAllows("run_admission");
    await db.transaction((tx) => prepareCompanyAgentContext(tx, userId, input));
    const host = await localHost({ db, transport: hosts.transport });

    const receipt = await db.transaction((tx) =>
      reserveCompanyAgentRunInTransaction(tx, userId, input, hosts, host),
    );

    log.info(
      {
        ...receipt,
        bindingId: input.bindingId,
        inputRevision: input.inputRevision,
        hostId: host.id,
      },
      "company agent execution reserved",
    );

    return receipt;
  } catch (error) {
    log.warn(
      {
        assignmentId: input.assignmentId,
        code: error instanceof MaisterError ? error.code : undefined,
        ...queryErrorDiagnostics(error),
      },
      "company agent reservation refused",
    );
    throw redactQueryError(error);
  }
}

/** Reserve on the caller's transaction after host activation on a stable pooled database. */
export async function reserveCompanyAgentRunInTransaction(
  tx: Db,
  userId: string,
  input: CompanyAgentContextInput,
  hosts: ExecutionHosts,
  host: ExecutionHost,
  invocation?: CompanyTriggerReservation,
): Promise<CompanyRunReservation> {
  assertCompanyTriggerAppointment(input.triggerSource, invocation);
  assertUpgradeMaintenanceAllows("run_admission");
  const context = await prepareCompanyAgentContext(tx, userId, input);
  const triggerReservation = invocation
    ? await assertCompanyTriggerReservation(
        tx,
        userId,
        context,
        invocation,
        null,
        input.triggerSource,
      )
    : null;
  const runId = triggerReservation?.runId ?? randomUUID();

  await insertCompanyAgentRun(tx, context, hosts, host, {
    runId,
    triggerSource: input.triggerSource,
    triggerReservation,
    scheduledRequest: context.input.snapshot.scheduledRequest,
  });
  const assignmentRevision =
    await activateInitialSpecialistAssignmentRunInTransaction(
      tx,
      userId,
      context.assignment.id,
      {
        runId,
        inputRevision: context.input.revision,
        expectedRevision: context.assignment.revision,
        role: "specialist",
      },
    );

  await assertNativeRunKnowledgeInputsInTransaction(tx, runId);
  for (const reference of context.input.snapshot.objectiveInput.inputRefs)
    await inspectKnowledgeEvidenceReference(
      tx,
      { kind: "execution", runId, nodeAttemptId: null },
      reference,
    );

  return {
    runId,
    assignmentId: context.assignment.id,
    assignmentRevision,
    status: "Pending" as const,
  };
}

/** Reserve a taskless company child under the actual professional's canonical work receipt. */
export async function reserveCompanyDelegatedAgentRun(
  db: Db,
  request: DelegatedWorkRequest,
  hosts: ExecutionHosts = createExecutionHosts({ db }),
): Promise<{ childRunId: string; status: string }> {
  assertUpgradeMaintenanceAllows("run_admission");
  const host = await localHost({ db, transport: hosts.transport });

  return db
    .transaction(async (tx) => {
      const { work } = await retainDelegatedWorkInTransaction(tx, request);
      const { target, parent, objectiveInput } = work.definition;

      if (target.kind !== "company_agent")
        throw new MaisterError(
          "CONFIG",
          "Select a reviewed standalone company specialist",
        );
      const { binding, effective } = await prepareCompanySpecialistRole(tx, {
        companyId: target.companyId,
        bindingId: target.specialistBinding.id,
        bindingRevision: target.specialistBinding.revision,
      });
      const [receivingGrant] = (
        await tx.execute(sql`
        SELECT id FROM company_grants
        WHERE company_id=${target.companyId} AND principal_type='agent'
          AND principal_id=${binding.snapshot.agentId} AND action='assignments:read'
          AND revoked_at IS NULL FOR SHARE
      `)
      ).rows;

      if (
        !binding.snapshot.grantActions.includes("assignments:read") ||
        !receivingGrant
      )
        throw new MaisterError(
          "UNAUTHORIZED",
          "The receiving company specialist lacks current assignment read authority",
        );
      if (work.childRunId !== null) {
        const [child] = await tx
          .select({ status: runs.status })
          .from(runs)
          .where(eq(runs.id, work.childRunId));

        if (!child)
          throw new MaisterError(
            "CRASH",
            "The bound delegated Run is unavailable",
          );

        return { childRunId: work.childRunId, status: child.status };
      }
      await admitDelegatedChild(tx, {
        parentRunId: parent.runId,
        assignmentBounds: work.bounds,
        reservedRunId: work.reservedRunId,
      });
      const owner = await requireCompanyRunCredentialOwner(tx, parent.runId);
      const authority = await authorizeCompanyUserAction(
        tx,
        owner.userId,
        target.companyId,
        "assignments:update",
      );
      const input = await readAuthorizedAssignmentInput(
        tx,
        {
          kind: "execution",
          runId: parent.runId,
          nodeAttemptId: parent.nodeAttemptId,
        },
        work.assignmentId,
        work.inputRevision,
      );
      const definition = effective.parsed;

      assertStandaloneCompanyAgentDefinition(definition);
      const result = buildOperationalContract(effective);

      if (
        binding.snapshot.coordinatorFlowRevisionId !== null ||
        binding.snapshotDigest !== target.specialistBinding.snapshotSha256 ||
        definition.id !== target.role.agentId ||
        effective.packageInstallId !== target.role.packageInstallId ||
        effective.resolvedRevision !== target.role.packageRevision ||
        agentDefinitionSha256(definition) !== target.role.definitionSha256 ||
        contentDigest(
          expandExecutionPolicy(binding.snapshot.executionPolicy),
        ) !==
          contentDigest(
            expandExecutionPolicy(work.authoritySnapshot.executionPolicy),
          ) ||
        result.schemaRef !== objectiveInput.expectedResult.schemaRef ||
        result.schemaVersion !== objectiveInput.expectedResult.schemaVersion ||
        result.sha256 !== objectiveInput.expectedResult.sha256 ||
        objectiveInput.expectedResult.required !== true
      )
        throw new MaisterError(
          "CONFLICT",
          "The company child does not match the retained work policy, role and required result",
          {
            details: { reason: "delegated_work_binding_changed" },
          },
        );
      const [head] = (
        await tx.execute(
          sql`SELECT revision FROM specialist_assignments WHERE id=${work.assignmentId}`,
        )
      ).rows;

      if (typeof head?.revision !== "number")
        throw new MaisterError(
          "CRASH",
          "The retained delegated assignment is unavailable",
        );
      const runId = work.reservedRunId;

      await insertCompanyAgentRun(
        tx,
        {
          owner: { kind: "company", companyId: target.companyId },
          assignment: { id: work.assignmentId, revision: head.revision },
          input,
          binding,
          effective,
          authority,
        },
        hosts,
        host,
        {
          runId,
          triggerSource: "manual",
          scheduledRequest: null,
          parentRunId: parent.runId,
          rootRunId: parent.rootRunId,
        },
      );
      await bindDelegatedWorkRunInTransaction(tx, work);
      await assertNativeRunKnowledgeInputsInTransaction(tx, runId);

      return { childRunId: runId, status: "Pending" };
    })
    .catch((error: unknown) => {
      log.warn(
        {
          assignmentId: request.selector.assignmentId,
          logicalWorkId: request.selector.logicalWorkId,
          code: error instanceof MaisterError ? error.code : undefined,
          ...queryErrorDiagnostics(error),
        },
        "delegated company agent reservation refused",
      );
      throw redactQueryError(error);
    });
}

async function insertCompanyAgentRun(
  tx: Db,
  context: CompanySpecialistExecutionIdentityInput,
  hosts: ExecutionHosts,
  host: ExecutionHost,
  execution: Readonly<{
    runId: string;
    triggerSource: CompanyAgentContextInput["triggerSource"];
    triggerReservation?: Awaited<
      ReturnType<typeof assertCompanyTriggerReservation>
    > | null;
    scheduledRequest: AssignmentInputRevision["snapshot"]["scheduledRequest"];
    parentRunId?: string;
    rootRunId?: string;
  }>,
): Promise<void> {
  const { runId } = execution;
  const executionDataPlaneMode = executionDataPlaneModeForHost(host);
  const definition = context.effective.parsed;

  const [runtime] = await tx
    .select()
    .from(platformRuntimeSettings)
    .where(eq(platformRuntimeSettings.id, "singleton"))
    .for("share");

  const runners = await tx.select().from(platformAcpRunners).for("share");
  const resolution = resolveCompanyAgentRunner({
    bindingRunnerId: context.binding.snapshot.runnerId,
    agent: {
      runnerId: definition.runner,
      mode: definition.mode,
      workspace: definition.workspace,
    },
    platform: { defaultRunnerId: runtime?.defaultRunnerId ?? null },
    runners: runners.map(runnerCatalogEntry),
  });

  await assertReadOnlySessionEvidence({
    hosts,
    adapterId: resolution.runnerSnapshot.adapter,
    runnerId: resolution.runnerId,
    workspace: definition.workspace,
  });
  const snapshot = captureCompanyAgentExecution(context);
  const trigger = { source: execution.triggerSource };

  await tx.insert(runs).values({
    id: runId,
    agentScheduleId: execution.triggerReservation?.scheduleId ?? null,
    triggerEventId: execution.triggerReservation?.triggerEventId ?? null,
    agentChainDepth: execution.triggerReservation?.agentChainDepth ?? 0,
    runKind: "agent",
    companyId: context.owner.companyId,
    companyExecutionSnapshot: snapshot,
    agentId: definition.id,
    sourceAgentId: definition.id,
    agentKind: "operational",
    agentWorkspace: "none",
    currentStepId: "agent",
    status: "Pending",
    flowVersion: "agent",
    flowRevision: "manual",
    createdByUserId: context.authority.actor.id,
    parentRunId: execution.parentRunId,
    rootRunId: execution.rootRunId,
    triggerSource: execution.triggerSource,
    agentConfig: context.binding.snapshot.effectiveConfiguration,
    executionPolicy: context.binding.snapshot.executionPolicy,
    scheduledRequestSnapshot: execution.scheduledRequest,
    resultContract: buildOperationalContract(context.effective),
    launchedAt: sql`CURRENT_TIMESTAMP`,
    activitySortAt: sql`CURRENT_TIMESTAMP`,
    activityTimestampProvenance: "launch",
    agentActivitySnapshot: withAgentComparisonScopes(
      buildAgentActivitySnapshot(definition.id, context.effective),
      {
        configuration: context.binding.snapshot.effectiveConfiguration,
        trigger,
        taskId: null,
        runner: resolution.runnerSnapshot,
        workspace: "none",
        hostId: host.id,
      },
    ),
    executionDataPlaneMode,
    knowledgeAccess: {
      schemaVersion: 1,
      state: "complete",
      generation: 1,
      restrictions: [
        {
          kind: "assignment_input",
          assignmentId: context.assignment.id,
          inputRevision: context.input.revision,
          inputSha256: context.input.digest,
        },
      ],
    },
  });
  await tx.insert(runSessions).values({
    id: randomUUID(),
    ...defaultRunSessionValues(runId, resolution),
    capabilityAgent: capabilityAgentSchema.parse(resolution.capabilityAgent),
  });
  await mintPlacement(tx, {
    runId,
    reason: "launch",
    host,
  });
}
