import "server-only";

import type { CompanyTriggerReservation } from "./company-trigger-reservation";
import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHost } from "@/lib/db/schema";
import type { CompanyRunReservation } from "./company-execution-types";
import type { ExecutionHosts } from "@/lib/execution-host";
import type { CompanySpecialistExecutionIdentityInput } from "./company-agent-context";
import type { AssignmentInputRevision } from "@/lib/specialist-assignments/types";
import type { DelegatedWorkRequest } from "@/lib/specialist-assignments/delegated-intake";
import type { KnowledgeAccessRestriction } from "@/lib/company/types";
import type {
  CompanyFlowContextInput,
  ReviewedCompanyFlowSource,
} from "./company-flow-context";
import type { RunSessionResolution } from "@/lib/acp-runners/resolve";

import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import pino from "pino";

import {
  assertCompanyTriggerAppointment,
  assertCompanyTriggerReservation,
  companyReplacementTriggerSource,
} from "./company-trigger-reservation";
import {
  captureCompanyFlowExecution,
  companyFlowContextInputSchema,
  prepareCompanyFlowContext,
  prepareCompanyFlowReplacementContext,
  loadReviewedCompanyCoordinator,
  resolveReviewedCompanyFlowSource,
} from "./company-flow-context";
import { prepareCompanyDelegatedReservation } from "./company-delegated-reservation";
import {
  buildAgentActivitySnapshot,
  withAgentComparisonScopes,
} from "./activity-snapshot";
import { runnerCatalogEntry } from "./runner-catalog";
import { assertReadOnlySessionEvidence } from "./runner-readonly-evidence";
import { retryRefusal } from "./retry-guards";

import { inspectFlowRunners } from "@/lib/acp-runners/flow-preflight";
import { resolveCompanyAgentRunner } from "@/lib/acp-runners/resolve";
import { capabilityAgentSchema } from "@/lib/config.schema";
import { canonicalKnowledgeRestrictions } from "@/lib/brain/knowledge-disclosure";
import {
  platformAcpRunners,
  platformRuntimeSettings,
  runs,
  runSessions,
} from "@/lib/db/schema";
import { queryErrorDiagnostics, redactQueryError } from "@/lib/db/pg-error";
import { MaisterError } from "@/lib/errors";
import { createExecutionHosts, mintPlacement } from "@/lib/execution-host";
import { transportForExecutionHost } from "@/lib/execution-host/default-transport";
import { localHost } from "@/lib/execution-host/resolver";
import { executionDataPlaneModeForHost } from "@/lib/execution-host/data-plane-capabilities";
import { assertUpgradeMaintenanceAllows } from "@/lib/maintenance/upgrade-fence";
import {
  activateInitialSpecialistAssignmentRunInTransaction,
  linkSpecialistAssignmentRunInTransaction,
} from "@/lib/specialist-assignments/store";
import { bindDelegatedWorkRunInTransaction } from "@/lib/specialist-assignments/delegated-intake";

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
  const request = input;
  const context = await prepareCompanyFlowContext(tx, userId, request);
  const triggerReservation = invocation
    ? await assertCompanyTriggerReservation(
        tx,
        userId,
        context,
        invocation,
        context.coordinator,
        request.triggerSource,
      )
    : null;
  const runId = triggerReservation?.runId ?? randomUUID();

  await insertCompanyFlowRun(tx, context, hosts, host, {
    runId,
    triggerSource: request.triggerSource,
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
        role: "coordinator",
      },
    );

  return {
    runId,
    assignmentId: context.assignment.id,
    assignmentRevision,
    status: "Pending" as const,
  };
}

/** Reserve one exact company graph replacement under the same reviewed pins and original input. */
export async function reserveCompanyFlowReplacement(
  tx: Db,
  userId: string,
  request: CompanyFlowContextInput,
  reservation: Readonly<{
    runId: string;
    sourceRunId: string;
    sessionsSha256: string;
  }>,
  hosts: ExecutionHosts,
  host: ExecutionHost,
): Promise<void> {
  assertUpgradeMaintenanceAllows("run_admission");
  const context = await prepareCompanyFlowReplacementContext(
    tx,
    userId,
    request,
  );
  const originalTrigger = await companyReplacementTriggerSource(
    tx,
    reservation.sourceRunId,
    userId,
    request.triggerSource,
  );
  const triggerReservation = originalTrigger
    ? { runId: reservation.runId, ...originalTrigger }
    : null;

  await insertCompanyFlowRun(tx, context, hosts, host, {
    runId: reservation.runId,
    triggerSource: request.triggerSource,
    triggerReservation,
    scheduledRequest: context.input.snapshot.scheduledRequest,
    retryOfRunId: reservation.sourceRunId,
  });
  const [sessions] = (
    await tx.execute(
      sql`SELECT company_flow_retry_sessions_digest(${reservation.runId}) AS sha`,
    )
  ).rows;

  if (sessions?.sha !== reservation.sessionsSha256)
    throw retryRefusal("retry_runner_unavailable");
  await linkSpecialistAssignmentRunInTransaction(
    tx,
    userId,
    request.assignmentId,
    {
      runId: reservation.runId,
      inputRevision: request.inputRevision,
      expectedRevision: request.assignmentRevision,
      role: "coordinator",
      work: null,
    },
  );
}

