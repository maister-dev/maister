import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { Run, RunSession, RunnerSnapshot } from "@/lib/db/schema";
import type { CompanyFlowExecutionSnapshot } from "./company-execution-types";
import type { CompanyRunCredentialOwner } from "./company-run-credential-owner";
import type { AssignmentInputRevision } from "@/lib/specialist-assignments/types";
import type { EffectiveAgentDefinition } from "./effective";
import type { FlowYamlV1 } from "@/lib/config.schema";
import type { RunResultContract } from "@/lib/run-results/types";

import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import pino from "pino";

import { requireCompanyKnowledgeRunOwner } from "./company-run-credential-owner";
import { assertCompanyRunReadAccessInTransaction } from "./company-run-read-access";
import { assertCompanySessionDefinition } from "./company-agent-definition";
import { decodeCompanyFlowBindingRevision } from "./company-flow-binding-snapshot";
import { captureCompanyFlowBinding } from "./company-flow-binding-capture";
import { resolveInstalledAgentDefinition } from "./effective";
import { agentDefinitionSha256 } from "./activity-snapshot";
import { bindingConfigurationSchema } from "./company-binding-types";
import { resolveAgentConfig } from "./config";
import { runnerCatalogEntry } from "./runner-catalog";
import { authorizeCompanyCronReplacementSource } from "./company-trigger-reservation";

import { resolveCompanyAgentRunner } from "@/lib/acp-runners/resolve";
import { authorizeCompanyUserAction } from "@/lib/company/authority";
import { validateGraphManifest } from "@/lib/config";
import {
  runs,
  runSessions,
  platformAcpRunners,
  flowRevisions,
} from "@/lib/db/schema";
import { contentDigest } from "@/lib/evaluations/digest";
import { queryErrorDiagnostics, redactQueryError } from "@/lib/db/pg-error";
import { compileManifest } from "@/lib/flows/graph/compile";
import { resolveFlowExportContract } from "@/lib/run-results/flow-export";
import {
  executionPolicySchema,
  expandExecutionPolicy,
} from "@/lib/runs/execution-policy";
import { decodeAssignmentInput } from "@/lib/specialist-assignments/input-snapshot";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "agents:company-flow-session-context",
  level: process.env.LOG_LEVEL ?? "info",
});

export type CompanyFlowRunSession = RunSession & {
  runnerId: string;
  runnerSnapshot: RunnerSnapshot;
};
export type CompanyFlowSessionContext = Readonly<{
  run: Run & {
    runKind: "flow";
    companyId: string;
    projectId: null;
    taskId: null;
    flowId: null;
  };
  owner: CompanyRunCredentialOwner & { snapshot: CompanyFlowExecutionSnapshot };
  input: AssignmentInputRevision;
  effective: EffectiveAgentDefinition;
  configuration: Readonly<Record<string, string | number | boolean>>;
  manifest: FlowYamlV1;
  flowRefId: string;
  flowInstallPath: string;
  resultContract: Extract<RunResultContract, { kind: "flow_export" }>;
  sessions: readonly CompanyFlowRunSession[];
  primarySessionName: string;
}>;

/** Restore a pinned company graph without re-admitting work or manufacturing repository records. */
export async function loadCompanyFlowSessionContext(
  tx: Pick<Db, "select" | "execute">,
  runId: string,
): Promise<CompanyFlowSessionContext> {
  try {
    const [run] = await tx
      .select()
      .from(runs)
      .where(eq(runs.id, runId))
      .for("update");

    if (
      !run ||
      run.runKind !== "flow" ||
      run.companyId === null ||
      run.projectId !== null ||
      run.taskId !== null ||
      run.flowId !== null ||
      run.agentWorkspace !== "none"
    )
      throw new MaisterError(
        "PRECONDITION",
        "Select an exact company result-only graph execution",
      );
    const owner = await requireCompanyKnowledgeRunOwner(tx, runId);

    if (owner.snapshot.schemaVersion !== 2)
      throw new MaisterError(
        "PRECONDITION",
        "Company graph execution requires its v2 coordinator capture",
      );
    await authorizeCompanyUserAction(
      tx,
      owner.userId,
      owner.companyId,
      "assignments:update",
    );
    if (run.retryOfRunId)
      await authorizeCompanyUserAction(
        tx,
        owner.userId,
        owner.companyId,
        "assignments:recover",
      );
    if (run.retryOfRunId && run.triggerSource === "cron")
      await authorizeCompanyCronReplacementSource(
        tx,
        run.retryOfRunId,
        owner.userId,
      );
    await assertCompanyRunReadAccessInTransaction(tx, owner.userId, runId);
    const graphRun: CompanyFlowSessionContext["run"] = {
      ...run,
      runKind: "flow",
      companyId: run.companyId,
      projectId: null,
      taskId: null,
      flowId: null,
    };
    const graphOwner: CompanyFlowSessionContext["owner"] = {
      ...owner,
      snapshot: owner.snapshot,
    };
    const retained = await loadRetainedCompanyGraphInput(
      tx,
      graphRun,
      graphOwner,
    );
    const { sessionNames, ...contract } = await loadPinnedCompanyGraphContract(
      tx,
      graphRun,
      graphOwner,
      retained,
    );
    const sessionContext = await loadFrozenCompanyGraphSessions(
      tx,
      runId,
      sessionNames,
    );

    log.debug(
      {
        runId,
        companyId: owner.companyId,
        assignmentId: retained.input.assignmentId,
        inputRevision: retained.input.revision,
        flowRevisionId: run.flowRevisionId,
        sessionCount: sessionContext.sessions.length,
        primarySessionName: sessionContext.primarySessionName,
      },
      "current company graph execution context loaded",
    );

    return {
      run: graphRun,
      owner: graphOwner,
      ...retained,
      ...contract,
      ...sessionContext,
    };
  } catch (error) {
    log.warn(
      {
        runId,
        code: error instanceof MaisterError ? error.code : undefined,
        ...queryErrorDiagnostics(error),
      },
      "company graph execution context refused",
    );
    throw redactQueryError(error);
  }
}

