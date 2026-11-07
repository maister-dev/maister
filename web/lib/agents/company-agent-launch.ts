import "server-only";

import type { CompanyTriggerReservation } from "./company-trigger-reservation";
import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHost } from "@/lib/db/schema";
import type { CompanyRunReservation } from "./company-execution-types";
import type { ExecutionHosts } from "@/lib/execution-host";
import type { CompanyAgentContextInput } from "./company-agent-context";

import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import pino from "pino";

import { assertCompanyTriggerReservation } from "./company-trigger-reservation";
import {
  prepareCompanyAgentContext,
  captureCompanyAgentExecution,
} from "./company-agent-context";
import {
  buildAgentActivitySnapshot,
  withAgentComparisonScopes,
} from "./activity-snapshot";
import { runnerCatalogEntry } from "./runner-catalog";
import { assertReadOnlySessionEvidence } from "./runner-readonly-evidence";
import { buildOperationalContract } from "./launch-contract";

import { capabilityAgentSchema } from "@/lib/config.schema";
import {
  resolveCompanyAgentRunner,
  defaultRunSessionValues,
} from "@/lib/acp-runners/resolve";
import { inspectKnowledgeEvidenceReference } from "@/lib/brain/knowledge-reference";
import { assertNativeRunKnowledgeInputsInTransaction } from "@/lib/brain/knowledge-execution-access";
import {
  platformAcpRunners,
  platformRuntimeSettings,
  runs,
  runSessions,
} from "@/lib/db/schema";
import { redactQueryError, queryErrorDiagnostics } from "@/lib/db/pg-error";
import { MaisterError } from "@/lib/errors";
import { createExecutionHosts, mintPlacement } from "@/lib/execution-host";
import { localHost } from "@/lib/execution-host/resolver";
import { executionDataPlaneModeForHost } from "@/lib/execution-host/data-plane-capabilities";
import { assertUpgradeMaintenanceAllows } from "@/lib/maintenance/upgrade-fence";
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
  assertUpgradeMaintenanceAllows("run_admission");
  const executionDataPlaneMode = executionDataPlaneModeForHost(host);
  const context = await prepareCompanyAgentContext(tx, userId, input);
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
  const triggerReservation = invocation
    ? await assertCompanyTriggerReservation(
        tx,
        userId,
        context,
        invocation,
        null,
      )
    : null;
  const runId = triggerReservation?.runId ?? randomUUID();
  const snapshot = captureCompanyAgentExecution(context);
  const trigger = { source: input.triggerSource };

  await tx.insert(runs).values({
    id: runId,
    agentScheduleId: triggerReservation?.scheduleId ?? null,
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
    createdByUserId: userId,
    triggerSource: input.triggerSource,
    agentConfig: context.binding.snapshot.effectiveConfiguration,
    executionPolicy: context.binding.snapshot.executionPolicy,
    scheduledRequestSnapshot: context.input.snapshot.scheduledRequest,
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
