import "server-only";

import type { CompanyTriggerReservation } from "./company-trigger-reservation";
import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHost } from "@/lib/db/schema";
import type { CompanyRunReservation } from "./company-execution-types";
import type { ExecutionHosts } from "@/lib/execution-host";
import type { CompanyFlowContextInput } from "./company-flow-context";
import type { RunSessionResolution } from "@/lib/acp-runners/resolve";

import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import pino from "pino";

import {
  assertCompanyTriggerAppointment,
  assertCompanyTriggerReservation,
} from "./company-trigger-reservation";
import {
  captureCompanyFlowExecution,
  companyFlowContextInputSchema,
  prepareCompanyFlowContext,
} from "./company-flow-context";
import {
  buildAgentActivitySnapshot,
  withAgentComparisonScopes,
} from "./activity-snapshot";
import { runnerCatalogEntry } from "./runner-catalog";
import { assertReadOnlySessionEvidence } from "./runner-readonly-evidence";

import { inspectFlowRunners } from "@/lib/acp-runners/flow-preflight";
import { resolveCompanyAgentRunner } from "@/lib/acp-runners/resolve";
import { capabilityAgentSchema } from "@/lib/config.schema";
import {
  platformAcpRunners,
  platformRuntimeSettings,
  runs,
  runSessions,
} from "@/lib/db/schema";
import { queryErrorDiagnostics, redactQueryError } from "@/lib/db/pg-error";
import { MaisterError } from "@/lib/errors";
import { createExecutionHosts, mintPlacement } from "@/lib/execution-host";
import { localHost } from "@/lib/execution-host/resolver";
import { executionDataPlaneModeForHost } from "@/lib/execution-host/data-plane-capabilities";
import { assertUpgradeMaintenanceAllows } from "@/lib/maintenance/upgrade-fence";
import { activateInitialSpecialistAssignmentRunInTransaction } from "@/lib/specialist-assignments/store";