type CompanyFlowQuery = Pick<Db, "select" | "execute">;
type RetainedCompanyGraphInput = Pick<
  CompanyFlowSessionContext,
  "input" | "effective" | "configuration"
>;
type PinnedCompanyGraphContract = Pick<
  CompanyFlowSessionContext,
  "manifest" | "flowRefId" | "flowInstallPath" | "resultContract"
> & { sessionNames: readonly string[] };

async function loadRetainedCompanyGraphInput(
  tx: CompanyFlowQuery,
  run: CompanyFlowSessionContext["run"],
  owner: CompanyFlowSessionContext["owner"],
): Promise<RetainedCompanyGraphInput> {
  const inputRow = (
    await tx.execute(
      sql`SELECT * FROM specialist_input_revisions WHERE assignment_id=${owner.snapshot.assignment.id} AND revision=${owner.snapshot.assignment.inputRevision} FOR SHARE`,
    )
  ).rows[0];

  if (!inputRow)
    throw new MaisterError(
      "PRECONDITION",
      "The exact retained company graph input is unavailable",
    );
  const input = decodeAssignmentInput(inputRow);
  const standing =
    owner.delegated?.binding ?? input.snapshot.standingDefinition;
  const effective = await resolveInstalledAgentDefinition(tx, {
    agentId: standing.agentId,
    packageInstallId: standing.packageInstallId,
  });
  const activity = run.agentActivitySnapshot;

  if (
    input.digest !== owner.snapshot.assignment.inputSha256 ||
    standing.agentId !== run.sourceAgentId ||
    effective.resolvedRevision !== standing.packageRevision ||
    agentDefinitionSha256(effective.parsed) !== standing.definitionSha256 ||
    activity?.version !== 1 ||
    activity.agentId !== standing.agentId ||
    activity.packageInstallId !== standing.packageInstallId ||
    activity.packageName !== standing.packageName ||
    activity.packageRevision !== standing.packageRevision ||
    activity.definitionSha256 !== standing.definitionSha256
  )
    throw new MaisterError(
      "CONFIG",
      "Company graph input, installed professional and launch witnesses differ",
    );
  assertCompanySessionDefinition(effective.parsed);
  if (effective.parsed.kind === "operational")
    throw new MaisterError(
      "CONFIG",
      "Operational roles cannot replace company graph coordinators",
    );
  const configuration = bindingConfigurationSchema.safeParse(
    resolveAgentConfig(standing.definition.config, standing.configuration),
  );
  const policy = executionPolicySchema.safeParse(run.executionPolicy);

  if (
    !policy.success ||
    !configuration.success ||
    contentDigest(configuration.data) !== contentDigest(run.agentConfig) ||
    contentDigest(expandExecutionPolicy(policy.data)) !==
      contentDigest(
        expandExecutionPolicy(input.snapshot.authoritySnapshot.executionPolicy),
      ) ||
    contentDigest(owner.delegated ? null : input.snapshot.scheduledRequest) !==
      contentDigest(run.scheduledRequestSnapshot)
  )
    throw new MaisterError(
      "CONFIG",
      "Company graph configuration, scheduled request or execution policy differs from its frozen input",
    );

  return { input, effective, configuration: configuration.data };
}