/** Reserve a child graph through the same session and placement writer as a company coordinator. */
export async function reserveCompanyDelegatedFlowRun(
  db: Db,
  request: DelegatedWorkRequest,
  hosts: ExecutionHosts = createExecutionHosts({ db }),
): Promise<{ childRunId: string; status: string }> {
  assertUpgradeMaintenanceAllows("run_admission");
  const host = await localHost({ db, transport: hosts.transport });

  return db
    .transaction(async (tx) => {
      const prepared = await prepareCompanyDelegatedReservation(tx, request);

      if (prepared.target.kind !== "company_flow")
        throw new MaisterError("CONFIG", "Select a reviewed company Flow");
      if (prepared.kind === "bound") return prepared.receipt;
      const { context, target, work } = prepared;
      const coordinator = await loadReviewedCompanyCoordinator(tx, {
        companyId: target.companyId,
        bindingId: target.specialistBinding.id,
        bindingRevision: target.specialistBinding.revision,
        coordinatorBindingId: target.coordinatorBinding.id,
        coordinatorBindingRevision: target.coordinatorBinding.revision,
      });
      const flow = await resolveReviewedCompanyFlowSource(
        tx,
        context,
        coordinator,
      );
      const { resultContract } = flow;
      const expected = work.definition.objectiveInput.expectedResult;

      if (
        coordinator.snapshotDigest !==
          target.coordinatorBinding.snapshotSha256 ||
        coordinator.snapshot.flowRevisionId !== target.flow.flowRevisionId ||
        coordinator.snapshot.flowRefId !== target.flow.flowRefId ||
        coordinator.snapshot.packageRevision !== target.flow.resolvedRevision ||
        coordinator.snapshot.manifestSha256 !== target.flow.manifestSha256 ||
        resultContract.schemaRef !== expected.schemaRef ||
        resultContract.schemaVersion !== expected.schemaVersion ||
        resultContract.sha256 !== expected.sha256 ||
        !expected.required
      )
        throw new MaisterError(
          "CONFLICT",
          "The company Flow differs from the retained required export",
          {
            details: { reason: "delegated_work_binding_changed" },
          },
        );
      const runId = work.reservedRunId;

      await insertCompanyFlowRun(tx, { ...context, ...flow }, hosts, host, {
        runId,
        triggerSource: "manual",
        scheduledRequest: null,
        parentRunId: work.definition.parent.runId,
        rootRunId: work.definition.parent.rootRunId,
        inheritedSources: work.sourceRestrictions,
      });
      await bindDelegatedWorkRunInTransaction(tx, work);

      return { childRunId: runId, status: "Pending" };
    })
    .catch((error: unknown) => {
      log.warn(
        {
          assignmentId: request.selector.assignmentId,
          ...queryErrorDiagnostics(error),
        },
        "delegated company Flow reservation refused",
      );
      throw redactQueryError(error);
    });
}

async function insertCompanyFlowRun(
  tx: Db,
  context: CompanySpecialistExecutionIdentityInput & ReviewedCompanyFlowSource,
  hosts: ExecutionHosts,
  host: ExecutionHost,
  execution: Readonly<{
    runId: string;
    triggerSource: CompanyFlowContextInput["triggerSource"];
    triggerReservation?: Awaited<
      ReturnType<typeof assertCompanyTriggerReservation>
    > | null;
    scheduledRequest: AssignmentInputRevision["snapshot"]["scheduledRequest"];
    parentRunId?: string;
    rootRunId?: string;
    retryOfRunId?: string;
    inheritedSources?: readonly KnowledgeAccessRestriction[];
  }>,
): Promise<void> {
  const { runId } = execution;
  const executionDataPlaneMode = executionDataPlaneModeForHost(host);
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
      checkDiagnostics: () =>
        transportForExecutionHost(host, hosts.transport).diagnostics(),
      adapterId: session.runnerSnapshot.adapter,
      runnerId: session.runnerId,
      workspace: "none",
    });
  }
  const definition = context.effective.parsed;

  await tx.insert(runs).values({
    id: runId,
    agentScheduleId: execution.triggerReservation?.scheduleId ?? null,
    triggerEventId: execution.triggerReservation?.triggerEventId ?? null,
    agentChainDepth: execution.triggerReservation?.agentChainDepth ?? 0,
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
    createdByUserId: context.authority.actor.id,
    parentRunId: execution.parentRunId,
    rootRunId: execution.rootRunId,
    retryOfRunId: execution.retryOfRunId,
    triggerSource: execution.triggerSource,
    agentConfig: context.binding.snapshot.effectiveConfiguration,
    executionPolicy: context.binding.snapshot.executionPolicy,
    scheduledRequestSnapshot: execution.scheduledRequest,
    resultContract: context.resultContract,
    launchedAt: sql`CURRENT_TIMESTAMP`,
    activitySortAt: sql`CURRENT_TIMESTAMP`,
    activityTimestampProvenance: "launch",
    agentActivitySnapshot: withAgentComparisonScopes(
      buildAgentActivitySnapshot(definition.id, context.effective),
      {
        configuration: context.binding.snapshot.effectiveConfiguration,
        trigger: { source: execution.triggerSource },
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
      restrictions: canonicalKnowledgeRestrictions([
        {
          kind: "assignment_input",
          assignmentId: context.assignment.id,
          inputRevision: context.input.revision,
          inputSha256: context.input.digest,
        },
        ...(execution.inheritedSources ?? []),
      ]),
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
}