const log = pino({
  name: "agents:company-flow-launch",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Reserve graph execution on existing ledgers; the existing Pending pool owns dispatch. */
export async function reserveCompanyFlowRun(
  db: Db,
  userId: string,
  input: CompanyFlowContextInput,
  hosts: ExecutionHosts = createExecutionHosts({ db }),
): Promise<CompanyRunReservation> {
  const parsed = companyFlowContextInputSchema.safeParse(input);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Company Flow reservation requires exact assignment and reviewed configuration revisions",
      {
        details: { reason: "company_flow_context_invalid" },
      },
    );
  const request = parsed.data;

  try {
    assertUpgradeMaintenanceAllows("run_admission");
    await db.transaction((tx) =>
      prepareCompanyFlowContext(tx, userId, request),
    );
    const host = await localHost({ db, transport: hosts.transport });
    const receipt = await db.transaction((tx) =>
      reserveCompanyFlowRunInTransaction(tx, userId, request, hosts, host),
    );

    log.info(
      {
        ...receipt,
        companyId: request.companyId,
        coordinatorBindingId: request.coordinatorBindingId,
        hostId: host.id,
      },
      "company graph execution reserved",
    );

    return receipt;
  } catch (error) {
    log.warn(
      {
        assignmentId: request.assignmentId,
        coordinatorBindingId: request.coordinatorBindingId,
        code: error instanceof MaisterError ? error.code : undefined,
        ...queryErrorDiagnostics(error),
      },
      "company graph reservation refused",
    );
    throw redactQueryError(error);
  }
}

/** Reserve on the caller's transaction after host activation on a stable pooled database. */
export async function reserveCompanyFlowRunInTransaction(
  tx: Db,
  userId: string,
  input: CompanyFlowContextInput,
  hosts: ExecutionHosts,
  host: ExecutionHost,
  invocation?: CompanyTriggerReservation,
): Promise<CompanyRunReservation> {
  assertCompanyTriggerAppointment(input.triggerSource, invocation);
  assertUpgradeMaintenanceAllows("run_admission");
  const executionDataPlaneMode = executionDataPlaneModeForHost(host);
  const request = input;
  const context = await prepareCompanyFlowContext(tx, userId, request);
  const [runtime] = await tx
    .select()
    .from(platformRuntimeSettings)
    .where(eq(platformRuntimeSettings.id, "singleton"))
    .for("share");
  const runners = await tx.select().from(platformAcpRunners).for("share");
  const catalog = runners.map(runnerCatalogEntry);
  const overrideRunnerId =
    context.binding.snapshot.runnerId ?? context.effective.parsed.runner;
  const inspection = inspectFlowRunners({
    manifest: context.coordinator.snapshot.manifest,
    bindings: [],
    launchOverrideRunnerId: overrideRunnerId,
    projectFlow: {},
    platformFlow: { defaultRunnerId: context.flowDefaultRunnerId },
    project: {},
    platform: { defaultRunnerId: runtime?.defaultRunnerId ?? null },
    runners: catalog,
  });
  const sessions = inspection.sessions.map((session): RunSessionResolution => {
    if (session.status === "unresolved") throw session.error;

    const resolution = session.resolution;

    if (resolution.runnerResolutionTier !== "launchOverride") return resolution;

    return {
      ...resolution,
      runnerResolutionTier: context.binding.snapshot.runnerId
        ? "binding"
        : "agentDefault",
      resolutionSource: context.binding.snapshot.runnerId
        ? "company-specialist-binding"
        : "specialist-definition",
    };
  });
  const primary = sessions.find(
    (session) => session.sessionName === inspection.primarySessionName,
  );

  if (!primary)
    throw new MaisterError(
      "CONFIG",
      "Company Flow requires a resolved primary session",
    );
  for (const session of sessions) {
    // Validate the exact selected runner through the shared company read-only
    // gate. This does not replace the Flow resolver's original provenance.
    resolveCompanyAgentRunner({
      bindingRunnerId: session.runnerId,
      agent: { runnerId: null, mode: "session", workspace: "none" },
      platform: { defaultRunnerId: null },
      runners: catalog,
    });
    await assertReadOnlySessionEvidence({
      hosts,
      adapterId: session.runnerSnapshot.adapter,
      runnerId: session.runnerId,
      workspace: "none",
    });
  }
  const triggerReservation = invocation
    ? await assertCompanyTriggerReservation(
        tx,
        userId,
        context,
        invocation,
        context.coordinator,
      )
    : null;
  const runId = triggerReservation?.runId ?? randomUUID();
  const definition = context.effective.parsed;

  await tx.insert(runs).values({
    id: runId,
    agentScheduleId: triggerReservation?.scheduleId ?? null,
    runKind: "flow",
    companyId: context.owner.companyId,
    companyExecutionSnapshot: captureCompanyFlowExecution(context),
    agentId: definition.id,
    sourceAgentId: definition.id,
    agentWorkspace: "none",
    flowRevisionId: context.coordinator.snapshot.flowRevisionId,
    flowVersion: context.flowVersion,
    flowRevision: context.coordinator.snapshot.packageRevision,
    status: "Pending",
    createdByUserId: userId,
    triggerSource: request.triggerSource,
    agentConfig: context.binding.snapshot.effectiveConfiguration,
    executionPolicy: context.binding.snapshot.executionPolicy,
    scheduledRequestSnapshot: context.input.snapshot.scheduledRequest,
    resultContract: context.resultContract,
    launchedAt: sql`CURRENT_TIMESTAMP`,
    activitySortAt: sql`CURRENT_TIMESTAMP`,
    activityTimestampProvenance: "launch",
    agentActivitySnapshot: withAgentComparisonScopes(
      buildAgentActivitySnapshot(definition.id, context.effective),
      {
        configuration: context.binding.snapshot.effectiveConfiguration,
        trigger: { source: request.triggerSource },
        taskId: null,
        runner: primary.runnerSnapshot,
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
  await tx.insert(runSessions).values(
    sessions.map((session) => ({
      id: randomUUID(),
      runId,
      sessionName: session.sessionName,
      runnerId: session.runnerId,
      runnerResolutionTier: session.runnerResolutionTier,
      capabilityAgent: capabilityAgentSchema.parse(session.capabilityAgent),
      runnerSnapshot: session.runnerSnapshot,
      acpSessionId: null,
      resolutionSource: session.resolutionSource,
      resolutionWarning: session.resolutionWarning ?? null,
    })),
  );
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
        role: "coordinator",
      },
    );

  log.debug(
    {
      runId,
      companyId: context.owner.companyId,
      flowRevisionId: context.coordinator.snapshot.flowRevisionId,
      sessionCount: sessions.length,
      primarySessionName: inspection.primarySessionName,
    },
    "company Flow session snapshots reserved",
  );

  return {
    runId,
    assignmentId: context.assignment.id,
    assignmentRevision,
    status: "Pending" as const,
  };
}