async function loadPinnedCompanyGraphContract(
  tx: CompanyFlowQuery,
  run: CompanyFlowSessionContext["run"],
  owner: CompanyFlowSessionContext["owner"],
  retained: RetainedCompanyGraphInput,
): Promise<PinnedCompanyGraphContract> {
  const { input, effective } = retained;
  const coordinatorRow = (
    await tx.execute(
      sql`SELECT * FROM company_flow_binding_revisions WHERE binding_id=${owner.snapshot.coordinatorFlowBinding.id} AND revision=${owner.snapshot.coordinatorFlowBinding.revision} FOR SHARE`,
    )
  ).rows[0];

  if (!coordinatorRow)
    throw new MaisterError(
      "PRECONDITION",
      "The exact retained coordinator configuration is unavailable",
    );
  const coordinator = decodeCompanyFlowBindingRevision(coordinatorRow);
  const reviewed = coordinator.snapshot;

  if (
    coordinator.snapshotDigest !==
      owner.snapshot.coordinatorFlowBinding.snapshotSha256 ||
    reviewed.flowRevisionId !== run.flowRevisionId ||
    reviewed.flowRefId !== effective.parsed.flow
  )
    throw new MaisterError(
      "CONFIG",
      "Company graph source and retained coordinator witnesses differ",
    );
  const current = await captureCompanyFlowBinding(tx, {
    owner: owner.snapshot.owner,
    specialistBindingId: owner.snapshot.specialistBinding.id,
    specialistRevision: owner.snapshot.specialistBinding.revision,
    flowRevisionId: reviewed.flowRevisionId,
    manifestSha256: reviewed.manifestSha256,
    execution: reviewed.execution,
    enabled: true,
    roleMappings: reviewed.roleMappings,
    idempotencyKey: "internal:company-graph-context",
  });
  const manifest = current.manifest;

  validateGraphManifest(manifest, manifest.nodes, "company graph execution");
  const compiled = compileManifest(manifest);
  const [revision] = await tx
    .select()
    .from(flowRevisions)
    .where(eq(flowRevisions.id, reviewed.flowRevisionId))
    .for("share");

  if (
    !revision ||
    revision.resolvedRevision !== run.flowRevision ||
    revision.versionLabel !== run.flowVersion ||
    revision.packageStatus !== "Installed" ||
    revision.execTrust !== "trusted"
  )
    throw new MaisterError(
      "PRECONDITION",
      "The pinned company graph revision is unavailable or changed",
    );
  const resultContract = await resolveFlowExportContract({
    flowRefId: reviewed.flowRefId,
    manifest,
    revision: {
      id: revision.id,
      installedPath: revision.installedPath,
      resolvedRevision: revision.resolvedRevision,
    },
  });

  if (
    resultContract?.kind !== "flow_export" ||
    !resultContract.required ||
    contentDigest(resultContract) !== contentDigest(run.resultContract) ||
    contentDigest(
      (
        owner.delegated?.definition.objectiveInput ??
        input.snapshot.objectiveInput
      ).expectedResult,
    ) !==
      contentDigest({
        schemaRef: resultContract.schemaRef,
        schemaVersion: resultContract.schemaVersion,
        sha256: resultContract.sha256,
        required: true,
      })
  )
    throw new MaisterError(
      "CONFIG",
      "The pinned company graph export differs from its required frozen result contract",
    );
  const expectedSessionNames = [...compiled.sessions.keys()];
  const sessionNames =
    expectedSessionNames.length > 0 ? expectedSessionNames : ["default"];

  return {
    manifest,
    flowRefId: reviewed.flowRefId,
    flowInstallPath: revision.installedPath,
    resultContract,
    sessionNames,
  };
}

async function loadFrozenCompanyGraphSessions(
  tx: CompanyFlowQuery,
  runId: string,
  sessionNames: readonly string[],
): Promise<Pick<CompanyFlowSessionContext, "sessions" | "primarySessionName">> {
  const retainedSessions = await tx
    .select()
    .from(runSessions)
    .where(eq(runSessions.runId, runId))
    .for("share");

  if (
    retainedSessions.length !== sessionNames.length ||
    sessionNames.some(
      (name) =>
        !retainedSessions.some((session) => session.sessionName === name),
    )
  )
    throw new MaisterError(
      "CONFIG",
      "The company graph's frozen session set does not match its compiled declaration",
    );
  const catalog = (await tx.select().from(platformAcpRunners).for("share")).map(
    runnerCatalogEntry,
  );
  const sessions = retainedSessions.map((session): CompanyFlowRunSession => {
    const { runnerId, runnerSnapshot } = session;

    if (
      runnerId === null ||
      runnerSnapshot === null ||
      runnerSnapshot.id !== runnerId
    )
      throw new MaisterError(
        "CONFIG",
        "A company graph session has no exact immutable runner witness",
      );
    const currentRunner = resolveCompanyAgentRunner({
      bindingRunnerId: runnerId,
      agent: { runnerId: null, mode: "session", workspace: "none" },
      platform: { defaultRunnerId: null },
      runners: catalog,
    });

    if (
      currentRunner.runnerSnapshot.adapter !== runnerSnapshot.adapter ||
      currentRunner.runnerSnapshot.capabilityAgent !==
        runnerSnapshot.capabilityAgent ||
      runnerSnapshot.permissionPolicy === "dangerously_skip_permissions"
    )
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        "The frozen company graph runner is no longer compatible with current read-only execution",
      );

    return { ...session, runnerId, runnerSnapshot };
  });
  const primarySessionName = sessionNames.includes("default")
    ? "default"
    : sessionNames[0];

  return { sessions, primarySessionName };
}
