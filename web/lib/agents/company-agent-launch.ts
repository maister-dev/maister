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
  companyReplacementTriggerSource,
} from "./company-trigger-reservation";
import {
  prepareCompanyAgentContext,
  prepareCompanyAgentReplacementContext,
  captureCompanyAgentExecution,
} from "./company-agent-context";
import {
  buildAgentActivitySnapshot,
  withAgentComparisonScopes,
} from "./activity-snapshot";
import { runnerCatalogEntry } from "./runner-catalog";
import { assertReadOnlySessionEvidence } from "./runner-readonly-evidence";
import { buildOperationalContract } from "./launch-contract";
import { prepareCompanyDelegatedReservation } from "./company-delegated-reservation";
import { assertStandaloneCompanyAgentDefinition } from "./company-agent-definition";
import { retainInstallationRunAuthority } from "./installation-authority";
import {
  assertInstallationAppointment,
  type SpecialistIntakePrincipal,
} from "./installation-appointment";
import {
  captureInstallationProjects,
  installationRunProjects,
} from "./installation-source-capture";
import { retryDigest, retryRefusal } from "./retry-guards";

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
import { bindDelegatedWorkRunInTransaction } from "@/lib/specialist-assignments/delegated-intake";
import {
  activateInitialSpecialistAssignmentRunInTransaction,
  linkSpecialistAssignmentRunInTransaction,
} from "@/lib/specialist-assignments/store";

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
  principal: SpecialistIntakePrincipal,
  input: CompanyAgentContextInput,
  hosts: ExecutionHosts,
  host: ExecutionHost,
  invocation?: CompanyTriggerReservation,
): Promise<CompanyRunReservation> {
  assertCompanyTriggerAppointment(input.triggerSource, invocation);
  assertUpgradeMaintenanceAllows("run_admission");
  const context = await prepareCompanyAgentContext(tx, principal, input);
  if (
    context.binding.snapshot.installationGrant &&
    invocation &&
    typeof principal === "string"
  )
    throw new MaisterError(
      "PRECONDITION",
      "Installation admission requires a reviewed trigger appointment",
    );
  const triggerReservation = invocation
    ? await assertCompanyTriggerReservation(
        tx,
        typeof principal === "string"
          ? principal
          : principal.review.reviewer.actor.id,
        context,
        invocation,
        null,
        input.triggerSource,
      )
    : null;
  const runId = triggerReservation?.runId ?? randomUUID();
  if (typeof principal !== "string")
    assertInstallationAppointment(tx, principal, {
      companyId: context.owner.companyId,
      bindingId: context.binding.bindingId,
      origin: context.assignment.origin,
      runId,
    });

  await insertCompanyAgentRun(tx, context, hosts, host, {
    runId,
    triggerSource: input.triggerSource,
    triggerReservation,
    scheduledRequest: context.input.snapshot.scheduledRequest,
    ...(typeof principal !== "string" && {
      installationAppointment: principal,
    }),
  });
  const assignmentRevision =
    await activateInitialSpecialistAssignmentRunInTransaction(
      tx,
      principal,
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

/** The caller holds the locked source and has retained its immutable retry receipt. */
export async function reserveCompanyAgentReplacement(
  tx: Db,
  userId: string,
  request: CompanyAgentContextInput,
  reservation: Readonly<{
    runId: string;
    sourceRunId: string;
    runnerSha256: string;
  }>,
  hosts: ExecutionHosts,
  host: ExecutionHost,
): Promise<void> {
  assertUpgradeMaintenanceAllows("run_admission");
  const context = await prepareCompanyAgentReplacementContext(
    tx,
    userId,
    request,
  );
  const { runId } = reservation;
  const originalTrigger = await companyReplacementTriggerSource(
    tx,
    reservation.sourceRunId,
    userId,
    request.triggerSource,
  );
  const triggerReservation = originalTrigger
    ? { runId: runId, ...originalTrigger }
    : null;

  await insertCompanyAgentRun(tx, context, hosts, host, {
    runId,
    triggerSource: request.triggerSource,
    triggerReservation,
    scheduledRequest: context.input.snapshot.scheduledRequest,
    runnerSha256: reservation.runnerSha256,
    retryOfRunId: reservation.sourceRunId,
  });
  await linkSpecialistAssignmentRunInTransaction(
    tx,
    userId,
    request.assignmentId,
    {
      runId,
      inputRevision: request.inputRevision,
      expectedRevision: request.assignmentRevision,
      role: "continuation",
      work: null,
    },
  );
  await assertNativeRunKnowledgeInputsInTransaction(tx, runId);
  for (const reference of context.input.snapshot.objectiveInput.inputRefs)
    await inspectKnowledgeEvidenceReference(
      tx,
      { kind: "execution", runId, nodeAttemptId: null },
      reference,
    );
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
      const prepared = await prepareCompanyDelegatedReservation(tx, request);

      if (prepared.target.kind !== "company_agent")
        throw new MaisterError(
          "CONFIG",
          "Select a reviewed standalone company specialist",
        );
      if (prepared.kind === "bound") return prepared.receipt;
      const { context, work } = prepared;
      const { parent, objectiveInput } = work.definition;

      assertStandaloneCompanyAgentDefinition(context.effective.parsed);
      const result = buildOperationalContract(context.effective);

      if (
        context.binding.snapshot.coordinatorFlowRevisionId !== null ||
        result.schemaRef !== objectiveInput.expectedResult.schemaRef ||
        result.schemaVersion !== objectiveInput.expectedResult.schemaVersion ||
        result.sha256 !== objectiveInput.expectedResult.sha256 ||
        objectiveInput.expectedResult.required !== true
      )
        throw new MaisterError(
          "CONFLICT",
          "The company agent does not match the retained required result",
          {
            details: { reason: "delegated_work_binding_changed" },
          },
        );
      const runId = work.reservedRunId;

      await insertCompanyAgentRun(tx, context, hosts, host, {
        runId,
        triggerSource: "manual",
        scheduledRequest: null,
        parentRunId: parent.runId,
        rootRunId: parent.rootRunId,
      });
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
    runnerSha256?: string;
    retryOfRunId?: string;
    parentRunId?: string;
    rootRunId?: string;
    installationAppointment?: Exclude<SpecialistIntakePrincipal, string>;
  }>,
): Promise<void> {
  const { runId } = execution;
  const executionDataPlaneMode = executionDataPlaneModeForHost(host);
  const definition = context.effective.parsed;
  const installationGrant = context.binding.snapshot.installationGrant;
  const triggerSource = execution.triggerSource;
  if (
    installationGrant &&
    (execution.parentRunId ||
      triggerSource === "webhook" ||
      (triggerSource !== "manual" && !execution.triggerReservation))
  )
    throw new MaisterError(
      "PRECONDITION",
      "The installation binding requires manual or reviewed cron/event admission",
    );
  if (installationGrant && execution.retryOfRunId) {
    const matched =
      await tx.execute(sql`SELECT 1 FROM agent_installation_run_authorities
      WHERE run_id=${execution.retryOfRunId} AND binding_id=${context.binding.bindingId}
        AND binding_revision=${context.binding.revision} AND binding_digest=${context.binding.snapshotDigest} FOR SHARE`);
    if (matched.rows.length !== 1) throw retryRefusal("retry_context_changed");
  }

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

  if (
    execution.runnerSha256 &&
    retryDigest(JSON.parse(JSON.stringify(resolution.runnerSnapshot))) !==
      execution.runnerSha256
  )
    throw retryRefusal("retry_runner_changed");

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
    retryOfRunId: execution.retryOfRunId,
    companyExecutionSnapshot: snapshot,
    agentId: definition.id,
    sourceAgentId: definition.id,
    agentKind: "operational",
    agentWorkspace: "none",
    currentStepId: "agent",
    status: "Pending",
    flowVersion: "agent",
    flowRevision: "manual",
    createdByUserId: execution.installationAppointment
      ? null
      : context.authority.actor.id,
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
        operationalContract: definition.completion?.contract,
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
  if (installationGrant) {
    const principal =
      triggerSource === "cron" || triggerSource === "domain_event"
        ? { kind: "unattended" as const, trigger: triggerSource }
        : { kind: "manual" as const, userId: context.authority.actor.id };
    await retainInstallationRunAuthority(tx, {
      runId,
      bindingId: context.binding.bindingId,
      revision: context.binding.revision,
      snapshotDigest: context.binding.snapshotDigest,
      grant: installationGrant,
      principal,
    });
    const inheritedRunId =
      execution.retryOfRunId ??
      (execution.triggerReservation?.triggerEventId
        ? (
            await tx.execute<{
              run_id: string | null;
            }>(sql`SELECT run_id FROM domain_events
        WHERE id=${execution.triggerReservation.triggerEventId} FOR SHARE`)
          ).rows[0]?.run_id
        : null);
    if (inheritedRunId)
      await captureInstallationProjects(
        tx,
        runId,
        await installationRunProjects(tx, inheritedRunId),
      );
    log.info(
      {
        runId,
        agentId: definition.id,
        revision: context.binding.revision,
        principal: principal.kind,
      },
      "installation agent principal retained",
    );
  }
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
